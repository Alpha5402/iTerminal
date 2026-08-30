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
  readonly generation: number;
  readonly id: string;
  readonly screenVersion: number;
  readonly shell: "bash" | "zsh";
  readonly status: SessionStatus;
  readonly workspaceRoot: string;
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

interface ScreenSnapshot {
  readonly columns: number;
  readonly cursor: { readonly column: number; readonly row: number };
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

interface ResumeState {
  readonly cursor: number;
  readonly events: readonly SessionEvent[];
  readonly screenVersion: number;
}

function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [interaction, setInteraction] = useState<InteractionState>();
  const [screen, setScreen] = useState<ScreenSnapshot>();
  const [timeline, setTimeline] = useState<readonly SessionEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const latestCursor = useRef(0);
  const [streamState, setStreamState] = useState<"offline" | "connecting" | "live" | "gap">(
    "offline",
  );
  const [error, setError] = useState<ApiErrorBody>();
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [shell, setShell] = useState<"bash" | "zsh">("zsh");
  const [command, setCommand] = useState("");
  const [interactive, setInteractive] = useState(false);
  const interactiveState = useRef(false);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectAttempt = useRef(0);
  const latestSession = useRef<Session | undefined>(undefined);
  const latestInteraction = useRef<InteractionState | undefined>(undefined);
  const latestScreen = useRef<ScreenSnapshot | undefined>(undefined);
  const guardReleaseTimer = useRef<number | undefined>(undefined);
  const guardTask = useRef<Promise<void>>(Promise.resolve());
  const inputBuffer = useRef("");
  const inputTimer = useRef<number | undefined>(undefined);
  const selectedGeneration = sessions.find((candidate) => candidate.id === selectedId)?.generation;

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
    if (terminalHost.current === null) return;
    const instance = new Terminal({
      allowProposedApi: false,
      cols: SCREEN_COLUMNS,
      convertEol: false,
      cursorBlink: true,
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
      renderScreen(terminal.current, screen);
    }
  }, [screen]);

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
    const saved = readResume(selected.id, selected.generation);
    setSession(selected);
    setInteraction(undefined);
    setScreen(undefined);
    latestScreen.current = undefined;
    setCursor(saved?.cursor ?? 0);
    latestCursor.current = saved?.cursor ?? 0;
    setTimeline(saved?.events ?? []);
    let disposed = false;
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
    if (session?.status !== "RUNNING") setInteractive(false);
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
    const state = latestInteraction.current;
    if (
      currentSession === undefined ||
      state?.guard === undefined ||
      state.guard.actor.id !== bootstrap?.actor.id
    ) {
      return;
    }
    const next = await api<InteractionState>(
      `/api/sessions/${encodeURIComponent(currentSession.id)}/interaction/guard`,
      {
        body: {
          expectedVersion: state.version,
          generation: currentSession.generation,
          guardId: state.guard.id,
        },
        method: "DELETE",
      },
    );
    latestInteraction.current = next;
    setInteraction(next);
  };

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

  const createSession = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      const created = await api<Session>("/api/sessions", {
        body: { shell, workspaceRoot },
        method: "POST",
      });
      await refreshSessions();
      setSelectedId(created.id);
      setWorkspaceRoot("");
    } catch (reason) {
      setError(normalizeClientError(reason));
    }
  };

  const execute = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (session === undefined) return;
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
        <aside className="rail" aria-label="Sessions">
          <div className="section-title">
            <h2>Sessions</h2>
            <button type="button" onClick={() => void refreshSessions()}>
              Refresh
            </button>
          </div>
          <div className="session-list">
            {sessions.map((candidate) => (
              <button
                className={candidate.id === selectedId ? "session-card selected" : "session-card"}
                key={candidate.id}
                onClick={() => setSelectedId(candidate.id)}
                type="button"
              >
                <strong>{candidate.shell}</strong>
                <span>{candidate.status}</span>
                <small>{candidate.workspaceRoot}</small>
              </button>
            ))}
          </div>
          <form className="create-session" onSubmit={(event) => void createSession(event)}>
            <label>
              Workspace root
              <input
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder="/absolute/workspace/path"
                required
                value={workspaceRoot}
              />
            </label>
            <label>
              Shell
              <select
                onChange={(event) => setShell(event.target.value as "bash" | "zsh")}
                value={shell}
              >
                <option value="zsh">zsh</option>
                <option value="bash">bash</option>
              </select>
            </label>
            <button type="submit">Create persistent shell</button>
          </form>
        </aside>

        <section className="terminal-stage" aria-label="Shared terminal">
          <div className="status-strip">
            <span>
              Session <strong>{session?.status ?? "NONE"}</strong>
            </span>
            <span>generation {session?.generation ?? "—"}</span>
            <span>screen v{screen?.screenVersion ?? 0}</span>
            <span>cursor {cursor}</span>
            {session?.activeExecutionId !== undefined && <code>{session.activeExecutionId}</code>}
          </div>
          <div
            aria-label="Canonical 120 by 40 terminal viewport"
            className={interactive ? "terminal-host interactive" : "terminal-host"}
            onBlur={() => {
              setInteractive(false);
              releaseGuardAfterPendingInput();
            }}
            ref={terminalHost}
            tabIndex={0}
          />
          <pre className="screen-reader-output" data-testid="screen-reader-output">
            {screen?.lines.join("\n") ?? ""}
          </pre>
          <div className="mode-panel">
            {session?.status === "READY" ? (
              <form className="composer" onSubmit={(event) => void execute(event)}>
                <label htmlFor="command">READY command composer</label>
                <div>
                  <textarea
                    id="command"
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="Enter one top-level shell command"
                    required
                    rows={2}
                    value={command}
                  />
                  <button type="submit">Execute Action</button>
                </div>
              </form>
            ) : session?.status === "RUNNING" ? (
              <div className="interactive-controls">
                <button
                  aria-pressed={interactive}
                  onClick={() => {
                    setInteractive((value) => !value);
                    terminal.current?.focus();
                  }}
                  type="button"
                >
                  {interactive ? "Leave interactive focus" : "Enter interactive focus"}
                </button>
                <button onClick={() => void sendControl("CTRL_C")} type="button">
                  Send TTY Ctrl+C
                </button>
                <span>Raw keys become 20 ms InputAction batches.</span>
              </div>
            ) : (
              <p className="mode-note">Select or create a READY Session.</p>
            )}
          </div>
        </section>

        <aside className="inspector" aria-label="Interaction and timeline">
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
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.method === undefined || options.method === "GET"
        ? {}
        : { "x-iterminal-request": "console" }),
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

function renderScreen(terminal: Terminal, screen: ScreenSnapshot): void {
  const lines = screen.lines.slice(0, SCREEN_ROWS).map(safeScreenText);
  terminal.write(`\u001b[2J\u001b[H${lines.join("\r\n")}`);
  terminal.write(
    `\u001b[?25h\u001b[${(screen.cursor.row + 1).toString()};${(screen.cursor.column + 1).toString()}H`,
  );
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
