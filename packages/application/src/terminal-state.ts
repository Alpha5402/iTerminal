import type {
  Execution,
  Session,
  SessionStatus,
  TerminalScreenSnapshot,
  TerminalStateConfidence,
  TerminalStateEvidence,
  TerminalStateEvidenceCode,
  TerminalStateKind,
  TerminalStateLimitation,
  TerminalStateObservation,
} from "@iterminal/domain";

const MAX_EVIDENCE = 8;
const MAX_LIMITATIONS = 8;

const editorCommands = new Set(["emacs", "helix", "hx", "mg", "nano", "nvim", "pico", "vi", "vim"]);
const pagerCommands = new Set(["less", "man", "more", "most"]);
const replCommands = new Set([
  "ipython",
  "irb",
  "mysql",
  "node",
  "pry",
  "psql",
  "python",
  "python3",
  "sqlite3",
]);
const monitorCommands = new Set(["btop", "htop", "top", "watch"]);

const passwordPrompt = /(?:password|passphrase|pin|密码|口令)\s*[:：]?\s*$/iu;
const confirmPrompt =
  /(?:\[[yY]\/[nN](?:\/[a-zA-Z])?\]|\([yY]\/[nN]\)|yes\/no|continue\?|proceed\?|confirm\?|是否.*[？?]|确定.*[？?])\s*$/iu;
const editorMarker = /(?:--\s*(?:INSERT|REPLACE|VISUAL)\s*--|GNU nano|UW PICO|VIM - Vi IMproved)/u;
const pagerMarker = /(?:\(END\)|Manual page)/u;
const replPrompt = /^(?:>>>|\.\.\.|In \[\d+\]:|(?:[\w.-]+)?[=#>])(?:\s|$)/u;

export function classifyTerminalState(input: {
  readonly execution?: Execution;
  readonly observedAt: string;
  readonly screen: TerminalScreenSnapshot;
  readonly session: Session;
}): TerminalStateObservation {
  const evidence: TerminalStateEvidence[] = [
    runtimeEvidence(sessionEvidence(input.session.status)),
  ];
  const limitations = new Set<TerminalStateLimitation>([
    "advisory_not_authorization",
    "not_readiness_or_completion",
    "process_state_not_reconstructed",
  ]);
  const base = {
    advisory: true as const,
    frame: screenFrame(input.screen),
    observedAt: input.observedAt,
    sessionStatus: input.session.status,
  };

  if (input.session.status === "READY") {
    return observation(base, "shell_ready", "high", evidence, limitations);
  }
  if (input.session.status !== "RUNNING" || input.execution?.status !== "RUNNING") {
    return observation(base, "unknown", "low", evidence, limitations);
  }

  evidence.push({ code: "execution.running", source: "execution", strength: "fact" });
  const family = commandFamily(input.execution.command);
  if (family !== undefined) {
    evidence.push({ code: `command.${family}_family`, source: "execution", strength: "signal" });
    limitations.add("command_may_not_be_foreground");
  }
  if (input.screen.buffer === "alternate") {
    evidence.push({ code: "screen.alternate_buffer", source: "screen", strength: "signal" });
    limitations.add("screen_content_spoofable");
  }

  const tail = lastNonBlankLine(input.screen.lines);
  const visible = input.screen.lines.join("\n");
  if (passwordPrompt.test(tail)) {
    evidence.push({ code: "screen.password_prompt", source: "screen", strength: "signal" });
    limitations.add("screen_content_spoofable");
    limitations.add("terminal_echo_mode_unobserved");
    return observation(base, "password", "low", evidence, limitations, input.execution.id);
  }
  if (confirmPrompt.test(tail)) {
    evidence.push({ code: "screen.confirm_prompt", source: "screen", strength: "signal" });
    limitations.add("screen_content_spoofable");
    return observation(base, "confirm", "low", evidence, limitations, input.execution.id);
  }

  const hasEditorMarker = editorMarker.test(visible);
  const hasPagerMarker = pagerMarker.test(visible);
  const hasReplPrompt = replPrompt.test(tail);
  if (hasEditorMarker) addScreenSignal(evidence, limitations, "screen.editor_marker");
  if (hasPagerMarker) addScreenSignal(evidence, limitations, "screen.pager_marker");
  if (hasReplPrompt) addScreenSignal(evidence, limitations, "screen.repl_prompt");

  if (family === "editor") {
    return observation(base, "editor", "medium", evidence, limitations, input.execution.id);
  }
  if (family === "pager") {
    return observation(base, "pager", "medium", evidence, limitations, input.execution.id);
  }
  if (family === "repl") {
    return observation(base, "repl", "medium", evidence, limitations, input.execution.id);
  }
  if (hasEditorMarker) {
    return observation(base, "editor", "low", evidence, limitations, input.execution.id);
  }
  if (hasPagerMarker) {
    return observation(base, "pager", "low", evidence, limitations, input.execution.id);
  }
  if (hasReplPrompt) {
    return observation(base, "repl", "low", evidence, limitations, input.execution.id);
  }
  return observation(base, "running", "high", evidence, limitations, input.execution.id);
}

function observation(
  base: Pick<TerminalStateObservation, "advisory" | "frame" | "observedAt" | "sessionStatus">,
  kind: TerminalStateKind,
  confidence: TerminalStateConfidence,
  evidence: readonly TerminalStateEvidence[],
  limitations: ReadonlySet<TerminalStateLimitation>,
  executionId?: string,
): TerminalStateObservation {
  return {
    ...base,
    confidence,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    kind,
    limitations: [...limitations].slice(0, MAX_LIMITATIONS),
    ...(executionId === undefined ? {} : { executionId }),
  };
}

function sessionEvidence(status: SessionStatus): TerminalStateEvidenceCode {
  return `session.${status.toLowerCase()}` as TerminalStateEvidenceCode;
}

function runtimeEvidence(code: TerminalStateEvidenceCode): TerminalStateEvidence {
  return { code, source: "runtime", strength: "fact" };
}

function addScreenSignal(
  evidence: TerminalStateEvidence[],
  limitations: Set<TerminalStateLimitation>,
  code: TerminalStateEvidenceCode,
): void {
  evidence.push({ code, source: "screen", strength: "signal" });
  limitations.add("screen_content_spoofable");
}

function commandFamily(command: string): "editor" | "pager" | "repl" | "monitor" | undefined {
  const executable = simpleCommandBasename(command);
  if (executable === undefined) return undefined;
  if (editorCommands.has(executable)) return "editor";
  if (pagerCommands.has(executable)) return "pager";
  if (replCommands.has(executable)) return "repl";
  if (monitorCommands.has(executable)) return "monitor";
  return undefined;
}

function simpleCommandBasename(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === "" || /[\n;&|`$()<>]/u.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/u);
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/u.test(words[index] ?? "")) index += 1;
  if (words[index] === "exec" || words[index] === "command") index += 1;
  if (words[index] === "env") {
    index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/u.test(words[index] ?? "")) index += 1;
  }
  const token = words[index];
  if (token === undefined || token === "" || /["']/u.test(token)) return undefined;
  return token.slice(token.lastIndexOf("/") + 1).toLowerCase();
}

function lastNonBlankLine(lines: readonly string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== "") return line;
  }
  return "";
}

function screenFrame(screen: TerminalScreenSnapshot): TerminalStateObservation["frame"] {
  return {
    buffer: screen.buffer,
    columns: screen.columns,
    cursor: { ...screen.cursor },
    geometryVersion: screen.geometryVersion,
    rows: screen.rows,
    screenVersion: screen.screenVersion,
    sessionGeneration: screen.sessionGeneration,
    sessionId: screen.sessionId,
  };
}
