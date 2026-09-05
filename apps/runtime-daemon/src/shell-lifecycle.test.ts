import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const fixtures: string[] = [];
const daemons: RuntimeDaemonHandle[] = [];

const agent: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "a01-shell-lifecycle-test",
  id: "agent-a01-shell-lifecycle",
  principal: "local-a01-shell-lifecycle",
  type: "agent",
};

const human: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  client: "a02-shell-lifecycle-test",
  id: "human-a02-shell-lifecycle",
  principal: "local-a02-shell-lifecycle",
  type: "human",
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture, { force: true, recursive: true });
  }
});

describe("A01 real PTY Shell lifecycle", () => {
  it("persists an idle Shell process exit as BROKEN and rejects later Execute", async () => {
    const { daemon, sessionId, generation, shellPid } = await createFixtureRuntime("ready");

    killFixtureShell(shellPid);
    await waitFor(() => daemon.runtime.getSession(sessionId).status === "BROKEN");

    await expect(
      daemon.runtime.startExecute({
        actor: agent,
        command: "printf 'must-not-run\\n'",
        idempotencyKey: "a01-after-ready-shell-exit",
        sessionGeneration: generation,
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "SESSION_BROKEN" });
    const events = await daemon.runtime.queryEvents(sessionId, generation, 0, 500);
    const broken = events.events.filter((event) => event.type === "session.broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.payload).toMatchObject({ reason: "shell_process_exit" });
    expect(broken[0]?.payload.exitCode).toBeTypeOf("number");
    await expectDurableState(sessionId, "BROKEN");
  });

  it("settles a RUNNING Shell exit once as UNKNOWN without a fabricated command exit code", async () => {
    const { daemon, sessionId, generation, shellPid } = await createFixtureRuntime("running");
    const running = await daemon.runtime.startExecute({
      actor: agent,
      command: "sleep 30",
      idempotencyKey: "a01-running-shell-exit",
      sessionGeneration: generation,
      sessionId,
    });
    await running.started;

    killFixtureShell(shellPid);
    await expect(running.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await waitFor(() => daemon.runtime.getSession(sessionId).status === "BROKEN");

    const execution = daemon.runtime.getExecution(running.execution.id);
    expect(execution.status).toBe("UNKNOWN");
    expect(execution.exitCode).toBeUndefined();
    const events = await daemon.runtime.queryEvents(sessionId, generation, 0, 500);
    expect(events.events.filter((event) => event.type === "execution.unknown")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "session.broken")).toHaveLength(1);
    await expectDurableState(sessionId, "BROKEN", running.execution.id);
  });
});

describe("A02 real PTY execution lifetime", () => {
  it("keeps a sleep observable and controllable after a bounded observation timeout", async () => {
    const { daemon, sessionId, generation } = await createFixtureRuntime("observation-timeout");
    const sleeping = await daemon.runtime.startExecute({
      actor: agent,
      command: "sleep 30",
      idempotencyKey: "a02-observation-timeout",
      sessionGeneration: generation,
      sessionId,
    });
    await sleeping.started;

    const observation = await daemon.runtime.waitForScreen({
      condition: { executionId: sleeping.execution.id, type: "execution_exit" },
      generation,
      sessionId,
      timeoutMilliseconds: 25,
    });

    expect(observation).toMatchObject({ matched: false, reason: "timeout" });
    expect(daemon.runtime.getExecution(sleeping.execution.id).status).toBe("RUNNING");
    const control = await daemon.runtime.sendControl({
      actor: human,
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      idempotencyKey: "a02-control-after-observation-timeout",
      sessionGeneration: generation,
      sessionId,
      targetExecutionId: sleeping.execution.id,
    });
    expect(control.status).toBe("DELIVERED");
    await expect(sleeping.completion).resolves.toMatchObject({
      exitCode: 130,
      status: "INTERRUPTED",
    });
    expect(daemon.runtime.getSession(sessionId).status).toBe("READY");
  }, 20_000);

  it("releases its fixture Shell when Application fails after accepting the dispatch write", async () => {
    const { daemon, sessionId, generation, shellPid } = await createFixtureRuntime(
      "fatal-after-write",
      {
        afterExecutionWrite: () => {
          throw new Error("Injected fatal after dispatch write");
        },
      },
    );
    const execution = await daemon.runtime.startExecute({
      actor: agent,
      command: "sleep 30",
      idempotencyKey: "a02-fatal-after-write",
      sessionGeneration: generation,
      sessionId,
    });

    await expect(execution.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await waitFor(() => daemon.runtime.getSession(sessionId).status === "BROKEN");
    await waitFor(() => !processExists(shellPid));

    expect(daemon.runtime.getExecution(execution.execution.id)).toMatchObject({
      status: "UNKNOWN",
    });
    const events = await daemon.runtime.queryEvents(sessionId, generation, 0, 500);
    expect(events.events.filter((event) => event.type === "execution.unknown")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "execution.failed")).toHaveLength(0);
  }, 20_000);
});

async function createFixtureRuntime(
  label: string,
  hooks?: Readonly<{ afterExecutionWrite?: () => void }>,
): Promise<
  Readonly<{
    daemon: RuntimeDaemonHandle;
    generation: number;
    sessionId: string;
    shellPid: number;
  }>
> {
  await assertSafeDatabase();
  const root = await mkdtemp(join(tmpdir(), `iterminal-a01-${label}-`));
  fixtures.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const daemon = await startRuntimeDaemon({
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(hooks === undefined ? {} : { hooks }),
    ownerId: `owner-a01-${label}-${randomUUID()}`,
    socketPath: join(root, "runtime.sock"),
  });
  daemons.push(daemon);
  await daemon.waitUntilReady();
  const session = await daemon.runtime.createSession({
    idempotencyKey: `a01-${label}-session-${randomUUID()}`,
    shell: "zsh",
    workspaceRoot: workspace,
  });
  const events = await daemon.runtime.queryEvents(session.id, session.generation, 0, 500);
  const ready = events.events.find((event) => event.type === "session.shell_ready");
  const shellPid = ready?.payload.shellPid;
  if (typeof shellPid !== "number") throw new Error("Fixture Shell PID was not observed");
  return { daemon, generation: session.generation, sessionId: session.id, shellPid };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function killFixtureShell(shellPid: number): void {
  if (!Number.isSafeInteger(shellPid) || shellPid <= 1 || shellPid === process.pid) {
    throw new Error(`Refusing to kill unsafe fixture PID ${shellPid.toString()}`);
  }
  process.kill(shellPid, "SIGKILL");
}

async function assertSafeDatabase(): Promise<void> {
  if (databaseUrl === undefined) return;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (result.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("A01 tests refuse to mutate any database except iterminal_test");
    }
  } finally {
    await pool.end();
  }
}

async function expectDurableState(
  sessionId: string,
  expectedSessionStatus: "BROKEN",
  executionId?: string,
): Promise<void> {
  if (databaseUrl === undefined) return;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await waitFor(async () => {
      const session = await pool.query<{ status: string }>(
        "SELECT status FROM sessions WHERE id = $1",
        [sessionId],
      );
      if (session.rows[0]?.status !== expectedSessionStatus) return false;
      if (executionId === undefined) return true;
      const execution = await pool.query<{ exit_code: number | null; status: string }>(
        "SELECT status, exit_code FROM executions WHERE id = $1",
        [executionId],
      );
      return execution.rows[0]?.status === "UNKNOWN" && execution.rows[0]?.exit_code === null;
    });
  } finally {
    await pool.end();
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Shell lifecycle state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
