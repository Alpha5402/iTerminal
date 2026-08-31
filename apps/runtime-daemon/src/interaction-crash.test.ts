import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDatabase("M8.3 Input/Control crash uncertainty", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const children: ChildProcessWithoutNullStreams[] = [];
  const daemons: RuntimeDaemonHandle[] = [];
  const fixtures: string[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.3 tests refuse to mutate any database except iterminal_test");
    }
    const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
    await durability.migrate();
    await durability.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
    for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
    for (const fixture of fixtures.splice(0)) await rm(fixture, { force: true, recursive: true });
  });

  afterAll(async () => pool.end());

  it.each(["input", "control"] as const)(
    "does not replay %s after the owner dies immediately after the PTY write",
    async (interactionType) => {
      const fixture = await createFixture(interactionType);
      const ownerId = `owner-m8-interaction-${interactionType}`;
      const child = await startCrashDaemon(
        fixture.socketPath,
        ownerId,
        `after-${interactionType}-write`,
      );
      children.push(child);
      const client = new UnixRuntimeClient(fixture.socketPath);
      const session = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const command =
        interactionType === "input"
          ? `IFS= read -r line; printf '%s\\n' "$line" >> ${shellQuote(fixture.sideEffect)}; sleep 30`
          : `trap 'printf "control-once\\n" >> ${shellQuote(fixture.sideEffect)}; exit 130' INT; while :; do sleep 1; done`;
      const started = await client.startExecute({
        actor,
        command,
        idempotencyKey: `interaction-target-${interactionType}`,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await waitFor(async () => (await executionStatus(started.execution.id)) === "RUNNING");

      const idempotencyKey = `crash-${interactionType}-${randomUUID()}`;
      const request = {
        actor,
        idempotencyKey,
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      };
      if (interactionType === "input") {
        await client.sendInput({ ...request, data: "input-once\n" }).catch(() => undefined);
      } else {
        await client
          .sendControl({
            ...request,
            delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
          })
          .catch(() => undefined);
      }
      await waitForExit(child);
      expect(child.signalCode).toBe("SIGKILL");

      const replacement = await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 50,
        databaseReconnectInitialMilliseconds: 25,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 25,
        databaseUrl: databaseUrl ?? "",
        ownerId,
        ownerLeaseMilliseconds: 300,
        socketPath: fixture.socketPath,
      });
      daemons.push(replacement);
      await replacement.waitUntilReady();
      expect(replacement.runtime.listSessions()).toContainEqual(
        expect.objectContaining({ id: session.id, status: "BROKEN" }),
      );
      const recovered = await interactionState(idempotencyKey);
      expect(recovered).toMatchObject({
        action_status: "UNKNOWN",
        execution_status: "UNKNOWN",
        session_status: "BROKEN",
        write_attempts: "1",
      });

      const replacementClient = new UnixRuntimeClient(fixture.socketPath);
      if (interactionType === "input") {
        await expect(
          replacementClient.sendInput({ ...request, data: "input-once\n" }),
        ).rejects.toMatchObject({ code: "SESSION_BROKEN" });
      } else {
        await expect(
          replacementClient.sendControl({
            ...request,
            delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
          }),
        ).rejects.toMatchObject({ code: "SESSION_BROKEN" });
      }
      await delay(250);
      const contents = await readFile(fixture.sideEffect, "utf8").catch(() => "");
      const expectedLine = interactionType === "input" ? "input-once" : "control-once";
      expect(contents.split("\n").filter((line) => line === expectedLine)).toHaveLength(
        contents.includes(expectedLine) ? 1 : 0,
      );
    },
    30_000,
  );

  async function createFixture(interactionType: string): Promise<Fixture> {
    let root = await mkdtemp(join(tmpdir(), `iti-${interactionType.slice(0, 3)}-`));
    root = await realpath(root);
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    return {
      sideEffect: join(root, "side-effect.txt"),
      socketPath: join(root, "runtime.sock"),
      workspace,
    };
  }

  async function executionStatus(executionId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    return result.rows[0]?.status ?? "MISSING";
  }

  async function interactionState(idempotencyKey: string): Promise<InteractionState> {
    const result = await pool.query<InteractionState>(
      `SELECT a.status AS action_status,
              s.status AS session_status,
              e.status AS execution_status,
              (SELECT count(*) FROM session_events v
                WHERE v.action_id = a.id AND v.event_type = 'interaction.write_attempted')
                AS write_attempts
         FROM actions a
         JOIN sessions s ON s.id = a.session_id
         JOIN executions e ON e.id = (a.payload ->> 'targetExecutionId')
        WHERE a.idempotency_key = $1`,
      [idempotencyKey],
    );
    const state = result.rows[0];
    if (state === undefined) throw new Error(`Missing interaction ${idempotencyKey}`);
    return state;
  }
});

const actor = {
  client: "m8-interaction-test",
  id: "agent-m8-interaction",
  principal: "m8-interaction-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

interface Fixture {
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}

interface InteractionState {
  readonly action_status: string;
  readonly execution_status: string;
  readonly session_status: string;
  readonly write_attempts: string;
}

async function startCrashDaemon(
  socketPath: string,
  ownerId: string,
  failpoint: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repositoryRoot, "apps/runtime-daemon/src/fixtures/interaction-crash-daemon.ts"),
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ITERM_DATABASE_URL: databaseUrl ?? "",
        ITERM_DATABASE_HEALTH_CHECK_MS: "50",
        ITERM_RUNTIME_OWNER_ID: ownerId,
        ITERM_RUNTIME_OWNER_LEASE_MS: "300",
        ITERM_RUNTIME_SOCKET: socketPath,
        ITERM_TEST_FAILPOINT: failpoint,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    const timeout = setTimeout(
      () => rejectReady(new Error(`Timed out starting interaction daemon: ${stderr}`)),
      10_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("interaction-crash daemon ready")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Interaction daemon exited before ready: code=${String(code)} signal=${signal}; stderr=${stderr}`,
        ),
      );
    });
  });
  return child;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for M8.3 interaction state");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
