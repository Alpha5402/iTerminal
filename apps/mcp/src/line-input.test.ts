import {
  ACTOR_CAPABILITY_PROFILES,
  type Actor,
  type InteractionState,
  type InputAction,
  type TerminalScreenSnapshot,
} from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const human: Actor = {
  id: "line-human",
  principal: "line-test-human",
  client: "line-test",
  type: "human",
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
};

describe.each([false, true])("foreground line input, durable=%s", (durable) => {
  it.skipIf(durable && databaseUrl === undefined)(
    "survives sustained output/approval delay, blocks partial Human input, and writes exactly once",
    async () => {
      const pool = durable ? new Pool({ connectionString: databaseUrl }) : undefined;
      let root = "";
      let daemon: RuntimeDaemonHandle | undefined;
      let client: Client | undefined;
      try {
        if (pool !== undefined) {
          const result = await pool.query<{ name: string }>("SELECT current_database() AS name");
          if (result.rows[0]?.name !== "iterminal_test")
            throw new Error("Refusing non-test database");
        }
        root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-line-input-")));
        daemon = await startRuntimeDaemon({
          socketPath: join(root, "runtime.sock"),
          ownerId: `line_${randomUUID()}`,
          ...(durable ? { databaseUrl: databaseUrl ?? "" } : {}),
        });
        const rpc = new UnixRuntimeClient(daemon.socketPath);
        client = new Client({ name: "line-input-test", version: "1.0.0" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: ["--import", "tsx", "apps/mcp/src/main.ts"],
            cwd: resolve(import.meta.dirname, "../../.."),
            env: {
              ...getDefaultEnvironment(),
              NODE_ENV: "test",
              ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
              ITERM_RUNTIME_SOCKET: daemon.socketPath,
              ITERM_ACTOR_ID: "line-agent",
              ITERM_ACTOR_CLIENT: "line-mcp-test",
              ITERM_ACTOR_PRINCIPAL: "line-test-agent",
            },
            stderr: "pipe",
          }),
        );
        const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
          const result = await client!.callTool({ name, arguments: args });
          if (result.isError) throw new Error(JSON.stringify(result));
          return (result.structuredContent as { result: T }).result;
        };
        const session = await call<{ id: string; generation: number }>("session_create", {
          shell: "zsh",
          workspaceRoot: root,
          idempotencyKey: `line-session-${randomUUID()}`,
        });
        const identity = { sessionId: session.id, generation: session.generation };
        // A real newline-delimited program, not a simulated write adapter or the user's MCC.
        const script =
          'const r=require("node:readline").createInterface({input:process.stdin,terminal:false});let n=0;setInterval(()=>console.log("日志 "+ ++n),20);r.on("line",s=>console.log("ACK:"+s));';
        const started = await call<{ execution: { id: string } }>("execute", {
          ...identity,
          command: `${JSON.stringify(process.execPath)} -e '${script}'`,
          idempotencyKey: "line-execute",
        });
        const target = { ...identity, targetExecutionId: started.execution.id };
        const humanTarget = {
          actor: human,
          sessionId: session.id,
          sessionGeneration: session.generation,
          targetExecutionId: started.execution.id,
        };
        for (let i = 0; i < 100; i++) {
          const execution = await call<{ status: string }>("execution_get", {
            executionId: started.execution.id,
          });
          if (execution.status === "RUNNING") break;
          await new Promise((done) => setTimeout(done, 10));
        }
        const before = await call<InteractionState>("interaction_get", identity);
        const screen = await call<TerminalScreenSnapshot>("screen_get", identity);
        // Simulate a delayed approval while ~60 asynchronous output chunks advance the screen.
        await new Promise((done) => setTimeout(done, 1200));
        const nextScreen = await call<TerminalScreenSnapshot>("screen_get", identity);
        expect(nextScreen.screenVersion).toBeGreaterThan(screen.screenVersion + 10);
        const stale = await client.callTool({
          name: "input",
          arguments: {
            ...target,
            data: "must-not-deliver\n",
            expectedScreenVersion: screen.screenVersion,
            idempotencyKey: "stale-screen",
          },
        });
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale)).toContain("SCREEN_CHANGED");
        const input = {
          ...target,
          data: "/miner 状态\n",
          lineInput: {
            expectedInputVersion: before.inputContext?.version,
            expectedInteractionVersion: before.version,
          },
          idempotencyKey: "line-once",
        };
        const delivered = await call<InputAction>("input", input);
        expect(delivered.status).toBe("DELIVERED");
        expect((await call<InputAction>("input", input)).id).toBe(delivered.id);
        const context = await call<InteractionState>("interaction_get", identity);
        await rpc.sendInput({ ...humanTarget, data: "human-half", idempotencyKey: "human-half" });
        const raced = await client.callTool({
          name: "input",
          arguments: {
            ...input,
            lineInput: {
              expectedInputVersion: context.inputContext?.version,
              expectedInteractionVersion: context.version,
            },
            idempotencyKey: "raced-human",
          },
        });
        expect(JSON.stringify(raced)).toContain("INPUT_CONTEXT_CHANGED");
        const partial = await call<InteractionState>("interaction_get", identity);
        const blocked = await client.callTool({
          name: "input",
          arguments: {
            ...input,
            lineInput: {
              expectedInputVersion: partial.inputContext?.version,
              expectedInteractionVersion: partial.version,
            },
            idempotencyKey: "partial-human",
          },
        });
        expect(JSON.stringify(blocked)).toContain("INPUT_CONTEXT_UNSAFE");
        await rpc.sendInput({ ...humanTarget, data: "\r", idempotencyKey: "human-submit" });
        const clear = await call<InteractionState>("interaction_get", identity);
        const second = await call<InputAction>("input", {
          ...input,
          data: "second\n",
          lineInput: {
            expectedInputVersion: clear.inputContext?.version,
            expectedInteractionVersion: clear.version,
          },
          idempotencyKey: "line-two",
        });
        expect(second.status).toBe("DELIVERED");
        for (let i = 0; i < 100; i++) {
          const page = await call<{ events: { type: string; payload: { data?: string } }[] }>(
            "events_query",
            { ...identity, after: 0, limit: 500 },
          );
          const output = page.events
            .filter((event) => event.type === "terminal.pty_output")
            .map((event) => event.payload.data ?? "")
            .join("");
          if (output.includes("ACK:second")) {
            expect(output.match(/ACK:\/miner 状态/g)).toHaveLength(1);
            expect(output).toContain("ACK:human-half");
            break;
          }
          if (i === 99) throw new Error("Foreground never acknowledged the delivered line");
          await new Promise((done) => setTimeout(done, 20));
        }
        if (pool !== undefined) {
          const rows = await pool.query("SELECT payload, status FROM actions WHERE id = $1", [
            delivered.id,
          ]);
          expect(rows.rows[0]).toMatchObject({
            status: "DELIVERED",
            payload: { lineInput: input.lineInput },
          });
          const attempts = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM session_events WHERE action_id = $1 AND event_type = 'interaction.write_attempted'",
            [delivered.id],
          );
          expect(attempts.rows[0]?.count).toBe(1);
          // Force a durable-only policy-version race after the owner's cached observation.
          // This targets only our disposable Session in iterminal_test, never the live stack.
          const observed = await call<InteractionState>("interaction_get", identity);
          await pool.query(
            "UPDATE interaction_guards SET state_version = state_version + 1 WHERE session_id = $1",
            [session.id],
          );
          const durableRace = await client.callTool({
            name: "input",
            arguments: {
              ...input,
              lineInput: {
                expectedInputVersion: observed.inputContext?.version,
                expectedInteractionVersion: observed.version,
              },
              idempotencyKey: "durable-policy-race",
            },
          });
          expect(JSON.stringify(durableRace)).toContain("INPUT_CONTEXT_CHANGED");
          const rejected = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM actions WHERE session_id = $1 AND idempotency_key = 'durable-policy-race'",
            [session.id],
          );
          expect(rejected.rows[0]?.count).toBe(0);
        }
        await call("session_close", identity);
      } finally {
        await client?.close();
        await daemon?.close();
        await pool?.end();
        if (root !== "") await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
