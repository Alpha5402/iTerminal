import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const programPaths = new Map(
  ["less", "nano", "python3", "top", "vim"].map((program) => [program, findProgram(program)]),
);
const fixturesAvailable = [...programPaths.values()].every((program) => program !== undefined);
const describeFixtures = fixturesAvailable ? describe : describe.skip;
let fixtureRoot = "";
let workspaceRoot = "";
let daemon: RuntimeDaemonHandle | undefined;
let client: Client | undefined;

beforeAll(async () => {
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-state-")));
  workspaceRoot = join(fixtureRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "state-editor.txt"), "editor fixture\n", "utf8");
  await writeFile(
    join(workspaceRoot, "state-pager.txt"),
    Array.from(
      { length: 200 },
      (_value, index) => `pager-line-${(index + 1).toString().padStart(3, "0")}`,
    ).join("\n"),
    "utf8",
  );
  daemon = await startRuntimeDaemon({ socketPath: join(fixtureRoot, "runtime.sock") });
  client = await connectClient(daemon.socketPath);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close().catch(() => undefined);
  if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
});

describeFixtures("M6.7 bounded terminal-state evidence", () => {
  it("keeps Shell readiness authoritative and stable RUNNING distinct from READY", async () => {
    const activeClient = required(client, "MCP Client");
    for (const shell of ["bash", "zsh"] as const) {
      const session = await callTool<SessionResult>(activeClient, "session_create", {
        shell,
        workspaceRoot,
      });
      await expectState(activeClient, session, {
        confidence: "high",
        kind: "shell_ready",
        requiredEvidence: ["session.ready"],
      });

      const spoof = await start(activeClient, session, {
        command: "printf 'Password:\\r\\n>>>\\r\\nContinue? [y/N]\\r\\n'",
        key: `state-spoof-${shell}`,
      });
      await waitForExit(activeClient, session, spoof.execution.id);
      await expectState(activeClient, session, {
        confidence: "high",
        kind: "shell_ready",
        requiredEvidence: ["session.ready"],
      });

      const sleeping = await start(activeClient, session, {
        command: "sleep 30",
        key: `state-stable-${shell}`,
      });
      await waitUntilRunning(activeClient, sleeping.execution.id);
      const stable = await callTool<WaitResult>(activeClient, "screen_wait", {
        condition: { stableMilliseconds: 100, type: "stable" },
        generation: session.generation,
        sessionId: session.id,
        timeoutMilliseconds: 2_000,
      });
      expect(stable.matched).toBe(true);
      await expectState(activeClient, session, {
        confidence: "high",
        executionId: sleeping.execution.id,
        kind: "running",
        requiredEvidence: ["session.running", "execution.running"],
      });
      await stopWithControl(activeClient, session, sleeping.execution.id, `state-stop-${shell}`);
      await close(activeClient, session);
    }
  }, 30_000);

  it("classifies real REPL/editor/pager/monitor/confirm/password-like fixtures with bounded evidence", async () => {
    const activeClient = required(client, "MCP Client");
    const session = await callTool<SessionResult>(activeClient, "session_create", {
      shell: "zsh",
      workspaceRoot,
    });

    const python = await start(activeClient, session, {
      command: `${requiredProgram("python3")} -q`,
      key: "state-python",
    });
    await waitForText(activeClient, session, ">>>");
    await expectState(activeClient, session, {
      confidence: "medium",
      executionId: python.execution.id,
      kind: "repl",
      requiredEvidence: ["command.repl_family", "screen.repl_prompt"],
    });
    await inputAndExit(activeClient, session, python.execution.id, "exit()\n", "state-python-exit");

    const vim = await start(activeClient, session, {
      command: `${requiredProgram("vim")} -u NONE -N ${join(workspaceRoot, "state-editor.txt")}`,
      key: "state-vim",
    });
    await waitForText(activeClient, session, "state-editor.txt");
    await expectState(activeClient, session, {
      confidence: "medium",
      executionId: vim.execution.id,
      kind: "editor",
      requiredEvidence: ["command.editor_family"],
    });
    await inputAndExit(activeClient, session, vim.execution.id, "\u001b:q!\r", "state-vim-exit");

    const nano = await start(activeClient, session, {
      command: `${requiredProgram("nano")} ${join(workspaceRoot, "state-editor.txt")}`,
      key: "state-nano",
    });
    await waitUntilRunning(activeClient, nano.execution.id);
    await expectState(activeClient, session, {
      confidence: "medium",
      executionId: nano.execution.id,
      kind: "editor",
      requiredEvidence: ["command.editor_family"],
    });
    await inputAndExit(activeClient, session, nano.execution.id, "\u0018", "state-nano-exit");

    const pager = await start(activeClient, session, {
      command: `${requiredProgram("less")} ${join(workspaceRoot, "state-pager.txt")}`,
      key: "state-less",
    });
    await waitForText(activeClient, session, "pager-line-001");
    await expectState(activeClient, session, {
      confidence: "medium",
      executionId: pager.execution.id,
      kind: "pager",
      requiredEvidence: ["command.pager_family"],
    });
    await inputAndExit(activeClient, session, pager.execution.id, "q", "state-less-exit");

    const monitor = await start(activeClient, session, {
      command: requiredProgram("top"),
      key: "state-top",
    });
    await waitForText(activeClient, session, "Processes:");
    await expectState(activeClient, session, {
      confidence: "high",
      executionId: monitor.execution.id,
      kind: "running",
      requiredEvidence: ["command.monitor_family"],
    });
    await inputAndExit(activeClient, session, monitor.execution.id, "q", "state-top-exit");

    const confirm = await start(activeClient, session, {
      command:
        "printf 'Continue? [y/N] '; IFS= read -r answer; printf '\\r\\nanswer=%s\\r\\n' \"$answer\"",
      key: "state-confirm",
    });
    await waitForText(activeClient, session, "Continue? [y/N]");
    const confirmState = await expectState(activeClient, session, {
      confidence: "low",
      executionId: confirm.execution.id,
      kind: "confirm",
      requiredEvidence: ["screen.confirm_prompt"],
    });
    expect(confirmState.limitations).toContain("screen_content_spoofable");
    await inputAndExit(activeClient, session, confirm.execution.id, "n\n", "state-confirm-exit");

    const password = await start(activeClient, session, {
      command:
        "stty -echo; printf 'Password: '; IFS= read -r secret; stty echo; printf '\\r\\nsecret-bytes=%s\\r\\n' \"${#secret}\"",
      key: "state-password",
    });
    await waitForText(activeClient, session, "Password:");
    const passwordState = await expectState(activeClient, session, {
      confidence: "low",
      executionId: password.execution.id,
      kind: "password",
      requiredEvidence: ["screen.password_prompt"],
    });
    expect(passwordState.limitations).toContain("terminal_echo_mode_unobserved");
    await inputAndExit(
      activeClient,
      session,
      password.execution.id,
      "fixture-secret\n",
      "state-password-exit",
    );
    const screen = await callTool<ScreenResult>(activeClient, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(screen.lines.join("\n")).not.toContain("fixture-secret");

    const stale = await activeClient.callTool({
      arguments: { generation: session.generation + 1, sessionId: session.id },
      name: "terminal_state",
    });
    expect(stale.isError).toBe(true);
    expect(textContent(stale)).toContain('"code":"SESSION_GENERATION_CHANGED"');
    await close(activeClient, session);
  }, 60_000);
});

async function connectClient(socketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m6-state-client",
      ITERM_ACTOR_ID: "agent-m6-state",
      ITERM_ACTOR_PRINCIPAL: "m6-state-agent",
      ITERM_RUNTIME_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const connected = new Client({ name: "m6-state-client", version: "1.0.0" });
  await connected.connect(transport);
  return connected;
}

async function start(
  activeClient: Client,
  session: SessionResult,
  input: { readonly command: string; readonly key: string },
): Promise<StartedResult> {
  return callTool(activeClient, "execute", {
    command: input.command,
    generation: session.generation,
    idempotencyKey: input.key,
    sessionId: session.id,
  });
}

async function waitUntilRunning(activeClient: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await callTool<{ readonly status: string }>(activeClient, "execution_get", {
      executionId,
    });
    if (execution.status === "RUNNING") return;
    await delay(5);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitForText(
  activeClient: Client,
  session: SessionResult,
  text: string,
): Promise<void> {
  const result = await callTool<WaitResult>(activeClient, "screen_wait", {
    condition: { caseSensitive: true, text, type: "text" },
    generation: session.generation,
    sessionId: session.id,
    timeoutMilliseconds: 5_000,
  });
  if (!result.matched) throw new Error(`Screen did not show fixture text: ${text}`);
}

async function waitForExit(
  activeClient: Client,
  session: SessionResult,
  executionId: string,
): Promise<void> {
  const result = await callTool<WaitResult>(activeClient, "screen_wait", {
    condition: { executionId, type: "execution_exit" },
    generation: session.generation,
    sessionId: session.id,
    timeoutMilliseconds: 5_000,
  });
  if (!result.matched) throw new Error(`Execution did not exit: ${executionId}`);
}

async function inputAndExit(
  activeClient: Client,
  session: SessionResult,
  executionId: string,
  data: string,
  idempotencyKey: string,
): Promise<void> {
  await callTool(activeClient, "input", {
    data,
    generation: session.generation,
    idempotencyKey,
    sessionId: session.id,
    targetExecutionId: executionId,
  });
  await waitForExit(activeClient, session, executionId);
}

async function stopWithControl(
  activeClient: Client,
  session: SessionResult,
  executionId: string,
  idempotencyKey: string,
): Promise<void> {
  await callTool(activeClient, "control", {
    delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
    generation: session.generation,
    idempotencyKey,
    sessionId: session.id,
    targetExecutionId: executionId,
  });
  await waitForExit(activeClient, session, executionId);
}

async function expectState(
  activeClient: Client,
  session: SessionResult,
  expected: {
    readonly confidence: string;
    readonly executionId?: string;
    readonly kind: string;
    readonly requiredEvidence: readonly string[];
  },
): Promise<TerminalStateResult> {
  let state: TerminalStateResult | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await callTool<TerminalStateResult>(activeClient, "terminal_state", {
      generation: session.generation,
      sessionId: session.id,
    });
    if (
      state.confidence === expected.confidence &&
      state.kind === expected.kind &&
      (expected.executionId === undefined || state.executionId === expected.executionId)
    ) {
      break;
    }
    await delay(5);
  }
  if (state === undefined) throw new Error("Terminal state fixture produced no observation");
  expect(state).toMatchObject({
    advisory: true,
    confidence: expected.confidence,
    kind: expected.kind,
    ...(expected.executionId === undefined ? {} : { executionId: expected.executionId }),
  });
  expect(state.evidence.map((item) => item.code)).toEqual(
    expect.arrayContaining([...expected.requiredEvidence]),
  );
  expect(state.evidence.length).toBeLessThanOrEqual(8);
  expect(state.limitations.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(state)).not.toContain("fixture-secret");
  return state;
}

async function close(activeClient: Client, session: SessionResult): Promise<void> {
  await callTool(activeClient, "session_close", {
    generation: session.generation,
    sessionId: session.id,
  });
}

async function callTool<T>(
  activeClient: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await activeClient.callTool({ arguments: { ...args }, name });
  if (result.isError === true) throw new Error(`MCP tool ${name} failed: ${textContent(result)}`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> =>
      Boolean(block.type === "text"),
    )
    .map((block) => block.text)
    .join("\n");
}

function findProgram(program: string): string | undefined {
  const result = spawnSync("which", [program], { encoding: "utf8" });
  const path = result.stdout.trim();
  return result.status === 0 && path !== "" ? path : undefined;
}

function requiredProgram(program: string): string {
  return required(programPaths.get(program), `${program} executable`);
}

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface ScreenResult {
  readonly lines: readonly string[];
  readonly screenVersion: number;
}

interface WaitResult {
  readonly matched: boolean;
}

interface TerminalStateResult {
  readonly advisory: true;
  readonly confidence: string;
  readonly evidence: readonly { readonly code: string }[];
  readonly executionId?: string;
  readonly kind: string;
  readonly limitations: readonly string[];
}
