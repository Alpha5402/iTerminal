import { useSessionDiscovery, type SessionDiscoveryPage } from "./session-navigation.js";
import { useApprovalInbox } from "./approval-inbox.js";
import { Diagnostics } from "./diagnostics.js";
import { api, ConsoleApiError, normalizeClientError, type ApiErrorBody } from "./console-client.js";
import { connectConsoleStream } from "./stream-controller.js";
import { applyScreenDelta, type ScreenDelta } from "./screen-delta.js";
import type { TerminalConsoleFrame } from "@iterminal/domain";
import { TerminalHistory } from "./terminal-history.js";
import type { TerminalScreenCell } from "@iterminal/domain";
import { renderScreen } from "./terminal-renderer.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { Terminal } from "@xterm/xterm";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { ActionLookupResult } from "@iterminal/protocol";

import {
  commandHistoryKey,
  CommandHistoryNavigation,
  mergeCommandHistory,
  readCommandHistory,
  type CommandHistoryEntry,
} from "./command-history.js";
import {
  classifyRawTerminalData,
  rawInputBatchCanSend,
  rawInputTargetLabel,
  sameRawInputTarget,
  type InputMode,
  type RawControl,
  type RawInputTarget,
} from "./input-mode.js";
import { ActiveWindowFit, fittedGeometry } from "./terminal-fit.js";
import { terminalSelectionText } from "./terminal-copy.js";
import { describeInputUncertainty } from "./input-uncertainty.js";
import {
  DISMISSED_TABS_KEY,
  dismissSessionTab,
  readDismissedTabs,
  selectedSessionTab,
  sessionTabKey,
  visibleSessionTabs,
} from "./session-tabs.js";
import {
  idleSubmissionIntent,
  isDefiniteSubmissionRejectionCode,
  isSubmissionIntentPending,
  startSubmissionIntent,
  submissionIntentCanSettleFailure,
  submissionIntentMatchesDraft,
  submissionIntentReducer,
  type SubmissionIntentEvent,
  type SubmissionIntentIdentity,
  type SubmissionIntentState,
} from "./submission-intent.js";

type SessionStatus = "STARTING" | "READY" | "RESERVED" | "RUNNING" | "BROKEN" | "CLOSED";
type InputPolicy = "common" | "human_guarded" | "human_only" | "agent_only";

interface Actor {
  readonly client: string;
  readonly id: string;
  readonly principal: string;
  readonly type: "human" | "agent" | "scheduler" | "system";
}

interface Session {
  readonly createdAt: string;
  readonly liveAvailability?: "available" | "unavailable" | "historical" | "conflict";
  readonly activeExecutionId?: string;
  readonly eventSequence: number;
  readonly generation: number;
  readonly id: string;
  readonly lineage?: {
    readonly checkpointHash: string;
    readonly checkpointVersion: number;
    readonly forkedAt: string;
    readonly parentGeneration: number;
    readonly parentSessionId: string;
  };
  readonly screenVersion: number;
  readonly shell: "bash" | "zsh";
  readonly status: SessionStatus;
  readonly workspaceRoot: string;
}

interface ShellCheckpoint {
  readonly ageMilliseconds: number;
  readonly contentHash: string;
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly observedAt: string;
  readonly sessionId: string;
  readonly shell: "bash" | "zsh";
  readonly sourceGeneration: number;
  readonly sourceStatus: SessionStatus;
  readonly stale: boolean;
  readonly version: number;
  readonly workspaceRoot: string;
}

interface SessionForkResult {
  readonly checkpoint: ShellCheckpoint;
  readonly limitations: readonly string[];
  readonly replayed: boolean;
  readonly session: Session;
}

interface InteractionGuard {
  readonly actor: Actor;
  readonly expiresAt: string;
  readonly id: string;
  readonly maxRenewals: number;
  readonly reason: string;
  readonly renewals: number;
}

interface InteractionState {
  readonly guard?: InteractionGuard;
  readonly policy: InputPolicy;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly version: number;
  readonly inputContext?: {
    readonly targetExecutionId: string;
    readonly version: number;
    readonly state: "clear" | "pending" | "unknown";
    readonly unknownReason?: "untracked_input" | "delivery";
  };
}

interface Approval {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actionIdempotencyKey: string;
  readonly command: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly requester: Actor;
  readonly status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CONSUMED";
  readonly version: number;
}

interface SensitiveInput {
  readonly actor: Actor;
  readonly id: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "UNKNOWN";
  readonly targetExecutionId: string;
  readonly version: number;
  readonly finishedAt?: string;
}

interface ScreenSnapshot {
  readonly cells?: readonly TerminalScreenCell[];
  readonly columns: number;
  readonly cursor: { readonly column: number; readonly row: number };
  readonly geometryVersion: number;
  readonly lines: readonly string[];
  readonly wrappedRows?: readonly boolean[];
  readonly rows: number;
  readonly screenVersion: number;
}

interface SessionEvent {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor?: Actor;
  readonly id: string;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
  readonly type: string;
}

interface Bootstrap {
  readonly actor: Actor;
  readonly canonicalGeometry: { readonly columns: number; readonly rows: number };
  readonly geometryBounds: {
    readonly maxColumns: number;
    readonly maxRows: number;
    readonly minColumns: number;
    readonly minRows: number;
  };
  readonly mcpConnection?: {
    readonly configJson: string;
    readonly serverName: string;
  };
  readonly runtimeCompatibility:
    | {
        readonly capabilities: {
          readonly buildId: string;
          readonly features: readonly string[];
          readonly protocolVersion: string;
        };
        readonly status: "compatible" | "incompatible";
      }
    | { readonly status: "legacy" };
  readonly sessions: readonly Session[];
}

interface StreamFrame {
  readonly screenDelta?: ScreenDelta;
  readonly partial?: boolean;
  readonly persistenceLagMilliseconds?: number;
  readonly actor?: Actor;
  readonly cursor?: number;
  readonly error?: ApiErrorBody;
  readonly eventGap?: Readonly<Record<string, unknown>>;
  readonly events?: readonly SessionEvent[];
  readonly interaction?: InteractionState;
  readonly liveGap?: Readonly<Record<string, unknown>>;
  readonly screen?: ScreenSnapshot;
  readonly session?: Session;
  readonly truncated?: boolean;
  readonly type: "sync" | "update" | "error" | "resync_required";
}

const SCREEN_COLUMNS = 120;
const SCREEN_ROWS = 40;
const MAX_TIMELINE_EVENTS = 500;
const INPUT_BATCH_MS = 20;
const GUARD_IDLE_RELEASE_MS = 400;
const DEFAULT_SESSION_SHELL = "zsh" as const;

interface ResumeState {
  readonly cursor: number;
  readonly events: readonly SessionEvent[];
  readonly screenVersion: number;
}

interface CursorComposerLayout {
  readonly height: number;
  readonly left: number;
  readonly lineLeft: number;
  readonly lineWidth: number;
  readonly top: number;
  readonly width: number;
}

interface LocalDraft {
  readonly revision: number;
  readonly value: string;
}

interface RawInputBatch {
  readonly data: string;
  readonly target: RawInputTarget;
}

type InspectorView = "advanced" | "approvals" | "mcp" | "session";

const INSPECTOR_TITLES: Record<InspectorView, string> = {
  advanced: "Advanced",
  approvals: "Agent approvals",
  mcp: "Connect MCP",
  session: "Session recovery",
};

function App(): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const [persistencePartial, setPersistencePartial] = useState(false);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [dismissedTabs, setDismissedTabs] = useState<readonly string[]>(() => {
    try {
      return readDismissedTabs(window.localStorage);
    } catch {
      return [];
    }
  });
  const dismissedTabsRef = useRef(dismissedTabs);
  const visibleSessions = useMemo(
    () => visibleSessionTabs(sessions, dismissedTabs),
    [sessions, dismissedTabs],
  );
  const visibleSessionsRef = useRef(visibleSessions);
  visibleSessionsRef.current = visibleSessions;
  const closingTabs = useRef(new Set<string>());
  const [pendingTabCloses, setPendingTabCloses] = useState<readonly string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [interaction, setInteraction] = useState<InteractionState>();
  const [checkpoint, setCheckpoint] = useState<ShellCheckpoint>();
  const [staleAcknowledged, setStaleAcknowledged] = useState(false);
  const [screen, setScreen] = useState<ScreenSnapshot>();
  const [timeline, setTimeline] = useState<readonly SessionEvent[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [approvalReason, setApprovalReason] = useState("Reviewed in Human Console");
  const [sensitiveInput, setSensitiveInput] = useState<SensitiveInput>();
  const [secret, setSecret] = useState("");
  const [secretSubmitting, setSecretSubmitting] = useState(false);
  const [sensitiveFinishing, setSensitiveFinishing] = useState(false);
  const [dismissedSecretPromptKey, setDismissedSecretPromptKey] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const latestCursor = useRef(0);
  const [streamState, setStreamState] = useState<"offline" | "connecting" | "live" | "gap">(
    "offline",
  );
  const [error, setError] = useState<ApiErrorBody>();
  const [commandDraft, setCommandDraft] = useState<LocalDraft>({ revision: 0, value: "" });
  const [foregroundDrafts, setForegroundDrafts] = useState<Record<string, LocalDraft>>({});
  const [rawInput, setRawInput] = useState(false);
  const [inputModeNotice, setInputModeNotice] = useState<string>();
  const [controlOutcome, setControlOutcome] = useState<{
    readonly executionId: string;
    readonly generation: number;
    readonly id: string;
    readonly sessionId: string;
    readonly status: string;
  }>();
  const [localInputUncertainty, setLocalInputUncertainty] = useState<
    | {
        readonly executionId: string;
        readonly generation: number;
        readonly reason: "untracked_input" | "delivery";
        readonly sessionId: string;
      }
    | undefined
  >();
  const rawInputState = useRef(false);
  const rawInputTarget = useRef<RawInputTarget | undefined>(undefined);
  const pendingRawResetTarget = useRef<RawInputTarget | undefined>(undefined);
  const sensitiveInputActiveState = useRef(false);
  const foregroundPreparing = useRef(new Set<string>());
  const [submissionIntent, dispatchSubmissionIntent] = useReducer(
    submissionIntentReducer,
    idleSubmissionIntent,
  );
  const submissionIntentRef = useRef<SubmissionIntentState>(idleSubmissionIntent);
  const commandHistories = useRef(new Map<string, readonly CommandHistoryEntry[]>());
  const commandHistoryNavigation = useRef(new CommandHistoryNavigation());
  const historyCaretRestore = useRef(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionFormOpen, setNewSessionFormOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [newSessionWorkspace, setNewSessionWorkspace] = useState("");
  const [sessionLabels, setSessionLabels] = useState<Record<string, string>>({});
  const [mcpConfigCopied, setMcpConfigCopied] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("approvals");
  const [interactive, setInteractive] = useState(false);
  const [resizeColumns, setResizeColumns] = useState(SCREEN_COLUMNS.toString());
  const [resizeRows, setResizeRows] = useState(SCREEN_ROWS.toString());
  const [autoFit, setAutoFit] = useState(true);
  const [fitNotice, setFitNotice] = useState<string>();
  const fitController = useRef<ActiveWindowFit | undefined>(undefined);
  const fitEnabled = useRef(true);
  const fitLive = useRef(false);
  const [browserTerminalMirror, setBrowserTerminalMirror] = useState("");
  const [cursorComposerLayout, setCursorComposerLayout] = useState<CursorComposerLayout>();
  const [commandEditorHeight, setCommandEditorHeight] = useState(0);
  const interactiveState = useRef(false);
  const commandEditor = useRef<HTMLTextAreaElement>(null);
  const secretEditor = useRef<HTMLInputElement>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalSurface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const createIdempotency = useRef<
    { readonly key: string; readonly signature: string } | undefined
  >(undefined);
  const forkIdempotency = useRef(new Map<string, string>());
  const latestSession = useRef<Session | undefined>(undefined);
  const latestInteraction = useRef<InteractionState | undefined>(undefined);
  const latestScreen = useRef<ScreenSnapshot | undefined>(undefined);
  const controlOutcomeScope = useRef<string | undefined>(undefined);
  const renderedCopyScreen = useRef<ScreenSnapshot | undefined>(undefined);
  const columnSelection = useRef(false);
  const guardReleaseTimer = useRef<number | undefined>(undefined);
  const guardTask = useRef<Promise<void>>(Promise.resolve());
  const inputBuffer = useRef<RawInputBatch | undefined>(undefined);
  const inputTimer = useRef<number | undefined>(undefined);
  const selectedGeneration = sessions.find((candidate) => candidate.id === selectedId)?.generation;
  const approvalRevision = timeline.findLast((event) =>
    event.type.startsWith("approval."),
  )?.sequence;
  const inbox = useApprovalInbox(approvalRevision, setError, bootstrap !== undefined);
  const { items: inboxApprovals, partial: inboxPartial, nextCursor: inboxCursor } = inbox;
  const sensitiveInputRevision = timeline.findLast((event) =>
    event.type.startsWith("sensitive_input."),
  )?.sequence;
  const secretPromptKey = detectSecretPromptKey(session, screen);
  const secureInputVisible =
    session?.status === "RUNNING" &&
    sensitiveInput?.status !== "ACTIVE" &&
    secretPromptKey !== undefined &&
    secretPromptKey !== dismissedSecretPromptKey;
  const activeRawInputTarget = rawInputTargetFromSession(session);
  const foregroundScope =
    activeRawInputTarget === undefined
      ? undefined
      : `${activeRawInputTarget.sessionId}:${activeRawInputTarget.generation.toString()}:${activeRawInputTarget.executionId}`;
  const foregroundLineVisible =
    session?.status === "RUNNING" &&
    !rawInput &&
    !secureInputVisible &&
    sensitiveInput?.status !== "ACTIVE";
  const foregroundDraft =
    foregroundLineVisible && foregroundScope !== undefined
      ? (foregroundDrafts[foregroundScope] ?? { revision: 0, value: "" })
      : undefined;
  const activeDraft = foregroundDraft ?? commandDraft;
  const editorValue = activeDraft.value;
  const command = commandDraft.value;
  const cursorComposerRequested =
    session?.status === "READY" || foregroundLineVisible || secureInputVisible;
  const pendingApprovalCount = inboxApprovals.length;
  const displayApprovals = [
    ...new Map(
      [...approvals, ...inboxApprovals].map((approval) => [approval.id, approval]),
    ).values(),
  ];
  const transitionSubmissionIntent = useCallback(
    (event: SubmissionIntentEvent): SubmissionIntentState => {
      const next = submissionIntentReducer(submissionIntentRef.current, event);
      submissionIntentRef.current = next;
      dispatchSubmissionIntent(event);
      return next;
    },
    [],
  );
  const cancelPendingRawInput = useCallback((reason: string): boolean => {
    if (inputTimer.current !== undefined) {
      window.clearTimeout(inputTimer.current);
      inputTimer.current = undefined;
    }
    const pending = inputBuffer.current;
    inputBuffer.current = undefined;
    if (pending !== undefined) {
      setInputModeNotice(
        `Raw key batch for ${rawInputTargetLabel(pending.target)} was dropped and was not sent: ${reason}.`,
      );
    }
    return pending !== undefined;
  }, []);

  useEffect(() => {
    const scope = session === undefined ? undefined : `${session.id}:${session.generation}`;
    if (controlOutcomeScope.current !== undefined && controlOutcomeScope.current !== scope)
      setControlOutcome(undefined);
    controlOutcomeScope.current = scope;
  }, [session?.generation, session?.id]);

  useEffect(() => {
    if (!isSubmissionIntentPending(submissionIntent)) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [submissionIntent]);

  useEffect(() => {
    if (session === undefined || bootstrap === undefined) return;
    const key = commandHistoryKey(bootstrap.actor.id, session.id, session.generation);
    let prior = commandHistories.current.get(key);
    if (prior === undefined) {
      try {
        prior = readCommandHistory(sessionStorage, key);
      } catch {
        prior = [];
      }
    }
    const next = mergeCommandHistory(
      prior,
      timeline.filter(
        (event) => event.sessionId === session.id && event.sessionGeneration === session.generation,
      ),
      bootstrap.actor.id,
    );
    commandHistories.current.set(key, next);
    if (next === prior) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      // History is an optional editor cache, never an execution prerequisite.
    }
  }, [bootstrap?.actor.id, session?.id, session?.generation, timeline]);

  useEffect(() => {
    latestSession.current = session;
  }, [session]);
  useEffect(() => {
    latestInteraction.current = interaction;
  }, [interaction]);
  useEffect(() => {
    latestScreen.current = screen;
  }, [screen]);
  useEffect(() => {
    fitLive.current = streamState === "live";
    fitController.current?.observe();
  }, [screen, session, streamState]);
  useEffect(() => {
    fitEnabled.current = autoFit;
    if (!autoFit) fitController.current?.suspend();
  }, [autoFit]);
  useEffect(() => {
    latestCursor.current = cursor;
  }, [cursor]);
  useEffect(() => {
    interactiveState.current = interactive;
  }, [interactive]);
  useEffect(() => {
    rawInputState.current = rawInput;
  }, [rawInput]);
  useEffect(() => {
    sensitiveInputActiveState.current = sensitiveInput?.status === "ACTIVE";
  }, [sensitiveInput?.status]);
  useEffect(() => {
    if ((!secureInputVisible && sensitiveInput?.status !== "ACTIVE") || !rawInputState.current)
      return;
    cancelPendingRawInput("protected input became active");
    setRawInput(false);
    rawInputState.current = false;
    rawInputTarget.current = undefined;
    setInteractive(false);
    interactiveState.current = false;
    terminal.current?.blur();
    setInputModeNotice(
      "Raw keys reset to Line input because protected input became active. Secret text must use the transient protected input control and is never stored as a raw intent.",
    );
  }, [cancelPendingRawInput, secureInputVisible, sensitiveInput?.status]);
  useEffect(() => {
    const previous = rawInputTarget.current;
    const droppedPending = cancelPendingRawInput("the active target changed");
    if (
      rawInputState.current &&
      previous !== undefined &&
      !sameRawInputTarget(previous, activeRawInputTarget)
    ) {
      pendingRawResetTarget.current = activeRawInputTarget === undefined ? previous : undefined;
      setInputModeNotice(
        `Raw keys reset to Line input because the target changed. Previous: ${rawInputTargetLabel(previous)}. Current: ${rawInputTargetLabel(activeRawInputTarget)}.${droppedPending ? " A pending raw key batch was dropped and was not sent." : ""}`,
      );
    } else if (
      pendingRawResetTarget.current !== undefined &&
      activeRawInputTarget !== undefined &&
      !sameRawInputTarget(pendingRawResetTarget.current, activeRawInputTarget)
    ) {
      setInputModeNotice(
        `Raw keys remain reset to Line input for the new target. Previous: ${rawInputTargetLabel(pendingRawResetTarget.current)}. Current: ${rawInputTargetLabel(activeRawInputTarget)}.`,
      );
      pendingRawResetTarget.current = undefined;
    }
    setRawInput(false);
    rawInputState.current = false;
    rawInputTarget.current = undefined;
    setInteractive(false);
    interactiveState.current = false;
  }, [cancelPendingRawInput, foregroundScope]);
  useEffect(() => {
    if (pendingApprovalCount === 0) return;
    setInspectorView("approvals");
    setInspectorOpen(true);
  }, [pendingApprovalCount]);
  useEffect(() => {
    if (session?.status !== "BROKEN") return;
    setInspectorView("session");
    setInspectorOpen(true);
  }, [session?.generation, session?.id, session?.status]);
  useEffect(() => {
    if (session === undefined || screen === undefined) return;
    sessionStorage.setItem(
      resumeKey(session.id, session.generation),
      JSON.stringify({
        cursor,
        events: timeline,
        screenVersion: screen.screenVersion,
      } satisfies ResumeState),
    );
  }, [cursor, screen, session, timeline]);

  const applySessionDiscovery = useCallback((page: SessionDiscoveryPage<Session>): void => {
    const next = page.sessions;
    setDiscoveryNotice(
      page.partial
        ? "Some Runtime owners are unavailable; this list includes historical metadata."
        : "",
    );
    setSessionsCursor(page.nextCursor);
    setSessions(next);
    setSelectedId((current) =>
      selectedSessionTab(
        current,
        visibleSessionsRef.current,
        visibleSessionTabs(next, dismissedTabsRef.current),
      ),
    );
  }, []);
  const navigation = useSessionDiscovery(applySessionDiscovery, setError, bootstrap !== undefined);
  const refreshSessions = navigation.refresh;

  useEffect(() => {
    const abort = new AbortController();
    void api<Bootstrap>("/api/bootstrap", { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        setBootstrap(value);
        setSessions(value.sessions);
        setSelectedId(visibleSessionTabs(value.sessions, dismissedTabsRef.current)[0]?.id);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(normalizeClientError(reason));
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (terminalHost.current === null) return;
    const instance = new Terminal({
      allowProposedApi: false,
      cols: SCREEN_COLUMNS,
      convertEol: false,
      cursorBlink: true,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      rows: SCREEN_ROWS,
      scrollback: 0,
      theme: {
        background: "#070a0f",
        cursor: "#67e8f9",
        foreground: "#dbeafe",
        selectionBackground: "#155e75",
      },
    });
    instance.open(terminalHost.current);
    instance.write("\u001b[?25l");
    terminal.current = instance;
    const dataSubscription = instance.onData((data) => {
      if (!interactiveState.current) return;
      const dispatch = classifyRawTerminalData(data);
      if (sensitiveInputActiveState.current) {
        if (
          dispatch.kind === "control" &&
          (dispatch.control === "CTRL_C" || dispatch.control === "CTRL_D")
        ) {
          void sendControl(dispatch.control);
        }
        return;
      }
      const target = rawInputTarget.current;
      if (!rawInputState.current || target === undefined) return;
      if (dispatch.kind === "control") {
        void sendControl(dispatch.control, target);
      } else if (dispatch.kind === "input") {
        queueInput(dispatch.data, target);
      } else {
        setInputModeNotice(dispatch.message);
      }
    });
    return () => {
      dataSubscription.dispose();
      instance.dispose();
      terminal.current = undefined;
    };
  }, [bootstrap?.actor.id]);

  useEffect(() => {
    const host = terminalHost.current;
    const surface = terminalSurface.current;
    if (
      host === null ||
      surface === null ||
      bootstrap === undefined ||
      selectedId === undefined ||
      selectedGeneration === undefined
    )
      return;
    const scope = `${selectedId}:${selectedGeneration.toString()}`;
    const controller = new ActiveWindowFit(
      () => {
        const current = latestSession.current;
        const snapshot = latestScreen.current;
        const rendered = terminal.current;
        const grid = host.querySelector(".xterm-screen")?.getBoundingClientRect();
        if (
          current?.id !== selectedId ||
          current.generation !== selectedGeneration ||
          snapshot === undefined ||
          rendered === undefined ||
          grid === undefined
        )
          return undefined;
        const padding = getComputedStyle(host);
        const desired = fittedGeometry(
          surface.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
          surface.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom),
          grid.width / rendered.cols,
          grid.height / rendered.rows,
          bootstrap.geometryBounds,
        );
        return desired === undefined
          ? undefined
          : { scope, version: snapshot.geometryVersion, current: snapshot, desired };
      },
      () => {
        const current = latestSession.current;
        const policy = latestInteraction.current;
        return (
          fitEnabled.current &&
          fitLive.current &&
          document.hasFocus() &&
          document.visibilityState === "visible" &&
          current?.id === selectedId &&
          current.generation === selectedGeneration &&
          ["READY", "RESERVED", "RUNNING"].includes(current.status) &&
          policy?.policy !== "agent_only" &&
          (policy?.guard === undefined || policy.guard.actor.id === bootstrap.actor.id)
        );
      },
      async (request) => {
        await api(`/api/sessions/${encodeURIComponent(selectedId)}/resize`, {
          method: "POST",
          body: {
            ...request.desired,
            expectedGeometryVersion: request.version,
            generation: selectedGeneration,
            idempotencyKey: crypto.randomUUID(),
          },
        });
        setFitNotice(undefined);
      },
      (reason) => {
        const code = normalizeClientError(reason).code;
        const rejected = [
          "GEOMETRY_CHANGED",
          "INPUT_GUARDED",
          "POLICY_DENIED",
          "SESSION_NOT_READY",
          "RATE_LIMITED",
        ].includes(code);
        setFitNotice(
          rejected
            ? `Window fitting paused (${code}). Interact with the terminal to try again.`
            : `Window fitting paused (${code}). Check shared geometry before reopening this Session; the request was not retried.`,
        );
        return rejected ? "rejected" : "uncertain";
      },
    );
    fitController.current = controller;
    setFitNotice(undefined);
    const activate = (event: Event): void => {
      if (event.isTrusted) controller.activate();
    };
    const suspend = (): void => controller.suspend();
    let lastWidth = surface.clientWidth;
    let lastHeight = surface.clientHeight;
    const observer = new ResizeObserver(() => {
      // Ignore canonical reflow and draft growth: only the allocated viewport requests a fit.
      const width = surface.clientWidth;
      const height = surface.clientHeight;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      controller.layoutChanged();
    });
    observer.observe(surface);
    surface.addEventListener("pointerdown", activate, true);
    surface.addEventListener("keydown", activate, true);
    window.addEventListener("blur", suspend);
    document.addEventListener("visibilitychange", suspend);
    return () => {
      controller.dispose();
      observer.disconnect();
      surface.removeEventListener("pointerdown", activate, true);
      surface.removeEventListener("keydown", activate, true);
      window.removeEventListener("blur", suspend);
      document.removeEventListener("visibilitychange", suspend);
      fitController.current = undefined;
    };
  }, [bootstrap, selectedId, selectedGeneration]);

  useEffect(() => {
    let disposed = false;
    const view = terminal.current;
    const renderingSocket = socket.current;
    if (view !== undefined && screen !== undefined) {
      renderScreen(
        view,
        screen,
        session?.status === "RUNNING" && !cursorComposerRequested,
        (text) => {
          if (
            disposed ||
            terminal.current !== view ||
            latestSession.current?.id !== session?.id ||
            latestSession.current?.generation !== session?.generation
          )
            return;
          if (terminal.current === view) {
            renderedCopyScreen.current = screen;
            if (
              socket.current === renderingSocket &&
              renderingSocket?.readyState === WebSocket.OPEN
            )
              renderingSocket.send(
                JSON.stringify({
                  type: "ack",
                  screenVersion: screen.screenVersion,
                  cursor: latestCursor.current,
                }),
              );
          }
          setBrowserTerminalMirror(text);
          if (cursorComposerRequested) {
            window.requestAnimationFrame(() => {
              if (disposed) return;
              syncCursorComposerLayout(
                terminalHost.current,
                terminalSurface.current,
                screen,
                setCursorComposerLayout,
              );
            });
          }
        },
      );
    }
    return () => {
      disposed = true;
    };
  }, [cursorComposerRequested, screen, session?.status, session?.id, session?.generation]);

  useLayoutEffect(() => {
    if (!cursorComposerRequested || screen === undefined) {
      setCursorComposerLayout(undefined);
      return;
    }
    const host = terminalHost.current;
    const surface = terminalSurface.current;
    if (host === null || surface === null) return;
    const sync = (): void => {
      syncCursorComposerLayout(host, surface, screen, setCursorComposerLayout);
    };
    sync();
    const frame = window.requestAnimationFrame(sync);
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    observer.observe(surface);
    surface.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      surface.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [cursorComposerRequested, screen, inspectorOpen, inspectorView]);

  const readyCommandVisible =
    session?.id === selectedId &&
    (session?.status === "READY" || foregroundLineVisible) &&
    screen !== undefined &&
    cursorComposerLayout !== undefined;
  useLayoutEffect(() => {
    const editor = commandEditor.current;
    const surface = terminalSurface.current;
    if (
      !readyCommandVisible ||
      editor === null ||
      surface === null ||
      cursorComposerLayout === undefined
    )
      return;
    // Measure actual visual rows, including soft wraps, without changing the command bytes.
    editor.style.height = "0px";
    const height = Math.max(cursorComposerLayout.height, editor.scrollHeight);
    editor.style.height = `${height.toString()}px`;
    setCommandEditorHeight(height);
    if (historyCaretRestore.current) {
      historyCaretRestore.current = false;
      placeCaretAtEnd(editor);
    }
    const frame = window.requestAnimationFrame(() => revealCommandCaret(editor, surface));
    return () => window.cancelAnimationFrame(frame);
  }, [editorValue, cursorComposerLayout, readyCommandVisible]);

  useEffect(() => {
    if (!readyCommandVisible) return;
    const frame = window.requestAnimationFrame(() => {
      commandEditor.current?.focus({ preventScroll: true });
      if (commandEditor.current !== null) placeCaretAtEnd(commandEditor.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    readyCommandVisible,
    session?.generation,
    session?.id,
    session?.status,
    session?.activeExecutionId,
  ]);

  useEffect(() => {
    if (!secureInputVisible || cursorComposerLayout === undefined) return;
    terminal.current?.blur();
    setInteractive(false);
    const frame = window.requestAnimationFrame(() => secretEditor.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [cursorComposerLayout, secureInputVisible]);

  useEffect(() => {
    setDismissedSecretPromptKey(undefined);
    setSecret("");
  }, [session?.activeExecutionId, session?.generation, session?.id]);

  useEffect(() => {
    if (screen === undefined) return;
    setResizeColumns(screen.columns.toString());
    setResizeRows(screen.rows.toString());
  }, [screen?.columns, screen?.rows]);

  const applyStreamFrame = useCallback((frame: StreamFrame): void => {
    setPersistencePartial(frame.partial === true);
    if (frame.error !== undefined) setError(frame.error);
    if (frame.type === "resync_required") {
      setStreamState("gap");
      return;
    }
    if (frame.session !== undefined) {
      const nextSession = frame.session;
      latestSession.current = nextSession;
      setSession(nextSession);
      setSessions((current) =>
        current.map((candidate) => (candidate.id === nextSession.id ? nextSession : candidate)),
      );
    }
    if (frame.interaction !== undefined) {
      latestInteraction.current = frame.interaction;
      setInteraction(frame.interaction);
    }
    if (frame.screen !== undefined) setScreen(frame.screen);
    if (frame.events !== undefined) {
      setTimeline((current) => mergeEvents(current, frame.events ?? []));
    }
    if (frame.cursor !== undefined) setCursor(frame.cursor);
    setStreamState(frame.liveGap === undefined && frame.eventGap === undefined ? "live" : "gap");
  }, []);

  useEffect(() => {
    if (selectedId === undefined) {
      latestSession.current = undefined;
      setSession(undefined);
      setInteraction(undefined);
      setScreen(undefined);
      setTimeline([]);
      setCursor(0);
      setStreamState("offline");
      setCheckpoint(undefined);
      setApprovals([]);
      setSensitiveInput(undefined);
      setCommandDraft((draft) => ({ revision: draft.revision + 1, value: "" }));
      setError(undefined);
      setBrowserTerminalMirror("");
      latestScreen.current = undefined;
      renderedCopyScreen.current = undefined;
      terminal.current?.reset();
      terminal.current?.write("\u001b[?25l");
      return;
    }
    const selected = sessions.find((candidate) => candidate.id === selectedId);
    if (selected === undefined) return;
    setError(undefined);
    const saved = readResume(selected.id, selected.generation);
    latestSession.current = selected;
    setSession(selected);
    setInteraction(undefined);
    setScreen(undefined);
    latestScreen.current = undefined;
    renderedCopyScreen.current = undefined;
    terminal.current?.reset();
    setBrowserTerminalMirror("");
    setCursor(saved?.cursor ?? 0);
    latestCursor.current = saved?.cursor ?? 0;
    setTimeline(saved?.events ?? []);
    setCheckpoint(undefined);
    setStaleAcknowledged(false);
    setCommandDraft((draft) => ({ revision: draft.revision + 1, value: "" }));
    commandHistoryNavigation.current.reset();
    historyCaretRestore.current = false;
    let disposed = false;
    if (selected.status === "BROKEN" || selected.status === "CLOSED") {
      setStreamState("offline");
      const after = Math.max(0, selected.eventSequence - MAX_TIMELINE_EVENTS);
      void api<{ readonly events: readonly SessionEvent[]; readonly truncated: boolean }>(
        `/api/sessions/${encodeURIComponent(selected.id)}/events?generation=${selected.generation.toString()}&after=${after.toString()}&limit=${MAX_TIMELINE_EVENTS.toString()}`,
      )
        .then((page) => {
          if (disposed) return;
          setTimeline(page.events);
          setCursor(page.events.at(-1)?.sequence ?? 0);
        })
        .catch((reason: unknown) => {
          if (!disposed) setError(normalizeClientError(reason));
        });
      return () => {
        disposed = true;
      };
    }
    return connectConsoleStream({
      sessionId: selected.id,
      generation: selected.generation,
      resume: () => ({
        cursor: latestCursor.current,
        screenVersion: latestScreen.current?.screenVersion ?? saved?.screenVersion,
      }),
      onSocket: (next) => {
        socket.current = next;
      },
      onState: setStreamState,
      onError: (reason) => setError(normalizeClientError(reason)),
      onFrame: (value, next) => {
        let frame = value as StreamFrame;
        if (frame.screenDelta) {
          const before = latestScreen.current;
          const complete =
            before && "format" in before
              ? applyScreenDelta(before as TerminalConsoleFrame, frame.screenDelta)
              : undefined;
          if (!complete) {
            next.close(1000, "screen resync required");
            return;
          }
          frame = { ...frame, screen: complete };
        }
        if (frame.screen) latestScreen.current = frame.screen;
        applyStreamFrame(frame);
      },
    });
  }, [applyStreamFrame, selectedGeneration, selectedId]);

  useEffect(() => {
    if (session === undefined || session.status === "CLOSED") {
      setCheckpoint(undefined);
      return;
    }
    let disposed = false;
    void api<ShellCheckpoint>(
      `/api/sessions/${encodeURIComponent(session.id)}/checkpoint?generation=${session.generation.toString()}`,
    )
      .then((next) => {
        if (!disposed) setCheckpoint(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(normalizeClientError(reason));
      });
    return () => {
      disposed = true;
    };
  }, [session?.generation, session?.id, session?.status]);

  useEffect(() => {
    if (!session || session.status === "CLOSED" || session.status === "BROKEN") {
      setApprovals([]);
      return;
    }
    let disposed = false;
    void api<readonly Approval[]>(
      `/api/sessions/${encodeURIComponent(session.id)}/approvals?generation=${session.generation}`,
    )
      .then((next) => {
        if (!disposed) setApprovals(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(normalizeClientError(reason));
      });
    return () => {
      disposed = true;
    };
  }, [approvalRevision, session?.id, session?.generation, session?.status]);

  useEffect(() => {
    if (session === undefined || session.status === "CLOSED" || session.status === "BROKEN") {
      setSensitiveInput(undefined);
      return;
    }
    let disposed = false;
    void api<SensitiveInput | undefined>(
      `/api/sessions/${encodeURIComponent(session.id)}/secret-input?generation=${session.generation.toString()}`,
    )
      .then((next) => {
        if (!disposed) setSensitiveInput(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(normalizeClientError(reason));
      });
    return () => {
      disposed = true;
    };
  }, [sensitiveInputRevision, session?.generation, session?.id, session?.status]);

  useEffect(() => {
    const running = session?.status === "RUNNING";
    if (terminal.current !== undefined)
      terminal.current.options.disableStdin =
        !running || (!rawInput && sensitiveInput?.status !== "ACTIVE");
    if (!running) setInteractive(false);
  }, [session?.status, rawInput, sensitiveInput?.status]);

  const queueInput = (data: string, target: RawInputTarget): void => {
    const pending = inputBuffer.current;
    if (pending !== undefined && !sameRawInputTarget(pending.target, target)) {
      setInputModeNotice(
        `Raw key batch for ${rawInputTargetLabel(target)} was dropped and was not sent because another target already had a pending batch.`,
      );
      return;
    }
    inputBuffer.current = { data: (pending?.data ?? "") + data, target };
    if (inputTimer.current !== undefined) return;
    inputTimer.current = window.setTimeout(() => {
      inputTimer.current = undefined;
      const batch = inputBuffer.current;
      inputBuffer.current = undefined;
      if (batch === undefined) return;
      guardTask.current = guardTask.current
        .then(async () => {
          let guardPrepared = false;
          try {
            const stillCurrent = (): boolean =>
              rawInputBatchCanSend({
                activeTarget: rawInputTargetFromSession(latestSession.current),
                armedTarget: rawInputTarget.current,
                batchTarget: batch.target,
                focused: interactiveState.current,
                rawMode: rawInputState.current,
              });
            if (!stillCurrent()) {
              setInputModeNotice(
                `Raw key batch for ${rawInputTargetLabel(batch.target)} was dropped and was not sent because raw focus or the active target changed.`,
              );
              return;
            }
            await ensureGuard(batch.target);
            guardPrepared = true;
            if (!stillCurrent()) {
              setInputModeNotice(
                `Raw key batch for ${rawInputTargetLabel(batch.target)} was dropped and was not sent because raw focus or the active target changed while input ownership was checked.`,
              );
              return;
            }
            await api(`/api/sessions/${encodeURIComponent(batch.target.sessionId)}/input`, {
              body: {
                data: batch.data,
                generation: batch.target.generation,
                idempotencyKey: crypto.randomUUID(),
                targetExecutionId: batch.target.executionId,
              },
              method: "POST",
            });
            setLocalInputUncertainty({
              executionId: batch.target.executionId,
              generation: batch.target.generation,
              reason: "untracked_input",
              sessionId: batch.target.sessionId,
            });
          } finally {
            if (guardPrepared) scheduleGuardRelease();
          }
        })
        .catch((reason: unknown) => setError(normalizeClientError(reason)));
    }, INPUT_BATCH_MS);
  };

  const beginSecretInput = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (secretSubmitting) return;
    const currentSession = requiredRunningSession();
    const transientSecret = secret;
    setSecret("");
    setSecretSubmitting(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(currentSession.id)}/secret-input`, {
        body: {
          data: `${transientSecret}\r`,
          generation: currentSession.generation,
          idempotencyKey: crypto.randomUUID(),
          targetExecutionId: requiredExecution(currentSession),
        },
        method: "POST",
      });
      setLocalInputUncertainty({
        executionId: requiredExecution(currentSession),
        generation: currentSession.generation,
        reason: "untracked_input",
        sessionId: currentSession.id,
      });
      setSensitiveInput(
        await api<SensitiveInput>(
          `/api/sessions/${encodeURIComponent(currentSession.id)}/secret-input?generation=${currentSession.generation.toString()}`,
        ),
      );
    } catch (reason) {
      setError(normalizeClientError(reason));
    } finally {
      setSecretSubmitting(false);
    }
  };

  const finishSecretInput = async (outcome: "completed" | "cancelled"): Promise<void> => {
    if (
      session === undefined ||
      sensitiveInput === undefined ||
      (sensitiveInput.actor.id !== bootstrap?.actor.id && session.status !== "READY") ||
      sensitiveFinishing
    ) {
      return;
    }
    setSensitiveFinishing(true);
    try {
      setSensitiveInput(
        await api<SensitiveInput>(
          `/api/sessions/${encodeURIComponent(session.id)}/secret-input/${encodeURIComponent(sensitiveInput.id)}/finish`,
          {
            body: {
              expectedVersion: sensitiveInput.version,
              generation: session.generation,
              idempotencyKey: crypto.randomUUID(),
              outcome,
            },
            method: "POST",
          },
        ),
      );
    } catch (reason) {
      const failure = normalizeClientError(reason);
      if (failure.code !== "POLICY_DENIED") setError(failure);
    } finally {
      setSensitiveFinishing(false);
    }
  };

  const ensureGuard = async (target: RawInputTarget): Promise<void> => {
    const currentSession = requiredRunningSession();
    if (!sameRawInputTarget(rawInputTargetFromSession(currentSession), target)) {
      throw new Error(`EXECUTION_CHANGED: ${rawInputTargetLabel(target)}`);
    }
    let state = latestInteraction.current;
    if (
      state === undefined ||
      state.sessionId !== target.sessionId ||
      state.sessionGeneration !== target.generation
    ) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(target.sessionId)}/interaction?generation=${target.generation.toString()}`,
      );
      setInteraction(state);
      latestInteraction.current = state;
    }
    if (state.policy !== "human_guarded") return;
    const ownGuard = state.guard?.actor.id === bootstrap?.actor.id;
    if (state.guard !== undefined && !ownGuard) {
      throw new Error(`INPUT_GUARDED: ${state.guard.actor.id}`);
    }
    if (state.guard !== undefined && Date.parse(state.guard.expiresAt) - Date.now() < 200) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(target.sessionId)}/interaction?generation=${target.generation.toString()}`,
      );
      setInteraction(state);
      latestInteraction.current = state;
    }
    if (state.guard !== undefined && state.guard.actor.id !== bootstrap?.actor.id) {
      throw new Error(`INPUT_GUARDED: ${state.guard.actor.id}`);
    }
    if (state.guard === undefined) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(target.sessionId)}/interaction/guard`,
        {
          body: {
            expectedVersion: state.version,
            generation: target.generation,
            reason: "browser raw-key batch",
            ttlMilliseconds: 500,
          },
          method: "POST",
        },
      );
      setInteraction(state);
      latestInteraction.current = state;
      return;
    }
    if (Date.parse(state.guard.expiresAt) - Date.now() >= 200) return;
    if (state.guard.renewals < state.guard.maxRenewals) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(target.sessionId)}/interaction/guard`,
        {
          body: {
            expectedVersion: state.version,
            generation: target.generation,
            guardId: state.guard.id,
            ttlMilliseconds: 500,
          },
          method: "PATCH",
        },
      );
      setInteraction(state);
      latestInteraction.current = state;
      return;
    }
    await releaseGuard();
    const released = latestInteraction.current;
    if (released === undefined) throw new Error("Interaction state unavailable after release");
    state = await api<InteractionState>(
      `/api/sessions/${encodeURIComponent(target.sessionId)}/interaction/guard`,
      {
        body: {
          expectedVersion: released.version,
          generation: target.generation,
          reason: "browser raw-key batch",
          ttlMilliseconds: 500,
        },
        method: "POST",
      },
    );
    setInteraction(state);
    latestInteraction.current = state;
  };

  const scheduleGuardRelease = (): void => {
    if (guardReleaseTimer.current !== undefined) window.clearTimeout(guardReleaseTimer.current);
    guardReleaseTimer.current = window.setTimeout(() => {
      guardTask.current = guardTask.current
        .then(releaseGuard)
        .catch((reason: unknown) => setError(normalizeClientError(reason)));
    }, GUARD_IDLE_RELEASE_MS);
  };

  const releaseGuardAfterPendingInput = (): void => {
    guardTask.current = guardTask.current
      .then(releaseGuard)
      .catch((reason: unknown) => setError(normalizeClientError(reason)));
  };

  const releaseGuard = async (): Promise<void> => {
    const currentSession = latestSession.current;
    let state = latestInteraction.current;
    if (
      currentSession === undefined ||
      state?.guard === undefined ||
      state.guard.actor.id !== bootstrap?.actor.id
    ) {
      return;
    }
    let next: InteractionState;
    try {
      next = await deleteInteractionGuard(currentSession, state.version, state.guard.id);
    } catch (reason) {
      if (
        !(reason instanceof ConsoleApiError) ||
        reason.body.code !== "INTERACTION_GUARD_CHANGED"
      ) {
        throw reason;
      }
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction?generation=${currentSession.generation.toString()}`,
      );
      latestInteraction.current = state;
      setInteraction(state);
      if (state.guard?.actor.id !== bootstrap?.actor.id) return;
      next = await deleteInteractionGuard(currentSession, state.version, state.guard.id);
    }
    latestInteraction.current = next;
    setInteraction(next);
  };

  const deleteInteractionGuard = (
    currentSession: Session,
    expectedVersion: number,
    guardId: string,
  ): Promise<InteractionState> =>
    api<InteractionState>(
      `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction/guard`,
      {
        body: {
          expectedVersion,
          generation: currentSession.generation,
          guardId,
        },
        method: "DELETE",
      },
    );

  const requiredRunningSession = (): Session => {
    const current = latestSession.current;
    if (current === undefined || current.status !== "RUNNING") {
      throw new Error("Interactive input requires a RUNNING Session");
    }
    return current;
  };

  const sendControl = async (
    control: RawControl,
    exactTarget?: RawInputTarget,
    requireRawOwnership = true,
  ): Promise<void> => {
    try {
      if (
        requireRawOwnership &&
        exactTarget !== undefined &&
        !rawInputBatchCanSend({
          activeTarget: rawInputTargetFromSession(latestSession.current),
          armedTarget: rawInputTarget.current,
          batchTarget: exactTarget,
          focused: interactiveState.current,
          rawMode: rawInputState.current,
        })
      ) {
        setInputModeNotice(
          `Raw control for ${rawInputTargetLabel(exactTarget)} was dropped and was not sent because raw focus or the active target changed.`,
        );
        return;
      }
      const target = exactTarget ?? rawInputTargetFromSession(requiredRunningSession());
      if (target === undefined) throw new Error("No active Execution");
      const result = await api<{ readonly id: string; readonly status: string }>(
        `/api/sessions/${encodeURIComponent(target.sessionId)}/control`,
        {
          body: {
            bypassGuard: false,
            delivery: { control, mode: "TTY_CONTROL" },
            generation: target.generation,
            idempotencyKey: crypto.randomUUID(),
            targetExecutionId: target.executionId,
          },
          method: "POST",
        },
      );
      setControlOutcome({
        executionId: target.executionId,
        generation: target.generation,
        id: result.id,
        sessionId: target.sessionId,
        status: result.status,
      });
      setLocalInputUncertainty({
        executionId: target.executionId,
        generation: target.generation,
        reason: "untracked_input",
        sessionId: target.sessionId,
      });
      setInputModeNotice(`Control Action ${result.id} returned ${result.status}.`);
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const createSession = async (): Promise<void> => {
    if (creatingSession) return;
    const workspaceRoot = newSessionWorkspace.trim();
    if (workspaceRoot === "") {
      setError(normalizeClientError(new Error("Workspace directory is required")));
      return;
    }
    const signature = JSON.stringify({
      shell: DEFAULT_SESSION_SHELL,
      workspaceRoot,
    });
    let creation = createIdempotency.current;
    if (creation?.signature !== signature) {
      creation = { key: crypto.randomUUID(), signature };
      createIdempotency.current = creation;
    }
    setCreatingSession(true);
    try {
      const created = await api<Session>("/api/sessions", {
        body: {
          idempotencyKey: creation.key,
          shell: DEFAULT_SESSION_SHELL,
          workspaceRoot,
        },
        method: "POST",
      });
      createIdempotency.current = undefined;
      await refreshSessions();
      setSelectedId(created.id);
      if (newSessionName.trim() !== "")
        setSessionLabels((labels) => ({ ...labels, [created.id]: newSessionName.trim() }));
      setNewSessionFormOpen(false);
      setNewSessionName("");
      setNewSessionWorkspace("");
    } catch (reason) {
      setError(normalizeClientError(reason));
    } finally {
      setCreatingSession(false);
    }
  };

  const execute = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (foregroundLineVisible) {
      await submitForegroundLine();
      return;
    }
    if (session === undefined || command.trim() === "") return;
    const target = session;
    const identity = beginSubmissionIntent(() => {
      const idempotencyKey = crypto.randomUUID();
      return {
        draftRevision: commandDraft.revision,
        generation: target.generation,
        idempotencyKey,
        payload: {
          body: { command, generation: target.generation, idempotencyKey },
          kind: "execute",
        },
        sessionId: target.id,
      };
    });
    if (identity === undefined) return;
    setControlOutcome(undefined);
    const { idempotencyKey } = identity;
    try {
      const result = await api<{
        readonly action: { readonly id: string; readonly status: string };
        readonly execution: { readonly id: string; readonly status: string };
      }>(`/api/sessions/${encodeURIComponent(target.id)}/execute`, {
        body: identity.payload.body,
        method: "POST",
      });
      transitionSubmissionIntent({
        actionId: result.action.id,
        actionStatus: result.action.status,
        executionId: result.execution.id,
        executionStatus: result.execution.status,
        generation: identity.generation,
        idempotencyKey,
        sessionId: identity.sessionId,
        type: "accepted",
      });
      clearAcceptedDraft(identity);
      commandHistoryNavigation.current.reset();
    } catch (reason) {
      settleSubmissionFailure(identity, reason);
    }
  };

  const submitForegroundLine = async (): Promise<void> => {
    if (
      session === undefined ||
      foregroundScope === undefined ||
      editorValue.trim() === "" ||
      foregroundPreparing.current.has(foregroundScope) ||
      isSubmissionIntentPending(submissionIntentRef.current)
    )
      return;
    const localUncertaintyIsCurrent =
      localInputUncertainty !== undefined &&
      session?.id === localInputUncertainty.sessionId &&
      session.generation === localInputUncertainty.generation &&
      session.activeExecutionId === localInputUncertainty.executionId;
    const uncertaintyReason =
      interaction?.inputContext?.state === "unknown"
        ? interaction.inputContext.unknownReason
        : localUncertaintyIsCurrent
          ? localInputUncertainty.reason
          : undefined;
    if (uncertaintyReason !== undefined) {
      setInputModeNotice(describeInputUncertainty(uncertaintyReason));
      return;
    }
    const target = session;
    const scope = foregroundScope;
    const draft = editorValue;
    const draftRevision = activeDraft.revision;
    let submittedIdentity: SubmissionIntentIdentity | undefined;
    foregroundPreparing.current.add(scope);
    try {
      const observed = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(target.id)}/interaction?generation=${target.generation}`,
      );
      const context = observed.inputContext;
      if (context?.state === "unknown") {
        setInputModeNotice(describeInputUncertainty(context.unknownReason ?? "delivery"));
        return;
      }
      if (context === undefined || context.targetExecutionId !== target.activeExecutionId)
        throw new Error(
          "Foreground input context is unavailable; refresh and check the active program",
        );
      const targetExecutionId = target.activeExecutionId;
      if (targetExecutionId === undefined) return;
      const current = latestSession.current;
      if (
        current?.id !== target.id ||
        current.generation !== target.generation ||
        current.activeExecutionId !== target.activeExecutionId
      )
        return;
      const identity = beginSubmissionIntent(() => {
        const idempotencyKey = crypto.randomUUID();
        return {
          draftRevision,
          executionId: targetExecutionId,
          generation: target.generation,
          idempotencyKey,
          payload: {
            body: {
              data: `${draft}\n`,
              generation: target.generation,
              targetExecutionId,
              lineInput: {
                expectedInputVersion: context.version,
                expectedInteractionVersion: observed.version,
              },
              idempotencyKey,
            },
            kind: "input",
          },
          sessionId: target.id,
        };
      });
      if (identity === undefined) return;
      submittedIdentity = identity;
      const { idempotencyKey } = identity;
      const result = await api<{ readonly id: string; readonly status: string }>(
        `/api/sessions/${encodeURIComponent(target.id)}/input`,
        {
          method: "POST",
          body: identity.payload.body,
        },
      );
      if (result.status === "DELIVERED") {
        transitionSubmissionIntent({
          actionId: result.id,
          actionStatus: result.status,
          generation: identity.generation,
          idempotencyKey,
          sessionId: identity.sessionId,
          type: "accepted",
        });
        clearAcceptedDraft(identity);
      } else {
        transitionSubmissionIntent({
          actionId: result.id,
          generation: identity.generation,
          idempotencyKey,
          message: `The Input Action status is ${result.status}. Check the accepted Action before deciding what to do; this request will not be sent again.`,
          sessionId: identity.sessionId,
          type: "uncertain",
        });
      }
    } catch (reason) {
      const intent = submissionIntentRef.current;
      if (submissionIntentCanSettleFailure(intent, submittedIdentity)) {
        settleSubmissionFailure(submittedIdentity, reason);
      } else {
        setError(normalizeClientError(reason));
      }
    } finally {
      foregroundPreparing.current.delete(scope);
    }
  };

  const beginSubmissionIntent = (
    createIdentity: () => SubmissionIntentIdentity,
  ): SubmissionIntentIdentity | undefined => {
    const before = submissionIntentRef.current;
    const next = startSubmissionIntent(before, createIdentity);
    if (next === before || next.status !== "submitting") return undefined;
    const identity = identityOfIntent(next);
    submissionIntentRef.current = next;
    dispatchSubmissionIntent({ identity, type: "begin" });
    return identity;
  };

  const settleSubmissionFailure = (identity: SubmissionIntentIdentity, reason: unknown): void => {
    const failure = normalizeClientError(reason);
    if (failure.code === "DELIVERY_UNKNOWN" && identity.executionId !== undefined)
      setLocalInputUncertainty({
        executionId: identity.executionId,
        generation: identity.generation,
        reason: "delivery",
        sessionId: identity.sessionId,
      });
    transitionSubmissionIntent(
      isDefiniteAdmissionRejection(reason)
        ? {
            code: failure.code,
            generation: identity.generation,
            idempotencyKey: identity.idempotencyKey,
            message: failure.message,
            sessionId: identity.sessionId,
            type: "rejected",
          }
        : {
            generation: identity.generation,
            idempotencyKey: identity.idempotencyKey,
            message:
              "The submission response was not established. The frozen request identity is kept in this tab; use Check result, which performs no terminal write.",
            sessionId: identity.sessionId,
            type: "uncertain",
          },
    );
    setError(failure);
  };

  const clearAcceptedDraft = (identity: SubmissionIntentIdentity): void => {
    if (identity.payload.kind === "input" && identity.executionId !== undefined) {
      const executionId = identity.executionId;
      const scope = `${identity.sessionId}:${identity.generation.toString()}:${executionId}`;
      setForegroundDrafts((drafts) => {
        const draft = drafts[scope];
        return draft !== undefined &&
          submissionIntentMatchesDraft(identity, {
            draftRevision: draft.revision,
            executionId,
            generation: identity.generation,
            sessionId: identity.sessionId,
          })
          ? {
              ...drafts,
              [scope]: { revision: draft.revision + 1, value: "" },
            }
          : drafts;
      });
      return;
    }
    const current = latestSession.current;
    if (current === undefined) return;
    setCommandDraft((draft) =>
      submissionIntentMatchesDraft(identity, {
        draftRevision: draft.revision,
        generation: current.generation,
        sessionId: current.id,
      })
        ? { revision: draft.revision + 1, value: "" }
        : draft,
    );
  };

  const reconcileSubmission = async (): Promise<void> => {
    const intent = submissionIntentRef.current;
    if (intent.status !== "uncertain" || intent.checking) return;
    transitionSubmissionIntent({
      generation: intent.generation,
      idempotencyKey: intent.idempotencyKey,
      sessionId: intent.sessionId,
      type: "lookup_started",
    });
    try {
      const result = await api<ActionLookupResult>(
        `/api/sessions/${encodeURIComponent(intent.sessionId)}/actions/lookup`,
        {
          body: {
            generation: intent.generation,
            idempotencyKey: intent.idempotencyKey,
          },
          method: "POST",
        },
      );
      const next = transitionSubmissionIntent({
        generation: intent.generation,
        idempotencyKey: intent.idempotencyKey,
        result,
        sessionId: intent.sessionId,
        type: "lookup_finished",
      });
      if (next.status === "accepted") clearAcceptedDraft(identityOfIntent(next));
    } catch (reason) {
      transitionSubmissionIntent({
        generation: intent.generation,
        idempotencyKey: intent.idempotencyKey,
        message: `Result lookup is unavailable: ${normalizeClientError(reason).message}. The original submission remains uncertain and was not resent.`,
        sessionId: intent.sessionId,
        type: "lookup_failed",
      });
    }
  };

  const copyMcpConfig = async (): Promise<void> => {
    const configJson = bootstrap?.mcpConnection?.configJson;
    if (configJson === undefined) return;
    try {
      await navigator.clipboard.writeText(configJson);
      setMcpConfigCopied(true);
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const navigateCommandHistory = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      session?.status !== "READY" ||
      bootstrap === undefined
    )
      return false;
    const editor = event.currentTarget;
    if (editor.selectionStart !== editor.selectionEnd) return false;
    const { row, lineHeight } = commandCaretPosition(editor);
    const lastRow = Math.max(0, Math.round(editor.clientHeight / lineHeight) - 1);
    if (event.key === "ArrowUp" ? row > 0 : row < lastRow) return false;
    const key = commandHistoryKey(bootstrap.actor.id, session.id, session.generation);
    const recalled = commandHistoryNavigation.current.move(
      event.key === "ArrowUp" ? "older" : "newer",
      command,
      commandHistories.current.get(key) ?? [],
    );
    if (recalled === undefined) return false;
    event.preventDefault();
    historyCaretRestore.current = recalled !== command;
    if (recalled === command) placeCaretAtEnd(editor);
    setCommandDraft((draft) => ({ revision: draft.revision + 1, value: recalled }));
    return true;
  };

  const changePolicy = async (mode: InputPolicy): Promise<void> => {
    if (session === undefined || interaction === undefined) return;
    try {
      const next = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(session.id)}/interaction`,
        {
          body: {
            expectedVersion: interaction.version,
            generation: session.generation,
            mode,
          },
          method: "PUT",
        },
      );
      setInteraction(next);
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const decideApproval = async (
    approval: Approval,
    decision: "approve" | "deny",
  ): Promise<void> => {
    try {
      const decided = await api<Approval>(
        `/api/sessions/${encodeURIComponent(approval.sessionId)}/approvals/${encodeURIComponent(approval.id)}/decision`,
        {
          body: {
            decision,
            expectedVersion: approval.version,
            generation: approval.sessionGeneration,
            idempotencyKey: crypto.randomUUID(),
            reason: approvalReason,
          },
          method: "POST",
        },
      );
      setApprovals((current) =>
        current.map((candidate) => (candidate.id === decided.id ? decided : candidate)),
      );
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const closeSession = async (target: Session): Promise<void> => {
    const key = sessionTabKey(target);
    if (closingTabs.current.has(key)) return;
    closingTabs.current.add(key);
    setPendingTabCloses([...closingTabs.current]);
    try {
      // Historical BROKEN projections have no live PTY or Session lease to close.
      // Dismissing a tab is local presentation state, not deletion of durable history.
      if (target.status !== "BROKEN" && target.status !== "CLOSED") {
        const current = await api<Session>(`/api/sessions/${encodeURIComponent(target.id)}`);
        if (current.generation !== target.generation) {
          await refreshSessions();
          return;
        }
        if (
          ["STARTING", "RESERVED", "RUNNING"].includes(current.status) &&
          !window.confirm("Close this Session and stop its running process?")
        ) {
          return;
        }
        if (current.status !== "BROKEN" && current.status !== "CLOSED") {
          const closed = await api<Session>(`/api/sessions/${encodeURIComponent(target.id)}`, {
            body: { generation: target.generation },
            method: "DELETE",
          });
          setSessions((items) => items.map((item) => (item.id === closed.id ? closed : item)));
        }
      }
      const dismissed = dismissSessionTab(dismissedTabsRef.current, target);
      dismissedTabsRef.current = dismissed;
      setDismissedTabs(dismissed);
      try {
        window.localStorage.setItem(DISMISSED_TABS_KEY, JSON.stringify(dismissed));
      } catch {
        // Browser storage may be unavailable; keep this page's dismissal usable.
      }
      setSelectedId((current) =>
        selectedSessionTab(
          current,
          visibleSessionsRef.current,
          visibleSessionsRef.current.filter((item) => sessionTabKey(item) !== key),
        ),
      );
    } catch (reason) {
      setError(normalizeClientError(reason));
    } finally {
      closingTabs.current.delete(key);
      setPendingTabCloses([...closingTabs.current]);
    }
  };

  const forkSession = async (): Promise<void> => {
    if (session === undefined || checkpoint === undefined) return;
    if (checkpoint.stale && !staleAcknowledged) {
      setError({
        allowedNextActions: ["review_checkpoint", "acknowledge_stale_context"],
        code: "CHECKPOINT_STALE",
        details: { checkpointVersion: checkpoint.version, sourceStatus: checkpoint.sourceStatus },
        message: "Acknowledge that this rebuild uses the last completed READY checkpoint.",
        requestId: "browser-local",
        retryable: false,
      });
      return;
    }
    try {
      const requestScope = `${session.id}:${session.generation.toString()}:${checkpoint.version.toString()}:${checkpoint.contentHash}:${checkpoint.stale.toString()}`;
      let idempotencyKey = forkIdempotency.current.get(requestScope);
      if (idempotencyKey === undefined) {
        idempotencyKey = crypto.randomUUID();
        forkIdempotency.current.set(requestScope, idempotencyKey);
        if (forkIdempotency.current.size > 32) {
          const oldest = forkIdempotency.current.keys().next().value;
          if (oldest !== undefined) forkIdempotency.current.delete(oldest);
        }
      }
      const forked = await api<SessionForkResult>(
        `/api/sessions/${encodeURIComponent(session.id)}/fork`,
        {
          body: {
            allowStale: checkpoint.stale,
            expectedCheckpointVersion: checkpoint.version,
            generation: session.generation,
            idempotencyKey,
          },
          method: "POST",
        },
      );
      forkIdempotency.current.delete(requestScope);
      await refreshSessions();
      setSelectedId(forked.session.id);
      setStaleAcknowledged(false);
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const resizeTerminal = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    fitEnabled.current = false;
    fitController.current?.suspend();
    setAutoFit(false);
    if (session === undefined || screen === undefined) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}/resize`, {
        body: {
          columns: Number.parseInt(resizeColumns, 10),
          expectedGeometryVersion: screen.geometryVersion,
          generation: session.generation,
          idempotencyKey: crypto.randomUUID(),
          rows: Number.parseInt(resizeRows, 10),
        },
        method: "POST",
      });
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const actorLabel = useMemo(
    () => bootstrap?.actor.id.replace("human_console_", "human:"),
    [bootstrap?.actor.id],
  );

  const interruptUnknownInput = (): void => {
    const current = latestSession.current;
    const target = current === undefined ? undefined : rawInputTargetFromSession(current);
    if (
      session === undefined ||
      target === undefined ||
      current?.id !== session.id ||
      current.generation !== session.generation ||
      current.activeExecutionId !== target.executionId
    ) {
      setError({
        allowedNextActions: ["refresh_session", "target_current_execution"],
        code: "EXECUTION_CHANGED",
        details: {},
        message: "The active Execution changed; refresh before interrupting.",
        requestId: crypto.randomUUID(),
        retryable: false,
      });
      return;
    }
    void sendControl("CTRL_C", target, false);
  };

  const toggleInspector = (view: InspectorView): void => {
    if (inspectorOpen && inspectorView === view) {
      setInspectorOpen(false);
      return;
    }
    setInspectorView(view);
    setInspectorOpen(true);
  };

  const selectInputMode = (mode: InputMode): void => {
    if (mode === "line") {
      const previous = rawInputTarget.current;
      const droppedPending = cancelPendingRawInput("Line input was selected");
      setRawInput(false);
      rawInputState.current = false;
      rawInputTarget.current = undefined;
      setInteractive(false);
      interactiveState.current = false;
      terminal.current?.blur();
      releaseGuardAfterPendingInput();
      if (!droppedPending) {
        setInputModeNotice(
          previous === undefined
            ? "Line input is active. The local draft is retained and was not sent."
            : `Line input is active for ${rawInputTargetLabel(activeRawInputTarget)}. The local draft is retained and was not sent.`,
        );
      }
      return;
    }

    const target = rawInputTargetFromSession(latestSession.current);
    if (target === undefined) {
      setInputModeNotice("Raw keys require an active foreground Execution.");
      return;
    }
    if (secureInputVisible || sensitiveInput?.status === "ACTIVE") {
      setInputModeNotice(
        "Raw keys are unavailable while protected input is active. Use the protected input control.",
      );
      return;
    }
    setRawInput(true);
    rawInputState.current = true;
    rawInputTarget.current = target;
    pendingRawResetTarget.current = undefined;
    setInteractive(false);
    interactiveState.current = false;
    terminal.current?.blur();
    setInputModeNotice(
      `Raw keys are armed only for ${rawInputTargetLabel(target)}. Click the terminal to focus it before sending keys.`,
    );
  };

  const selectSession = (candidate: Session): void => {
    if (candidate.id === selectedId) return;
    const previous = rawInputTarget.current;
    if (previous !== undefined || rawInputState.current) {
      const droppedPending = cancelPendingRawInput("the selected Session changed");
      setRawInput(false);
      rawInputState.current = false;
      rawInputTarget.current = undefined;
      pendingRawResetTarget.current =
        rawInputTargetFromSession(candidate) === undefined ? previous : undefined;
      setInteractive(false);
      interactiveState.current = false;
      terminal.current?.blur();
      releaseGuardAfterPendingInput();
      setInputModeNotice(
        `Raw keys reset to Line input because the Session changed. Previous: ${rawInputTargetLabel(previous)}. Selected: ${rawInputTargetLabel(rawInputTargetFromSession(candidate))}.${droppedPending ? " A pending raw key batch was dropped and was not sent." : ""}`,
      );
    }
    setSelectedId(candidate.id);
  };

  const localUncertaintyIsCurrent =
    localInputUncertainty !== undefined &&
    session?.id === localInputUncertainty.sessionId &&
    session.generation === localInputUncertainty.generation &&
    session.activeExecutionId === localInputUncertainty.executionId;
  const controlOutcomeIsCurrent =
    controlOutcome !== undefined &&
    session?.id === controlOutcome.sessionId &&
    session.generation === controlOutcome.generation;

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">HUMAN × AGENT / ONE LIVE SHELL</p>
          <h1>iTerminal</h1>
        </div>
        <div className="masthead-actions">
          <div className="connection" aria-live="polite">
            <span className={`signal signal-${streamState}`} />
            <span>{streamState}</span>
            <code>{actorLabel ?? "initializing"}</code>
            <span
              title={
                bootstrap?.runtimeCompatibility.status === "legacy" ||
                bootstrap?.runtimeCompatibility === undefined
                  ? "Runtime capability handshake unavailable"
                  : `Runtime protocol ${bootstrap.runtimeCompatibility.capabilities.protocolVersion}, build ${bootstrap.runtimeCompatibility.capabilities.buildId}`
              }
            >
              runtime {bootstrap?.runtimeCompatibility.status ?? "negotiating"}
            </span>
          </div>
          <nav aria-label="Console tools" className="console-tools">
            <button
              aria-expanded={inspectorOpen && inspectorView === "mcp"}
              className={inspectorOpen && inspectorView === "mcp" ? "active" : undefined}
              onClick={() => toggleInspector("mcp")}
              type="button"
            >
              Connect MCP
            </button>
            <button
              aria-expanded={inspectorOpen && inspectorView === "approvals"}
              className={`${inspectorOpen && inspectorView === "approvals" ? "active " : ""}${pendingApprovalCount > 0 ? "attention" : ""}`.trim()}
              onClick={() => toggleInspector("approvals")}
              type="button"
            >
              Approvals{" "}
              <span>
                {inboxPartial || inboxCursor ? "At least " : ""}
                {pendingApprovalCount}
                {inboxPartial ? " · partial" : ""}
              </span>
            </button>
            <button
              aria-expanded={inspectorOpen && inspectorView === "session"}
              className={inspectorOpen && inspectorView === "session" ? "active" : undefined}
              disabled={session === undefined}
              onClick={() => toggleInspector("session")}
              type="button"
            >
              Session
            </button>
            <button
              aria-expanded={inspectorOpen && inspectorView === "advanced"}
              className={inspectorOpen && inspectorView === "advanced" ? "active" : undefined}
              disabled={session === undefined}
              onClick={() => toggleInspector("advanced")}
              type="button"
            >
              Advanced
            </button>
          </nav>
        </div>
      </header>

      <section className={`workspace-grid${inspectorOpen ? " inspector-open" : ""}`}>
        <section className="terminal-stage" aria-label="Shared terminal">
          <nav aria-label="Sessions" className="session-tabs">
            <div className="session-tab-strip">
              {visibleSessions.map((candidate, index) => (
                <div className="session-tab-item" key={sessionTabKey(candidate)}>
                  <button
                    aria-current={candidate.id === selectedId ? "page" : undefined}
                    className={candidate.id === selectedId ? "session-tab selected" : "session-tab"}
                    onClick={() => selectSession(candidate)}
                    title={`${candidate.shell} · ${candidate.workspaceRoot} · ${candidate.status}`}
                    type="button"
                  >
                    <span
                      className={`session-tab-signal status-${candidate.status.toLowerCase()}`}
                    />
                    <span className="session-tab-name">
                      {sessionLabels[candidate.id] ||
                        candidate.workspaceRoot.split("/").filter(Boolean).pop() ||
                        "workspace"}{" "}
                      · {index + 1}
                    </span>
                    <small>{candidate.workspaceRoot}</small>
                  </button>
                  <button
                    aria-label={`Close ${candidate.shell} ${index + 1}`}
                    className="session-tab-close"
                    disabled={pendingTabCloses.includes(sessionTabKey(candidate))}
                    onClick={() => void closeSession(candidate)}
                    title={
                      candidate.status === "BROKEN"
                        ? "Remove broken tab; keep history"
                        : "Close Session"
                    }
                    type="button"
                  >
                    <span aria-hidden="true">
                      {pendingTabCloses.includes(sessionTabKey(candidate)) ? "…" : "×"}
                    </span>
                  </button>
                </div>
              ))}
            </div>
            <button
              aria-label="New Session"
              className="session-tab-add"
              disabled={creatingSession}
              onClick={() => {
                setNewSessionWorkspace(session?.workspaceRoot ?? "");
                setNewSessionFormOpen(true);
              }}
              title="New zsh Session"
              type="button"
            >
              {creatingSession ? "…" : "+"}
            </button>
          </nav>
          {newSessionFormOpen && (
            <form
              className="new-session-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createSession();
              }}
            >
              <label>
                Session name <small>(local only / not synced)</small>
                <input
                  value={newSessionName}
                  onChange={(event) => setNewSessionName(event.target.value)}
                />
              </label>
              <label>
                Workspace directory <strong aria-hidden="true">*</strong>
                <input
                  required
                  value={newSessionWorkspace}
                  onChange={(event) => setNewSessionWorkspace(event.target.value)}
                />
              </label>
              <button type="submit" disabled={creatingSession}>
                Create Session
              </button>
              <button type="button" onClick={() => setNewSessionFormOpen(false)}>
                Cancel
              </button>
            </form>
          )}
          <div className="terminal-toolbar">
            <div className="status-strip" aria-label="Session status">
              <span>
                Session <strong>{session?.status ?? "NONE"}</strong>
              </span>
              <span>Workspace {session?.workspaceRoot ?? "—"}</span>
              {checkpoint !== undefined && checkpoint.sessionId === session?.id && (
                <span>cwd {checkpoint.cwd}</span>
              )}
              <span>
                Input target:{" "}
                {session?.activeExecutionId === undefined ? "shell" : "shell/active execution"}
              </span>
              <Diagnostics
                generation={session?.generation}
                screenVersion={screen?.screenVersion ?? 0}
                columns={screen?.columns ?? SCREEN_COLUMNS}
                rows={screen?.rows ?? SCREEN_ROWS}
                geometryVersion={screen?.geometryVersion ?? 1}
                cursor={cursor}
                executionId={session?.activeExecutionId}
              />
              {(interaction?.inputContext?.state === "unknown"
                ? interaction.inputContext.unknownReason
                : localUncertaintyIsCurrent
                  ? localInputUncertainty.reason
                  : undefined) !== undefined && (
                <section className="input-uncertainty" aria-label="Input uncertainty" role="alert">
                  <span>
                    {describeInputUncertainty(
                      interaction?.inputContext?.state === "unknown"
                        ? (interaction.inputContext.unknownReason ?? "delivery")
                        : localUncertaintyIsCurrent
                          ? localInputUncertainty.reason
                          : "delivery",
                    )}
                  </span>
                  {(interaction?.inputContext?.state === "unknown"
                    ? interaction.inputContext.unknownReason
                    : localUncertaintyIsCurrent
                      ? localInputUncertainty.reason
                      : undefined) === "untracked_input" && (
                    <div className="input-uncertainty-actions">
                      <button
                        disabled={
                          sensitiveInput?.status === "ACTIVE" || session?.status !== "RUNNING"
                        }
                        onClick={() => selectInputMode("raw")}
                        type="button"
                      >
                        Raw keys
                      </button>
                      <button onClick={() => toggleInspector("session")} type="button">
                        View current Execution
                      </button>
                      <button
                        disabled={session?.status !== "RUNNING"}
                        onClick={interruptUnknownInput}
                        type="button"
                      >
                        Interrupt (Ctrl-C)
                      </button>
                    </div>
                  )}
                </section>
              )}
              {controlOutcomeIsCurrent && (
                <small className="control-outcome" role="status">
                  Control Action {controlOutcome.id} returned {controlOutcome.status} for Session{" "}
                  {controlOutcome.sessionId}, generation {controlOutcome.generation}, Execution{" "}
                  {controlOutcome.executionId}.
                </small>
              )}
              {sensitiveInput?.status === "ACTIVE" && (
                <button
                  aria-label={
                    sensitiveInput.actor.id === bootstrap?.actor.id || session?.status === "READY"
                      ? "Sensitive input protection is active; stop protecting output"
                      : "Sensitive input protection is active in another Console session"
                  }
                  className="sensitive-indicator"
                  disabled={
                    sensitiveFinishing ||
                    (sensitiveInput.actor.id !== bootstrap?.actor.id && session?.status !== "READY")
                  }
                  onClick={() => void finishSecretInput("completed")}
                  title={
                    sensitiveInput.actor.id === bootstrap?.actor.id || session?.status === "READY"
                      ? "Sensitive input is protected. Click when the program can no longer echo it."
                      : "Sensitive input is protected by the Console session that started it."
                  }
                  type="button"
                >
                  {sensitiveFinishing ? "…" : "***"}
                </button>
              )}
            </div>
            {session?.status === "RUNNING" && activeRawInputTarget !== undefined && (
              <section
                aria-label="Foreground input mode"
                className="input-mode-bar"
                data-testid="input-mode-bar"
              >
                <div className="input-mode-target">
                  <strong>Foreground input</strong>
                  <span>
                    Target <code>{activeRawInputTarget.sessionId}</code> · generation{" "}
                    <code>{activeRawInputTarget.generation}</code> · Execution{" "}
                    <code>{activeRawInputTarget.executionId}</code>
                  </span>
                </div>
                <div aria-label="Input mode" className="input-mode-switch" role="group">
                  <button
                    aria-pressed={!rawInput}
                    onClick={() => selectInputMode("line")}
                    type="button"
                  >
                    Line input
                  </button>
                  <button
                    aria-pressed={rawInput}
                    disabled={secureInputVisible || sensitiveInput?.status === "ACTIVE"}
                    onClick={() => selectInputMode("raw")}
                    type="button"
                  >
                    Raw keys
                  </button>
                </div>
                <small className="input-mode-help">
                  {rawInput
                    ? interactive
                      ? "Terminal focused. Raw keys use controlled Input or Control Actions for this exact target."
                      : "Click the terminal to focus it. No key is sent while it is unfocused."
                    : "Draft stays local until Enter. Empty return requires Raw keys."}
                </small>
                {inputModeNotice !== undefined && (
                  <small className="input-mode-notice" role="status">
                    {inputModeNotice}
                  </small>
                )}
              </section>
            )}
            {submissionIntent.status !== "idle" && (
              <section
                aria-live="polite"
                className={`submission-intent submission-${submissionIntent.status}`}
                data-testid="submission-intent"
              >
                <div>
                  <strong>
                    {submissionIntent.payload.kind === "execute"
                      ? "Shell command"
                      : "Foreground line"}
                    {" submission: "}
                    {submissionIntent.status}
                  </strong>
                  <span>
                    Session {submissionIntent.sessionId}, generation {submissionIntent.generation}
                    {submissionIntent.executionId === undefined
                      ? ""
                      : `, execution ${submissionIntent.executionId}`}
                  </span>
                  {submissionIntent.status === "submitting" && (
                    <small>
                      One frozen request is in flight. Enter will not create another key or send it
                      again.
                    </small>
                  )}
                  {submissionIntent.status === "uncertain" && (
                    <>
                      <small>{submissionIntent.message}</small>
                      <small>
                        This identity exists only in this browser tab. Leaving or refreshing loses
                        the lookup identity; it does not recover or retry the submission.
                      </small>
                    </>
                  )}
                  {submissionIntent.status === "accepted" && (
                    <small>
                      Action {submissionIntent.actionId} was found with actual status{" "}
                      {submissionIntent.actionStatus}
                      {submissionIntent.executionStatus === undefined
                        ? ""
                        : `; Execution status ${submissionIntent.executionStatus}`}
                      . This is not proof that the program handled the input or that execution
                      succeeded.
                    </small>
                  )}
                  {submissionIntent.status === "rejected" && (
                    <small>
                      {submissionIntent.code}: {submissionIntent.message}. This request was
                      definitively rejected before a terminal write; edit the draft and press Enter
                      to create a new intent.
                    </small>
                  )}
                </div>
                {submissionIntent.status === "uncertain" && (
                  <button
                    disabled={submissionIntent.checking}
                    onClick={() => void reconcileSubmission()}
                    type="button"
                  >
                    {submissionIntent.checking ? "Checking…" : "Check result"}
                  </button>
                )}
                {(submissionIntent.status === "accepted" ||
                  submissionIntent.status === "rejected") && (
                  <button
                    onClick={() => transitionSubmissionIntent({ type: "dismiss" })}
                    type="button"
                  >
                    Dismiss
                  </button>
                )}
              </section>
            )}
            {persistencePartial && (
              <p role="status">
                Screen is live; durable timeline is catching up or temporarily unavailable.
              </p>
            )}
            {discoveryNotice && <p role="status">{discoveryNotice}</p>}
            {sessionsCursor && (
              <button
                type="button"
                disabled={navigation.loading}
                onClick={() => {
                  void navigation
                    .loadMore()
                    .catch((reason: unknown) => setError(normalizeClientError(reason)));
                }}
              >
                Load more sessions
              </button>
            )}
            {session?.liveAvailability && session.liveAvailability !== "available" && (
              <p role="status">
                Session availability: {session.liveAvailability}. Stored state is historical; live
                writes require the current owner.
              </p>
            )}
          </div>
          <div
            className="terminal-surface"
            onWheelCapture={(event) => {
              if (!historyOpen && event.deltaY < 0 && !event.ctrlKey) setHistoryOpen(true);
            }}
            onClick={(event) => {
              if (
                (session?.status !== "READY" && !foregroundLineVisible) ||
                commandEditor.current?.contains(event.target as Node) === true ||
                terminal.current?.hasSelection() === true
              ) {
                return;
              }
              commandEditor.current?.focus({ preventScroll: true });
              if (commandEditor.current !== null) placeCaretAtEnd(commandEditor.current);
            }}
            ref={terminalSurface}
          >
            {session && (
              <button
                className="history-toggle"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setHistoryOpen(true);
                }}
              >
                Browse history
              </button>
            )}
            {historyOpen && session && (
              <TerminalHistory
                key={`${session.id}:${session.generation}`}
                sessionId={session.id}
                generation={session.generation}
                onClose={() => setHistoryOpen(false)}
              />
            )}
            <div
              aria-label={`Canonical ${screen?.columns ?? SCREEN_COLUMNS} by ${screen?.rows ?? SCREEN_ROWS} terminal viewport`}
              aria-readonly={session?.status !== "RUNNING" || !rawInput}
              className={`terminal-host ${session?.status === "RUNNING" ? "terminal-running" : "terminal-readonly"}${interactive ? " interactive" : ""}`}
              onMouseDownCapture={(event) => {
                columnSelection.current = event.altKey;
              }}
              onCopyCapture={(event) => {
                const displayed = renderedCopyScreen.current;
                const view = terminal.current;
                if (displayed === undefined || view === undefined || columnSelection.current)
                  return;
                const text = terminalSelectionText(view, displayed);
                if (text === undefined || text === "") return;
                event.preventDefault();
                event.stopPropagation();
                event.clipboardData.setData("text/plain", text);
              }}
              onBlur={() => {
                setInteractive(false);
                interactiveState.current = false;
                const droppedPending = cancelPendingRawInput("the terminal lost explicit focus");
                if (!droppedPending && rawInputTarget.current !== undefined) {
                  setInputModeNotice(
                    `Raw keys remain armed only for ${rawInputTargetLabel(rawInputTarget.current)}, but the terminal is not focused and no key will be sent.`,
                  );
                }
                releaseGuardAfterPendingInput();
              }}
              onFocus={() => {
                if (
                  session?.status === "RUNNING" &&
                  (rawInput || sensitiveInput?.status === "ACTIVE")
                ) {
                  setInteractive(true);
                  interactiveState.current = true;
                  if (rawInput && rawInputTarget.current !== undefined) {
                    setInputModeNotice(
                      `Terminal is explicitly focused for Raw keys on ${rawInputTargetLabel(rawInputTarget.current)}.`,
                    );
                  }
                }
              }}
              ref={terminalHost}
              style={
                readyCommandVisible &&
                sensitiveInput?.status !== "ACTIVE" &&
                cursorComposerLayout !== undefined
                  ? { minHeight: cursorComposerLayout.top + commandEditorHeight + 16 }
                  : undefined
              }
              tabIndex={session?.status === "RUNNING" ? 0 : -1}
            />
            {readyCommandVisible &&
              sensitiveInput?.status !== "ACTIVE" &&
              cursorComposerLayout !== undefined && (
                <form
                  aria-label={
                    foregroundLineVisible ? "Foreground command line" : "Shell prompt command line"
                  }
                  className="terminal-cursor-composer terminal-command-composer"
                  onSubmit={(event) => void execute(event)}
                  style={{
                    height: Math.max(cursorComposerLayout.height, commandEditorHeight),
                    left: cursorComposerLayout.lineLeft,
                    lineHeight: `${cursorComposerLayout.height.toString()}px`,
                    top: cursorComposerLayout.top,
                    width: cursorComposerLayout.lineWidth,
                  }}
                >
                  <textarea
                    aria-label={
                      foregroundLineVisible
                        ? "Foreground command composer"
                        : "READY command composer"
                    }
                    aria-multiline="true"
                    autoCapitalize="off"
                    autoComplete="off"
                    autoFocus
                    className="command-editor"
                    onChange={(event) => {
                      commandHistoryNavigation.current.reset();
                      historyCaretRestore.current = false;
                      if (foregroundLineVisible && foregroundScope !== undefined) {
                        const value = event.currentTarget.value;
                        setForegroundDrafts((drafts) => ({
                          ...drafts,
                          [foregroundScope]: {
                            revision: (drafts[foregroundScope]?.revision ?? 0) + 1,
                            value,
                          },
                        }));
                      } else {
                        const value = event.currentTarget.value;
                        setCommandDraft((draft) => ({
                          revision: draft.revision + 1,
                          value,
                        }));
                      }
                    }}
                    onSelect={(event) => {
                      const editor = event.currentTarget;
                      const surface = terminalSurface.current;
                      if (surface !== null) {
                        window.requestAnimationFrame(() => {
                          if (editor.isConnected) revealCommandCaret(editor, surface);
                        });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (
                        foregroundLineVisible &&
                        event.ctrlKey &&
                        !event.metaKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        const control = ({ c: "CTRL_C", d: "CTRL_D", z: "CTRL_Z" } as const)[
                          event.key.toLowerCase() as "c" | "d" | "z"
                        ];
                        if (control !== undefined) {
                          event.preventDefault();
                          void sendControl(control);
                          return;
                        }
                      }
                      if (navigateCommandHistory(event)) return;
                      if (
                        event.key !== "Enter" ||
                        event.shiftKey ||
                        event.nativeEvent.isComposing
                      ) {
                        return;
                      }
                      event.preventDefault();
                      if (editorValue.trim() !== "") {
                        event.currentTarget.closest("form")?.requestSubmit();
                      } else if (foregroundLineVisible) {
                        setInputModeNotice(
                          "Line input does not send an empty return. Select Raw keys, click the terminal to focus it, then press Enter.",
                        );
                      }
                    }}
                    ref={commandEditor}
                    rows={1}
                    spellCheck={false}
                    style={{
                      textIndent: cursorComposerLayout.left - cursorComposerLayout.lineLeft,
                    }}
                    value={editorValue}
                    maxLength={foregroundLineVisible ? 64 * 1024 - 1 : 256 * 1024}
                    wrap="soft"
                  />
                </form>
              )}
            {secureInputVisible && cursorComposerLayout !== undefined && (
              <form
                aria-label="Secure terminal input"
                className="terminal-cursor-composer"
                onSubmit={(event) => void beginSecretInput(event)}
                style={{
                  height: cursorComposerLayout.height,
                  left: cursorComposerLayout.left,
                  lineHeight: `${cursorComposerLayout.height.toString()}px`,
                  top: cursorComposerLayout.top,
                  width: cursorComposerLayout.width,
                }}
              >
                <input
                  aria-label="Human-only secret input"
                  autoComplete="off"
                  autoFocus
                  className="secure-command-editor"
                  disabled={secretSubmitting}
                  onChange={(event) => setSecret(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setDismissedSecretPromptKey(secretPromptKey);
                    setSecret("");
                    terminal.current?.focus();
                  }}
                  ref={secretEditor}
                  spellCheck={false}
                  type="password"
                  value={secret}
                />
              </form>
            )}
          </div>
          <pre className="screen-reader-output" data-testid="screen-reader-output">
            {screen?.lines.join("\n") ?? ""}
          </pre>
          <pre
            aria-hidden="true"
            className="screen-reader-output"
            data-testid="browser-terminal-output"
          >
            {browserTerminalMirror}
          </pre>
        </section>

        {inspectorOpen && (
          <aside className="inspector" aria-label="Console side panel">
            <div className="inspector-header">
              <strong>{INSPECTOR_TITLES[inspectorView]}</strong>
              <button
                aria-label="Close side panel"
                className="icon-button"
                onClick={() => setInspectorOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>

            {inspectorView === "mcp" && bootstrap?.mcpConnection !== undefined && (
              <section className="mcp-connection" aria-label="MCP connection">
                <div className="section-title">
                  <h2>Agent connection</h2>
                  <span className="ready-badge">READY</span>
                </div>
                <p>
                  Paste this complete JSON into your MCP client. It already contains
                  <code> mcpServers.{bootstrap.mcpConnection.serverName}</code>.
                </p>
                <details>
                  <summary>Preview complete JSON</summary>
                  <pre className="mcp-config-json">{bootstrap.mcpConnection.configJson}</pre>
                </details>
                <button onClick={() => void copyMcpConfig()} type="button">
                  {mcpConfigCopied ? "Complete JSON copied" : "Copy complete MCP JSON"}
                </button>
                <small>
                  References a private credential file renewed by this local stack. Keep the stack
                  running; the file path is specific to this machine.
                </small>
              </section>
            )}

            {inspectorView === "approvals" && (
              <section className="approval-panel" aria-label="Agent Execute approvals">
                <div className="section-title">
                  <h2>Approvals</h2>
                  <span>
                    {inboxPartial || inboxCursor ? "At least " : ""}
                    {pendingApprovalCount}
                    {inboxPartial ? " · partial" : ""}
                  </span>
                </div>
                {inbox.canLoadMore && (
                  <button type="button" disabled={inbox.loading} onClick={inbox.loadMore}>
                    Load more approvals
                  </button>
                )}
                {pendingApprovalCount > 0 && (
                  <label>
                    Decision reason
                    <input
                      maxLength={512}
                      onChange={(event) => setApprovalReason(event.target.value)}
                      required
                      value={approvalReason}
                    />
                  </label>
                )}
                {displayApprovals.length === 0 ? (
                  <div className="panel-empty-state">
                    <strong>No commands need your attention.</strong>
                    <span>This panel opens automatically when an Agent requests approval.</span>
                  </div>
                ) : (
                  <ol className="approval-list">
                    {displayApprovals.map((approval) => (
                      <li key={approval.id}>
                        <button type="button" onClick={() => setSelectedId(approval.sessionId)}>
                          Open session {approval.sessionId.slice(-8)}
                        </button>
                        <div className="section-title">
                          <strong>{approval.status}</strong>
                          <small>{formatTime(approval.expiresAt)}</small>
                        </div>
                        <code>{approval.command}</code>
                        <small>
                          {actorName(approval.requester)} · {approval.reason}
                        </small>
                        {approval.status === "PENDING" && (
                          <div>
                            <button
                              disabled={approvalReason.trim() === ""}
                              onClick={() => void decideApproval(approval, "approve")}
                              type="button"
                            >
                              Approve once
                            </button>
                            <button
                              disabled={approvalReason.trim() === ""}
                              onClick={() => void decideApproval(approval, "deny")}
                              type="button"
                            >
                              Deny
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            {inspectorView === "session" && (
              <>
                <section className="checkpoint-panel" aria-label="Shell checkpoint and rebuild">
                  <div className="section-title">
                    <h2>{session?.status === "BROKEN" ? "Recover Session" : "Fork Session"}</h2>
                    <span>
                      {checkpoint === undefined ? "—" : `v${checkpoint.version.toString()}`}
                    </span>
                  </div>
                  {checkpoint === undefined ? (
                    <p className="mode-note">No rebuildable checkpoint is available.</p>
                  ) : (
                    <>
                      <dl className="facts">
                        <dt>Source</dt>
                        <dd>{checkpoint.sourceStatus}</dd>
                        <dt>Age</dt>
                        <dd>{formatAge(checkpoint.ageMilliseconds)}</dd>
                        <dt>cwd</dt>
                        <dd className="fact-path">{checkpoint.cwd}</dd>
                        <dt>Environment</dt>
                        <dd>{checkpoint.environmentKeys.join(", ") || "none"}</dd>
                      </dl>
                      <p className="checkpoint-warning">
                        This starts a new shell from the last safe boundary. Running programs,
                        editors, jobs, aliases, functions, and open connections are not copied.
                        Workspace files remain shared.
                      </p>
                      {checkpoint.stale && (
                        <label className="stale-acknowledgement">
                          <input
                            checked={staleAcknowledged}
                            onChange={(event) => setStaleAcknowledged(event.target.checked)}
                            type="checkbox"
                          />
                          I understand this uses the last completed READY boundary, not the lost or
                          running foreground state.
                        </label>
                      )}
                      {session !== undefined && session.status !== "CLOSED" && (
                        <button
                          disabled={checkpoint.stale && !staleAcknowledged}
                          onClick={() => void forkSession()}
                          type="button"
                        >
                          {session.status === "BROKEN"
                            ? "Rebuild new Session from checkpoint"
                            : "Fork new Session from checkpoint"}
                        </button>
                      )}
                    </>
                  )}
                </section>
                {session !== undefined && session.status !== "CLOSED" && (
                  <button
                    className="danger"
                    disabled={pendingTabCloses.includes(sessionTabKey(session))}
                    onClick={() => void closeSession(session)}
                    type="button"
                  >
                    {session.status === "BROKEN" ? "Remove tab" : "Close Session"}
                  </button>
                )}
              </>
            )}

            {inspectorView === "advanced" && (
              <>
                <section aria-label="Advanced interaction settings">
                  <p className="mode-note">
                    Foreground Line input / Raw keys is controlled in the main terminal area and is
                    fenced to the displayed Execution target. This panel retains ownership policy,
                    geometry, and diagnostic controls.
                  </p>
                  <div className="section-title">
                    <h2>Input ownership</h2>
                    <span>v{interaction?.version ?? "—"}</span>
                  </div>
                  <label>
                    Input policy
                    <select
                      disabled={interaction === undefined}
                      onChange={(event) => void changePolicy(event.target.value as InputPolicy)}
                      value={interaction?.policy ?? "human_guarded"}
                    >
                      <option value="human_guarded">human_guarded</option>
                      <option value="common">common</option>
                      <option value="human_only">human_only</option>
                      <option value="agent_only">agent_only</option>
                    </select>
                  </label>
                  {interaction?.guard !== undefined && (
                    <dl className="facts interaction-guard">
                      <dt>Current owner</dt>
                      <dd>{interaction.guard.actor.id}</dd>
                      <dt>Expires</dt>
                      <dd>{formatTime(interaction.guard.expiresAt)}</dd>
                      <dt>Renewals</dt>
                      <dd>
                        {interaction.guard.renewals.toString()}/
                        {interaction.guard.maxRenewals.toString()}
                      </dd>
                    </dl>
                  )}
                </section>
                <section aria-label="Terminal geometry">
                  <div className="section-title">
                    <h2>Terminal size</h2>
                    <span>
                      {screen?.columns ?? SCREEN_COLUMNS}×{screen?.rows ?? SCREEN_ROWS}
                    </span>
                  </div>
                  <label className="checkpoint-acknowledgement">
                    <input
                      type="checkbox"
                      checked={autoFit}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        fitEnabled.current = enabled;
                        setAutoFit(enabled);
                        if (enabled) fitController.current?.activate();
                        else fitController.current?.suspend();
                      }}
                    />
                    Fit terminal to active window
                  </label>
                  {fitNotice !== undefined && (
                    <p className="mode-note" role="status">
                      {fitNotice}
                    </p>
                  )}
                  <form className="geometry-form" onSubmit={(event) => void resizeTerminal(event)}>
                    <label>
                      Columns
                      <input
                        disabled={screen === undefined}
                        max={bootstrap?.geometryBounds.maxColumns ?? 240}
                        min={bootstrap?.geometryBounds.minColumns ?? 40}
                        onChange={(event) => setResizeColumns(event.target.value)}
                        type="number"
                        value={resizeColumns}
                      />
                    </label>
                    <label>
                      Rows
                      <input
                        disabled={screen === undefined}
                        max={bootstrap?.geometryBounds.maxRows ?? 100}
                        min={bootstrap?.geometryBounds.minRows ?? 12}
                        onChange={(event) => setResizeRows(event.target.value)}
                        type="number"
                        value={resizeRows}
                      />
                    </label>
                    <button disabled={screen === undefined} type="submit">
                      Resize canonical PTY
                    </button>
                    <small>This changes the shared PTY for Human and Agent clients.</small>
                  </form>
                </section>
                <section className="timeline" aria-label="Raw activity timeline">
                  <div className="section-title">
                    <h2>Raw activity</h2>
                    <span>{timeline.length}</span>
                  </div>
                  <p className="mode-note">Technical events for diagnostics and audit.</p>
                  <ol>
                    {[...timeline].reverse().map((event) => (
                      <li key={event.id}>
                        <span>{event.sequence}</span>
                        <div>
                          <strong>{event.type}</strong>
                          <small>
                            {event.actor === undefined ? "runtime" : actorName(event.actor)}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </aside>
        )}
      </section>

      {error !== undefined && (
        <section className="error-banner" aria-live="assertive">
          <div>
            <strong>{error.code}</strong>
            <span>{error.message}</span>
            {error.allowedNextActions.length > 0 && (
              <small>Next: {error.allowedNextActions.join(" · ")}</small>
            )}
          </div>
          <button
            onClick={() =>
              void refreshSessions().catch((reason: unknown) =>
                setError(normalizeClientError(reason)),
              )
            }
            type="button"
          >
            Refresh sessions
          </button>
          <button onClick={() => setError(undefined)} type="button">
            Dismiss
          </button>
        </section>
      )}
    </main>
  );
}

function isDefiniteAdmissionRejection(reason: unknown): boolean {
  return reason instanceof ConsoleApiError && isDefiniteSubmissionRejectionCode(reason.body.code);
}

function identityOfIntent(
  intent: Exclude<SubmissionIntentState, { readonly status: "idle" }>,
): SubmissionIntentIdentity {
  return {
    draftRevision: intent.draftRevision,
    ...(intent.executionId === undefined ? {} : { executionId: intent.executionId }),
    generation: intent.generation,
    idempotencyKey: intent.idempotencyKey,
    payload: intent.payload,
    sessionId: intent.sessionId,
  };
}

function placeCaretAtEnd(element: HTMLTextAreaElement): void {
  element.setSelectionRange(element.value.length, element.value.length);
}

function syncCursorComposerLayout(
  host: HTMLDivElement | null,
  surface: HTMLDivElement | null,
  screen: ScreenSnapshot,
  setLayout: React.Dispatch<React.SetStateAction<CursorComposerLayout | undefined>>,
): void {
  if (host === null || surface === null) return;
  const xtermScreen = host.querySelector<HTMLElement>(".xterm-screen");
  if (xtermScreen === null) return;
  const screenRect = xtermScreen.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0) return;
  const cellWidth = screenRect.width / screen.columns;
  const cellHeight = screenRect.height / screen.rows;
  const lineLeft = screenRect.left - surfaceRect.left + surface.scrollLeft;
  const lineWidth = Math.max(
    cellWidth,
    Math.min(
      screenRect.width,
      surface.clientWidth - lineLeft - parseFloat(getComputedStyle(host).paddingRight),
    ),
  );
  const left = lineLeft + screen.cursor.column * cellWidth;
  const top = screenRect.top - surfaceRect.top + surface.scrollTop + screen.cursor.row * cellHeight;
  const next = {
    height: cellHeight,
    left,
    lineLeft,
    lineWidth,
    top,
    width: Math.max(cellWidth, lineLeft + lineWidth - left),
  };
  setLayout((current) =>
    current !== undefined &&
    Math.abs(current.height - next.height) < 0.1 &&
    Math.abs(current.left - next.left) < 0.1 &&
    Math.abs(current.lineLeft - next.lineLeft) < 0.1 &&
    Math.abs(current.lineWidth - next.lineWidth) < 0.1 &&
    Math.abs(current.top - next.top) < 0.1 &&
    Math.abs(current.width - next.width) < 0.1
      ? current
      : next,
  );
}

function commandCaretPosition(editor: HTMLTextAreaElement): { row: number; lineHeight: number } {
  // A textarea's own scrollTop cannot reveal a caret below the terminal scrollport.
  // Mirror only the non-secret READY draft to locate the selection's visual line.
  const style = getComputedStyle(editor);
  const mirror = document.createElement("div");
  for (const property of [
    "font",
    "line-height",
    "letter-spacing",
    "text-indent",
    "tab-size",
    "white-space",
    "overflow-wrap",
    "word-break",
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    top: "0",
    left: "-100000px",
    width: `${editor.clientWidth.toString()}px`,
    padding: "0",
    border: "0",
  });
  mirror.setAttribute("aria-hidden", "true");
  const caretIndex =
    editor.selectionDirection === "backward" ? editor.selectionStart : editor.selectionEnd;
  mirror.textContent = editor.value.slice(0, caretIndex);
  const caret = document.createElement("span");
  caret.textContent = "\u200b";
  mirror.append(caret);
  document.body.append(mirror);
  const lineHeight = parseFloat(style.lineHeight);
  const row = Math.floor(
    (caret.getBoundingClientRect().top - mirror.getBoundingClientRect().top) / lineHeight,
  );
  mirror.remove();
  return { row, lineHeight };
}

function revealCommandCaret(editor: HTMLTextAreaElement, surface: HTMLDivElement): void {
  if (document.activeElement !== editor) return;
  const { row, lineHeight } = commandCaretPosition(editor);
  const caretTop = editor.getBoundingClientRect().top + row * lineHeight;
  const viewportTop = surface.getBoundingClientRect().top;
  const viewportBottom = viewportTop + surface.clientHeight;
  if (caretTop < viewportTop + 8) surface.scrollTop -= viewportTop + 8 - caretTop;
  else if (caretTop + lineHeight > viewportBottom - 8)
    surface.scrollTop += caretTop + lineHeight - viewportBottom + 8;
  surface.scrollLeft = 0;
}

function detectSecretPromptKey(
  session: Session | undefined,
  screen: ScreenSnapshot | undefined,
): string | undefined {
  if (session?.status !== "RUNNING" || screen === undefined) return undefined;
  const line = screen.lines[screen.cursor.row] ?? "";
  const beforeCursor = line.slice(0, screen.cursor.column).trimEnd();
  if (!/(?:\b(?:password|passphrase)\b|密码|口令)[^:\n：]{0,160}[:：]\s*$/iu.test(beforeCursor)) {
    return undefined;
  }
  return [
    session.id,
    session.generation.toString(),
    session.activeExecutionId ?? "none",
    screen.cursor.row.toString(),
    screen.cursor.column.toString(),
    beforeCursor,
  ].join(":");
}

function mergeEvents(
  current: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): readonly SessionEvent[] {
  const merged = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) merged.set(event.id, event);
  return [...merged.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_TIMELINE_EVENTS);
}

function resumeKey(sessionId: string, generation: number): string {
  return `iterminal.resume.${sessionId}.${generation.toString()}`;
}

function readResume(sessionId: string, generation: number): ResumeState | undefined {
  const raw = sessionStorage.getItem(resumeKey(sessionId, generation));
  if (raw === null) return undefined;
  try {
    const candidate = JSON.parse(raw) as Partial<ResumeState>;
    if (
      !Number.isSafeInteger(candidate.cursor) ||
      !Number.isSafeInteger(candidate.screenVersion) ||
      !Array.isArray(candidate.events)
    ) {
      return undefined;
    }
    return candidate as ResumeState;
  } catch {
    return undefined;
  }
}

function requiredExecution(session: Session): string {
  if (session.activeExecutionId === undefined) throw new Error("No active Execution");
  return session.activeExecutionId;
}

function rawInputTargetFromSession(session: Session | undefined): RawInputTarget | undefined {
  if (session?.status !== "RUNNING" || session.activeExecutionId === undefined) return undefined;
  return {
    executionId: session.activeExecutionId,
    generation: session.generation,
    sessionId: session.id,
  };
}

function actorName(actor: Actor): string {
  return `${actor.type}:${actor.id.replace(/^human_console_/, "")}`;
}

function formatTime(value: string | undefined): string {
  if (value === undefined) return "—";
  return new Date(value).toLocaleTimeString();
}

function formatAge(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 1_000) return "just now";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds.toString()}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes.toString()}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours.toString()}h`;
  return `${Math.floor(hours / 24).toString()}d`;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Console root element is missing");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
