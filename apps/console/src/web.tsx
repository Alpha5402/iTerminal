import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { Terminal } from "@xterm/xterm";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type SessionStatus = "STARTING" | "READY" | "RESERVED" | "RUNNING" | "BROKEN" | "CLOSED";
type InputPolicy = "common" | "human_guarded" | "human_only" | "agent_only";

interface Actor {
  readonly client: string;
  readonly id: string;
  readonly principal: string;
  readonly type: "human" | "agent" | "scheduler" | "system";
}

interface Session {
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
}

interface Approval {
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
  readonly columns: number;
  readonly cursor: { readonly column: number; readonly row: number };
  readonly geometryVersion: number;
  readonly lines: readonly string[];
  readonly rows: number;
  readonly screenVersion: number;
}

interface SessionEvent {
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
  readonly sessions: readonly Session[];
}

interface ApiErrorBody {
  readonly allowedNextActions: readonly string[];
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
}

interface StreamFrame {
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
const DEFAULT_SESSION_WORKSPACE = "/";

interface ResumeState {
  readonly cursor: number;
  readonly events: readonly SessionEvent[];
  readonly screenVersion: number;
}

interface CursorComposerLayout {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [sessions, setSessions] = useState<readonly Session[]>([]);
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
  const [secureInputRequested, setSecureInputRequested] = useState(false);
  const [dismissedSecretPromptKey, setDismissedSecretPromptKey] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const latestCursor = useRef(0);
  const [streamState, setStreamState] = useState<"offline" | "connecting" | "live" | "gap">(
    "offline",
  );
  const [error, setError] = useState<ApiErrorBody>();
  const [command, setCommand] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [mcpConfigCopied, setMcpConfigCopied] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [resizeColumns, setResizeColumns] = useState(SCREEN_COLUMNS.toString());
  const [resizeRows, setResizeRows] = useState(SCREEN_ROWS.toString());
  const [browserTerminalMirror, setBrowserTerminalMirror] = useState("");
  const [cursorComposerLayout, setCursorComposerLayout] = useState<CursorComposerLayout>();
  const interactiveState = useRef(false);
  const commandEditor = useRef<HTMLTextAreaElement>(null);
  const secretEditor = useRef<HTMLInputElement>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalSurface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectAttempt = useRef(0);
  const createIdempotency = useRef<
    { readonly key: string; readonly signature: string } | undefined
  >(undefined);
  const forkIdempotency = useRef(new Map<string, string>());
  const latestSession = useRef<Session | undefined>(undefined);
  const latestInteraction = useRef<InteractionState | undefined>(undefined);
  const latestScreen = useRef<ScreenSnapshot | undefined>(undefined);
  const guardReleaseTimer = useRef<number | undefined>(undefined);
  const guardTask = useRef<Promise<void>>(Promise.resolve());
  const inputBuffer = useRef("");
  const inputTimer = useRef<number | undefined>(undefined);
  const selectedGeneration = sessions.find((candidate) => candidate.id === selectedId)?.generation;
  const approvalRevision = timeline.findLast((event) =>
    event.type.startsWith("approval."),
  )?.sequence;
  const sensitiveInputRevision = timeline.findLast((event) =>
    event.type.startsWith("sensitive_input."),
  )?.sequence;
  const secretPromptKey = detectSecretPromptKey(session, screen);
  const secureInputVisible =
    session?.status === "RUNNING" &&
    sensitiveInput?.status !== "ACTIVE" &&
    (secureInputRequested ||
      (secretPromptKey !== undefined && secretPromptKey !== dismissedSecretPromptKey));
  const cursorComposerRequested = session?.status === "READY" || secureInputVisible;
  const commandEditorRows = Math.min(6, Math.max(1, command.split("\n").length));

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
    latestCursor.current = cursor;
  }, [cursor]);
  useEffect(() => {
    interactiveState.current = interactive;
  }, [interactive]);
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

  const refreshSessions = useCallback(async (): Promise<void> => {
    const next = await api<readonly Session[]>("/api/sessions");
    setSessions(next);
    if (selectedId !== undefined && !next.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [selectedId]);

  useEffect(() => {
    void api<Bootstrap>("/api/bootstrap")
      .then((value) => {
        setBootstrap(value);
        setSessions(value.sessions);
        setSelectedId(value.sessions.find((candidate) => candidate.status !== "CLOSED")?.id);
      })
      .catch((reason: unknown) => setError(normalizeClientError(reason)));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshSessions().catch((reason: unknown) => setError(normalizeClientError(reason)));
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [refreshSessions]);

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
      if (data === "\u0003") {
        void sendControl("CTRL_C");
        return;
      }
      if (data === "\u0004") {
        void sendControl("CTRL_D");
        return;
      }
      queueInput(data);
    });
    return () => {
      dataSubscription.dispose();
      instance.dispose();
      terminal.current = undefined;
    };
  }, [bootstrap?.actor.id]);

  useEffect(() => {
    if (terminal.current !== undefined && screen !== undefined) {
      renderScreen(terminal.current, screen, session?.status === "RUNNING", (text) => {
        setBrowserTerminalMirror(text);
        if (cursorComposerRequested) {
          window.requestAnimationFrame(() => {
            syncCursorComposerLayout(
              terminalHost.current,
              terminalSurface.current,
              screen,
              setCursorComposerLayout,
            );
          });
        }
      });
    }
  }, [cursorComposerRequested, screen, session?.status]);

  useEffect(() => {
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
    const frame = window.requestAnimationFrame(sync);
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    observer.observe(surface);
    host.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [cursorComposerRequested, screen]);

  const readyCommandVisible = session?.status === "READY" && cursorComposerLayout !== undefined;
  useEffect(() => {
    if (session?.status !== "READY" || !readyCommandVisible) return;
    const frame = window.requestAnimationFrame(() => {
      commandEditor.current?.focus();
      if (commandEditor.current !== null) placeCaretAtEnd(commandEditor.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [readyCommandVisible, session?.generation, session?.id, session?.status]);

  useEffect(() => {
    if (!secureInputVisible || cursorComposerLayout === undefined) return;
    terminal.current?.blur();
    setInteractive(false);
    const frame = window.requestAnimationFrame(() => secretEditor.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [cursorComposerLayout, secureInputVisible]);

  useEffect(() => {
    setDismissedSecretPromptKey(undefined);
    setSecureInputRequested(false);
    setSecret("");
  }, [session?.activeExecutionId, session?.generation, session?.id]);

  useEffect(() => {
    if (screen === undefined) return;
    setResizeColumns(screen.columns.toString());
    setResizeRows(screen.rows.toString());
  }, [screen?.columns, screen?.rows]);

  const applyStreamFrame = useCallback((frame: StreamFrame): void => {
    if (frame.error !== undefined) setError(frame.error);
    if (frame.type === "resync_required") {
      setStreamState("gap");
      return;
    }
    if (frame.session !== undefined) {
      const nextSession = frame.session;
      setSession(nextSession);
      setSessions((current) =>
        current.map((candidate) => (candidate.id === nextSession.id ? nextSession : candidate)),
      );
    }
    if (frame.interaction !== undefined) setInteraction(frame.interaction);
    if (frame.screen !== undefined) setScreen(frame.screen);
    if (frame.events !== undefined) {
      setTimeline((current) => mergeEvents(current, frame.events ?? []));
    }
    if (frame.cursor !== undefined) setCursor(frame.cursor);
    setStreamState(frame.liveGap === undefined && frame.eventGap === undefined ? "live" : "gap");
  }, []);

  useEffect(() => {
    if (selectedId === undefined) {
      setSession(undefined);
      setInteraction(undefined);
      setScreen(undefined);
      setTimeline([]);
      setCursor(0);
      setStreamState("offline");
      return;
    }
    const selected = sessions.find((candidate) => candidate.id === selectedId);
    if (selected === undefined) return;
    setError(undefined);
    const saved = readResume(selected.id, selected.generation);
    setSession(selected);
    setInteraction(undefined);
    setScreen(undefined);
    latestScreen.current = undefined;
    terminal.current?.reset();
    setBrowserTerminalMirror("");
    setCursor(saved?.cursor ?? 0);
    latestCursor.current = saved?.cursor ?? 0;
    setTimeline(saved?.events ?? []);
    setCheckpoint(undefined);
    setStaleAcknowledged(false);
    setCommand("");
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
    const connect = (): void => {
      if (disposed) return;
      setStreamState("connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const priorScreen = latestScreen.current?.screenVersion ?? saved?.screenVersion;
      const query = new URLSearchParams({
        after: latestCursor.current.toString(),
        generation: selected.generation.toString(),
        ...(priorScreen === undefined ? {} : { afterScreenVersion: priorScreen.toString() }),
      });
      const next = new WebSocket(
        `${protocol}//${location.host}/api/sessions/${encodeURIComponent(selected.id)}/stream?${query.toString()}`,
      );
      socket.current = next;
      next.onopen = () => {
        reconnectAttempt.current = 0;
      };
      next.onmessage = (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as StreamFrame;
          applyStreamFrame(frame);
          if (frame.cursor !== undefined && frame.screen !== undefined) {
            next.send(
              JSON.stringify({
                cursor: frame.cursor,
                screenVersion: frame.screen.screenVersion,
                type: "ack",
              }),
            );
          }
        } catch (reason) {
          setError(normalizeClientError(reason));
        }
      };
      next.onclose = () => {
        if (disposed) return;
        setStreamState("offline");
        const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt.current);
        reconnectAttempt.current += 1;
        reconnectTimer.current = window.setTimeout(connect, delay);
      };
      next.onerror = () => setStreamState("offline");
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer.current !== undefined) window.clearTimeout(reconnectTimer.current);
      socket.current?.close(1000, "session changed");
      socket.current = undefined;
    };
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
    if (session === undefined || session.status === "CLOSED") {
      setApprovals([]);
      return;
    }
    let disposed = false;
    void api<readonly Approval[]>(
      `/api/sessions/${encodeURIComponent(session.id)}/approvals?generation=${session.generation.toString()}`,
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
  }, [approvalRevision, session?.generation, session?.id, session?.status]);

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
    if (terminal.current !== undefined) terminal.current.options.disableStdin = !running;
    if (!running) setInteractive(false);
  }, [session?.status]);

  const queueInput = (data: string): void => {
    inputBuffer.current += data;
    if (inputTimer.current !== undefined) return;
    inputTimer.current = window.setTimeout(() => {
      inputTimer.current = undefined;
      const batch = inputBuffer.current;
      inputBuffer.current = "";
      guardTask.current = guardTask.current
        .then(async () => {
          await ensureGuard();
          const currentSession = requiredRunningSession();
          await api(`/api/sessions/${encodeURIComponent(currentSession.id)}/input`, {
            body: {
              data: batch,
              generation: currentSession.generation,
              idempotencyKey: crypto.randomUUID(),
              targetExecutionId: requiredExecution(currentSession),
            },
            method: "POST",
          });
          scheduleGuardRelease();
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
      setSensitiveInput(
        await api<SensitiveInput>(
          `/api/sessions/${encodeURIComponent(currentSession.id)}/secret-input?generation=${currentSession.generation.toString()}`,
        ),
      );
      setSecureInputRequested(false);
    } catch (reason) {
      setError(normalizeClientError(reason));
    } finally {
      setSecretSubmitting(false);
    }
  };

  const finishSecretInput = async (outcome: "completed" | "cancelled"): Promise<void> => {
    if (session === undefined || sensitiveInput === undefined) return;
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
      setError(normalizeClientError(reason));
    }
  };

  const ensureGuard = async (): Promise<void> => {
    const currentSession = requiredRunningSession();
    let state = latestInteraction.current;
    if (state === undefined) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction?generation=${currentSession.generation.toString()}`,
      );
      setInteraction(state);
    }
    if (state.policy !== "human_guarded") return;
    const ownGuard = state.guard?.actor.id === bootstrap?.actor.id;
    if (state.guard !== undefined && !ownGuard) {
      throw new Error(`INPUT_GUARDED: ${state.guard.actor.id}`);
    }
    if (state.guard !== undefined && Date.parse(state.guard.expiresAt) - Date.now() < 200) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction?generation=${currentSession.generation.toString()}`,
      );
      setInteraction(state);
      latestInteraction.current = state;
    }
    if (state.guard !== undefined && state.guard.actor.id !== bootstrap?.actor.id) {
      throw new Error(`INPUT_GUARDED: ${state.guard.actor.id}`);
    }
    if (state.guard === undefined) {
      state = await api<InteractionState>(
        `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction/guard`,
        {
          body: {
            expectedVersion: state.version,
            generation: currentSession.generation,
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
        `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction/guard`,
        {
          body: {
            expectedVersion: state.version,
            generation: currentSession.generation,
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
      `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction/guard`,
      {
        body: {
          expectedVersion: released.version,
          generation: currentSession.generation,
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

  const sendControl = async (control: "CTRL_C" | "CTRL_D" | "CTRL_Z" | "ESC"): Promise<void> => {
    try {
      const current = requiredRunningSession();
      await api(`/api/sessions/${encodeURIComponent(current.id)}/control`, {
        body: {
          bypassGuard: false,
          delivery: { control, mode: "TTY_CONTROL" },
          generation: current.generation,
          idempotencyKey: crypto.randomUUID(),
          targetExecutionId: requiredExecution(current),
        },
        method: "POST",
      });
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const createSession = async (): Promise<void> => {
    if (creatingSession) return;
    const signature = JSON.stringify({
      shell: DEFAULT_SESSION_SHELL,
      workspaceRoot: DEFAULT_SESSION_WORKSPACE,
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
          workspaceRoot: DEFAULT_SESSION_WORKSPACE,
        },
        method: "POST",
      });
      createIdempotency.current = undefined;
      await refreshSessions();
      setSelectedId(created.id);
    } catch (reason) {
      setError(normalizeClientError(reason));
    } finally {
      setCreatingSession(false);
    }
  };

  const execute = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (session === undefined || command.trim() === "") return;
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}/execute`, {
        body: {
          command,
          generation: session.generation,
          idempotencyKey: crypto.randomUUID(),
        },
        method: "POST",
      });
      setCommand("");
    } catch (reason) {
      setError(normalizeClientError(reason));
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
    if (session === undefined) return;
    try {
      const decided = await api<Approval>(
        `/api/sessions/${encodeURIComponent(session.id)}/approvals/${encodeURIComponent(approval.id)}/decision`,
        {
          body: {
            decision,
            expectedVersion: approval.version,
            generation: session.generation,
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

  const closeSession = async (): Promise<void> => {
    if (session === undefined) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
        body: { generation: session.generation },
        method: "DELETE",
      });
      await refreshSessions();
    } catch (reason) {
      setError(normalizeClientError(reason));
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

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">HUMAN × AGENT / ONE LIVE SHELL</p>
          <h1>iTerminal</h1>
        </div>
        <div className="connection" aria-live="polite">
          <span className={`signal signal-${streamState}`} />
          <span>{streamState}</span>
          <code>{actorLabel ?? "initializing"}</code>
        </div>
      </header>

      <section className="workspace-grid">
        <section className="terminal-stage" aria-label="Shared terminal">
          <nav aria-label="Sessions" className="session-tabs">
            <div className="session-tab-strip">
              {sessions.map((candidate, index) => (
                <button
                  aria-current={candidate.id === selectedId ? "page" : undefined}
                  className={candidate.id === selectedId ? "session-tab selected" : "session-tab"}
                  key={candidate.id}
                  onClick={() => setSelectedId(candidate.id)}
                  title={`${candidate.shell} · ${candidate.workspaceRoot} · ${candidate.status}`}
                  type="button"
                >
                  <span className={`session-tab-signal status-${candidate.status.toLowerCase()}`} />
                  <span className="session-tab-name">
                    {candidate.shell} {index + 1}
                  </span>
                  <small>{candidate.workspaceRoot}</small>
                </button>
              ))}
            </div>
            <button
              aria-label="New Session"
              className="session-tab-add"
              disabled={creatingSession}
              onClick={() => void createSession()}
              title="New zsh Session at /"
              type="button"
            >
              {creatingSession ? "…" : "+"}
            </button>
          </nav>
          <div className="status-strip">
            <span>
              Session <strong>{session?.status ?? "NONE"}</strong>
            </span>
            <span>generation {session?.generation ?? "—"}</span>
            <span>screen v{screen?.screenVersion ?? 0}</span>
            <span>
              geometry {screen?.columns ?? SCREEN_COLUMNS}×{screen?.rows ?? SCREEN_ROWS} v
              {screen?.geometryVersion ?? 1}
            </span>
            <span>cursor {cursor}</span>
            {session?.activeExecutionId !== undefined && <code>{session.activeExecutionId}</code>}
          </div>
          <div
            className="terminal-surface"
            onClick={(event) => {
              if (
                session?.status !== "READY" ||
                commandEditor.current?.contains(event.target as Node) === true ||
                terminal.current?.hasSelection() === true
              ) {
                return;
              }
              commandEditor.current?.focus();
              if (commandEditor.current !== null) placeCaretAtEnd(commandEditor.current);
            }}
            ref={terminalSurface}
          >
            <div
              aria-label={`Canonical ${screen?.columns ?? SCREEN_COLUMNS} by ${screen?.rows ?? SCREEN_ROWS} terminal viewport`}
              aria-readonly={session?.status !== "RUNNING"}
              className={`terminal-host ${session?.status === "RUNNING" ? "terminal-running" : "terminal-readonly"}${interactive ? " interactive" : ""}`}
              onBlur={() => {
                setInteractive(false);
                releaseGuardAfterPendingInput();
              }}
              onFocus={() => {
                if (session?.status === "RUNNING") setInteractive(true);
              }}
              ref={terminalHost}
              tabIndex={session?.status === "RUNNING" ? 0 : -1}
            />
            {session?.status === "READY" &&
              sensitiveInput?.status !== "ACTIVE" &&
              cursorComposerLayout !== undefined && (
                <form
                  aria-label="Shell prompt command line"
                  className="terminal-cursor-composer terminal-command-composer"
                  onSubmit={(event) => void execute(event)}
                  style={{
                    height: cursorComposerLayout.height * commandEditorRows,
                    left: cursorComposerLayout.left,
                    lineHeight: `${cursorComposerLayout.height.toString()}px`,
                    top: Math.max(
                      0,
                      cursorComposerLayout.top -
                        cursorComposerLayout.height * (commandEditorRows - 1),
                    ),
                    width: cursorComposerLayout.width,
                  }}
                >
                  <textarea
                    aria-label="READY command composer"
                    aria-multiline="true"
                    autoCapitalize="off"
                    autoComplete="off"
                    autoFocus
                    className="command-editor"
                    onChange={(event) => setCommand(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Enter" ||
                        event.shiftKey ||
                        event.nativeEvent.isComposing
                      ) {
                        return;
                      }
                      event.preventDefault();
                      if (command.trim() !== "") {
                        event.currentTarget.closest("form")?.requestSubmit();
                      }
                    }}
                    ref={commandEditor}
                    rows={commandEditorRows}
                    spellCheck={false}
                    value={command}
                    wrap="off"
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
                    setSecureInputRequested(false);
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
          {(sensitiveInput?.status === "ACTIVE" ||
            (session?.status !== "READY" && !secureInputVisible)) && (
            <div className="mode-panel">
              {sensitiveInput?.status === "ACTIVE" ? (
                <div className="secret-channel active" aria-live="polite">
                  <strong>Sensitive output redaction is active.</strong>
                  <span>
                    Finish only after the foreground program can no longer echo the secret.
                  </span>
                  <div>
                    <button onClick={() => void sendControl("CTRL_C")} type="button">
                      Send TTY Ctrl+C while redacted
                    </button>
                    <button onClick={() => void finishSecretInput("completed")} type="button">
                      Complete and stop redaction
                    </button>
                    <button onClick={() => void finishSecretInput("cancelled")} type="button">
                      Cancel and stop redaction
                    </button>
                  </div>
                </div>
              ) : session?.status === "RUNNING" ? (
                <>
                  <div className="interactive-controls">
                    <button
                      aria-pressed={interactive}
                      onClick={() => {
                        if (interactive) {
                          terminal.current?.blur();
                          setInteractive(false);
                        } else {
                          terminal.current?.focus();
                          setInteractive(true);
                        }
                      }}
                      type="button"
                    >
                      {interactive ? "Leave interactive focus" : "Enter interactive focus"}
                    </button>
                    <button onClick={() => void sendControl("CTRL_C")} type="button">
                      Send TTY Ctrl+C
                    </button>
                    <button
                      onClick={() => {
                        setDismissedSecretPromptKey(undefined);
                        setSecureInputRequested(true);
                      }}
                      type="button"
                    >
                      Enter secure input at cursor
                    </button>
                    <span>Raw keys become 20 ms InputAction batches.</span>
                  </div>
                </>
              ) : (
                <p className="mode-note">
                  {session?.status === "BROKEN"
                    ? "Historical generation: no live PTY or screen. Rebuild from its checkpoint."
                    : "Select or create a READY Session."}
                </p>
              )}
            </div>
          )}
        </section>

        <aside className="inspector" aria-label="Interaction and timeline">
          {bootstrap?.mcpConnection !== undefined && (
            <section className="mcp-connection" aria-label="MCP connection">
              <div className="section-title">
                <h2>Connect MCP</h2>
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
                Contains a local 24-hour grant. Keep this stack running; do not share or commit the
                copied JSON.
              </small>
            </section>
          )}
          <section className="approval-panel" aria-label="Agent Execute approvals">
            <div className="section-title">
              <h2>Approvals</h2>
              <span>{approvals.filter((approval) => approval.status === "PENDING").length}</span>
            </div>
            <label>
              Decision reason
              <input
                maxLength={512}
                onChange={(event) => setApprovalReason(event.target.value)}
                required
                value={approvalReason}
              />
            </label>
            {approvals.length === 0 ? (
              <p className="mode-note">No Agent Execute proposals for this generation.</p>
            ) : (
              <ol className="approval-list">
                {approvals.map((approval) => (
                  <li key={approval.id}>
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
          <section className="checkpoint-panel" aria-label="Shell checkpoint and rebuild">
            <div className="section-title">
              <h2>Shell checkpoint</h2>
              <span>{checkpoint === undefined ? "—" : `v${checkpoint.version.toString()}`}</span>
            </div>
            {checkpoint === undefined ? (
              <p className="mode-note">No rebuildable checkpoint is currently selected.</p>
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
                  Creates a new PTY. It does not copy processes, REPL/editor memory, vim buffers,
                  jobs, aliases, functions, traps, sockets, or file descriptors. Workspace files
                  remain shared with the parent.
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
          <section>
            <div className="section-title">
              <h2>Interaction</h2>
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
            <dl className="facts">
              <dt>Guard</dt>
              <dd>{interaction?.guard?.actor.id ?? "none"}</dd>
              <dt>Expires</dt>
              <dd>{formatTime(interaction?.guard?.expiresAt)}</dd>
              <dt>Renewals</dt>
              <dd>
                {interaction?.guard === undefined
                  ? "—"
                  : `${interaction.guard.renewals.toString()}/${interaction.guard.maxRenewals.toString()}`}
              </dd>
            </dl>
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
              <small>Explicit shared Action; window size never auto-owns the PTY.</small>
            </form>
          </section>
          <section className="timeline">
            <div className="section-title">
              <h2>Timeline</h2>
              <span>{timeline.length}</span>
            </div>
            <ol>
              {[...timeline].reverse().map((event) => (
                <li key={event.id}>
                  <span>{event.sequence}</span>
                  <div>
                    <strong>{event.type}</strong>
                    <small>{event.actor === undefined ? "runtime" : actorName(event.actor)}</small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {session !== undefined && session.status !== "CLOSED" && (
            <button className="danger" onClick={() => void closeSession()} type="button">
              Close generation
            </button>
          )}
        </aside>
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
          <button onClick={() => setError(undefined)} type="button">
            Dismiss
          </button>
        </section>
      )}
    </main>
  );
}

async function api<T = unknown>(
  path: string,
  options: { readonly body?: unknown; readonly method?: string } = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "x-iterminal-request": "console",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = (await response.json()) as
    { readonly result: T } | { readonly error: ApiErrorBody };
  if (!response.ok || "error" in payload) {
    throw "error" in payload
      ? new ConsoleApiError(payload.error)
      : new Error(`HTTP ${response.status.toString()}`);
  }
  return payload.result;
}

function normalizeClientError(reason: unknown): ApiErrorBody {
  if (reason instanceof ConsoleApiError) return reason.body;
  if (isApiError(reason)) return reason;
  return {
    allowedNextActions: ["refresh_session", "inspect_timeline"],
    code: "CLIENT_ERROR",
    details: {},
    message: reason instanceof Error ? reason.message : String(reason),
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

function isApiError(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "requestId" in value
  );
}

function renderScreen(
  terminal: Terminal,
  screen: ScreenSnapshot,
  showCursor: boolean,
  onRendered: (text: string) => void,
): void {
  terminal.resize(screen.columns, screen.rows);
  const lines = screen.lines.slice(0, screen.rows).map(safeScreenText);
  terminal.write(
    `\u001b[2J\u001b[H${lines.join("\r\n")}\u001b[?25${showCursor ? "h" : "l"}\u001b[${(screen.cursor.row + 1).toString()};${(screen.cursor.column + 1).toString()}H`,
    () => onRendered(captureBrowserTerminal(terminal, screen.rows)),
  );
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
  const left = screenRect.left - surfaceRect.left + screen.cursor.column * cellWidth;
  const top = screenRect.top - surfaceRect.top + screen.cursor.row * cellHeight;
  const next = {
    height: cellHeight,
    left,
    top,
    width: Math.max(cellWidth, screenRect.right - surfaceRect.left - left),
  };
  setLayout((current) =>
    current !== undefined &&
    Math.abs(current.height - next.height) < 0.1 &&
    Math.abs(current.left - next.left) < 0.1 &&
    Math.abs(current.top - next.top) < 0.1 &&
    Math.abs(current.width - next.width) < 0.1
      ? current
      : next,
  );
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

function captureBrowserTerminal(terminal: Terminal, rows: number): string {
  const active = terminal.buffer.active;
  return Array.from({ length: rows }, (_value, row) =>
    (active.getLine(active.viewportY + row)?.translateToString(true) ?? "").trimEnd(),
  ).join("\n");
}

function safeScreenText(line: string): string {
  return [...line]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9) || (code >= 127 && code <= 159) ? "�" : character;
    })
    .join("");
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

class ConsoleApiError extends Error {
  public constructor(public readonly body: ApiErrorBody) {
    super(body.message);
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("Console root element is missing");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
