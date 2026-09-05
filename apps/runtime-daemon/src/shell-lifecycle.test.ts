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

async function createFixtureRuntime(label: string): Promise<
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
