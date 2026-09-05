import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Execution, Session } from "@iterminal/domain";
import type { ExecutionObserveResult } from "@iterminal/protocol";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
interface Measurement {
  success: boolean;
  scenario: string;
  path: string;
  calls: number;
  requestBytes: number;
  responseBytes: number;
  toolMetadataChars: number;
  waitMilliseconds: number;
  extraScreenEventReads: number;
}
const measurements: Measurement[] = [];
(databaseUrl ? describe : describe.skip)("F02 official MCP Agent workflow benchmark", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let daemon: RuntimeDaemonHandle;
  let client: Client;
  let root: string;
  let session: Session;
  let measurement: Measurement;
  beforeAll(async () => {
    const result = await pool.query<{ name: string }>("SELECT current_database() AS name");
    if (result.rows[0]?.name !== "iterminal_test")
      throw new Error("Benchmark requires isolated iterminal_test");
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });
  beforeEach(async (context) => {
    await pool.query(
      "TRUNCATE sessions, actors, outbox, artifacts, runtime_workers RESTART IDENTITY CASCADE",
    );
    root = await realpath(await mkdtemp(join(tmpdir(), "it-workflow-")));
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      socketPath: join(root, "r.sock"),
      ownerId: "workflow-fixture",
    });
    client = new Client({ name: "workflow-fixture", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: join(repositoryRoot, "node_modules/.bin/tsx"),
        args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
        cwd: repositoryRoot,
        env: {
          ...getDefaultEnvironment(),
          NODE_ENV: "test",
          ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
          ITERM_RUNTIME_SOCKET: daemon.socketPath,
        },
        stderr: "pipe",
      }),
    );
    measurement = {
      success: false,
      scenario: context.task.name,
      path: context.task.name.includes("legacy")
        ? "retained legacy interface"
        : "compact observation",
      calls: 0,
      requestBytes: 0,
      responseBytes: 0,
      toolMetadataChars: JSON.stringify(await client.listTools()).length,
      waitMilliseconds: 0,
      extraScreenEventReads: 0,
    };
    const sample = measurement;
    context.onTestFinished(() => {
      sample.success = context.task.result?.state === "pass";
    });
    session = await call<Session>("session_create", {
      idempotencyKey: "workflow-session",
      shell: "zsh",
      workspaceRoot: root,
    });
  });
  afterEach(async () => {
    measurements.push(measurement);
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.end();
    console.log(`F02_METRICS ${JSON.stringify(measurements)}`);
  });

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const started = performance.now();
    const response = await client.callTool({ name, arguments: args });
    measurement.calls++;
    measurement.requestBytes += Buffer.byteLength(JSON.stringify({ name, arguments: args }));
    measurement.responseBytes += Buffer.byteLength(JSON.stringify(response));
    if (name.includes("wait") || name === "execution_observe")
      measurement.waitMilliseconds += performance.now() - started;
    if (name.startsWith("screen") || name === "events_query") measurement.extraScreenEventReads++;
    if (response.isError)
      throw new Error(`Fixture tool failed: ${name} ${JSON.stringify(response.structuredContent)}`);
    const structured = response.structuredContent;
    if (!structured || typeof structured !== "object" || !("result" in structured))
      throw new Error("Missing MCP result");
    return structured.result as T;
  }
  const identity = () => ({ sessionId: session.id, generation: session.generation });
  const execute = (command: string, key = "workflow-execute") =>
    call<{ execution: Execution }>("execute", { ...identity(), command, idempotencyKey: key });
  async function observeAll(executionId: string): Promise<Buffer> {
    let cursor: string | undefined;
    const output: Buffer[] = [];
    for (let index = 0; index < 200; index++) {
      const page = await call<ExecutionObserveResult>("execution_observe", {
        ...identity(),
        executionId,
        waitMs: 1000,
        maxBytes: 64 * 1024,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.gap).toBeNull();
      output.push(Buffer.from(page.output.contentBase64, "base64"));
      cursor = page.nextCursor ?? cursor;
      if (page.state.completed && !page.output.hasMore) return Buffer.concat(output);
    }
    throw new Error("Workflow observation did not settle within its bounded call budget");
  }
  async function stop(executionId: string) {
    await call("control", {
      ...identity(),
      targetExecutionId: executionId,
      idempotencyKey: "workflow-stop",
      delivery: { mode: "TTY_CONTROL", control: "CTRL_C" },
    });
    await call("execution_wait_v2", { executionId, waitMs: 10_000 });
  }
  it.each(["legacy", "compact"])("short command via %s", async (path) => {
    const started = await execute("printf 'workflow-short\\n'");
    if (path === "legacy") {
      const result = await call<Execution>("execution_wait", { executionId: started.execution.id });
      expect(result.status).toBe("COMPLETED");
      expect(result.output).toContain("workflow-short");
    } else expect((await observeAll(started.execution.id)).toString()).toContain("workflow-short");
  });
  it.each(["legacy", "compact"])("long output checksum via %s", async (path) => {
    const expected = Buffer.from("0123456789abcdef".repeat(8192));
    await writeFile(
      join(root, "payload.py"),
      'import os\nos.write(1, b"F02_BEGIN:" + b"0123456789abcdef" * 8192 + b":F02_END")\n',
    );
    const started = await execute("python3 payload.py");
    let actual: Buffer;
    if (path === "legacy") {
      const completed = await call<Execution>("execution_wait", {
        executionId: started.execution.id,
      });
      expect(completed.outputTruncated).toBe(false);
      if (completed.output === undefined) throw new Error("Legacy output missing");
      actual = Buffer.from(completed.output);
    } else actual = await observeAll(started.execution.id);
    // Keep the merged PTY transcript intact; checksum only the fixture's explicit payload.
    // Markers live in the script, so command echo cannot impersonate its boundaries.
    const begin = Buffer.from("F02_BEGIN:");
    const end = Buffer.from(":F02_END");
    const start = actual.indexOf(begin);
    const finish = actual.indexOf(end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(finish).toBe(start + begin.length + expected.length);
    expect(actual.indexOf(begin, start + begin.length)).toBe(-1);
    expect(actual.indexOf(end, finish + end.length)).toBe(-1);
    const payload = actual.subarray(start + begin.length, finish);
    expect(createHash("sha256").update(payload).digest("hex")).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });
  it("bounded wait leaves a sustained task running until explicit control", async () => {
    const started = await execute("sleep 30");
    const result = await call<{ completed: boolean; executionState: string }>("execution_wait_v2", {
      executionId: started.execution.id,
      waitMs: 100,
    });
    expect(result).toMatchObject({ completed: false, executionState: "RUNNING" });
    await stop(started.execution.id);
  });
  it("Agent writes one REPL line and observes its result", async () => {
    const started = await execute("python3 -q");
    await call("execution_wait_v2", { executionId: started.execution.id, waitMs: 100 });
    await call("input", {
      ...identity(),
      targetExecutionId: started.execution.id,
      idempotencyKey: "repl-line",
      data: "print('workflow-repl-result')\n",
    });
    await expect
      .poll(
        async () =>
          (
            await call<ExecutionObserveResult>("execution_observe", {
              ...identity(),
              executionId: started.execution.id,
              waitMs: 50,
            })
          ).output.text,
        { timeout: 5000 },
      )
      .toContain("workflow-repl-result");
    await call("input", {
      ...identity(),
      targetExecutionId: started.execution.id,
      idempotencyKey: "repl-exit",
      data: "exit()\n",
    });
    const finished = await call<{ completed: boolean }>("execution_wait_v2", {
      executionId: started.execution.id,
      waitMs: 1000,
    });
    expect(finished.completed).toBe(true);
  });
  it("command failure remains a real nonzero execution result", async () => {
    const started = await execute("false");
    await observeAll(started.execution.id);
    const result = await call<Execution>("execution_get", { executionId: started.execution.id });
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("COMPLETED");
  });
  it("discarded response is reconciled without a second side effect", async () => {
    await execute("printf x >> counter", "lost-response");
    const lookup = await call<{ kind: string; execution?: { id: string } }>("action_lookup", {
      ...identity(),
      idempotencyKey: "lost-response",
    });
    expect(lookup.kind).toBe("found");
    const replay = await execute("printf x >> counter", "lost-response");
    await observeAll(replay.execution.id);
    expect(await readFile(join(root, "counter"), "utf8")).toBe("x");
  });
  it("idle Shell death is observed as BROKEN and never reused", async () => {
    const row = await pool.query<{ shell_pid: number }>(
      "SELECT shell_pid FROM session_generations WHERE session_id=$1 AND generation=$2",
      [session.id, session.generation],
    );
    const pid = row.rows[0]?.shell_pid;
    if (!pid) throw new Error("Fixture Shell PID unavailable");
    process.kill(pid, "SIGKILL");
    await expect
      .poll(() => call<Session>("session_get", { sessionId: session.id }), { timeout: 5000 })
      .toMatchObject({ status: "BROKEN", generation: session.generation });
  });
  it("expired output is an explicit gap instead of a false complete transcript", async () => {
    const started = await execute("python3 -c 'import os; os.write(1,b\"x\"*65536)'");
    await observeAll(started.execution.id);
    const expired = await pool.query(
      "UPDATE artifacts SET expires_at=now()-interval '1 second' WHERE session_id=$1",
      [session.id],
    );
    expect(expired.rowCount).toBeGreaterThan(0);
    const result = await call<ExecutionObserveResult>("execution_observe", {
      ...identity(),
      executionId: started.execution.id,
      waitMs: 0,
    });
    expect(result.gap?.kind).toBe("artifact_expired");
    expect(result.nextActions).toContain("acknowledge_output_gap");
  });
});
