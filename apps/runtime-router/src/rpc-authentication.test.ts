import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { startRuntimeDaemon } from "@iterminal/runtime-daemon";
import {
  signRuntimeRpcGrant,
  UnixRuntimeClient,
  type RuntimeRpcGrantClaims,
} from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { startRuntimeRouter } from "./server.js";

const databaseUrl = process.env.ITERM_M10_RPC_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("M10.2 authenticated central Router forwarding", () => {
  it("preserves one verified Agent grant across Router and owner verification", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      await pool.end();
      throw new Error("M10.2 Router auth test requires the disposable iterminal_test database");
    }
    const root = await realpath(await mkdtemp(join("/private/tmp", "itm10-rpc-router-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const secret = randomBytes(32);
    const audience = "iterminal-m10-router";
    const authentication = { audience, secret };
    const ownerId = `owner-m10-auth-${randomUUID()}`;
    const daemon = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseReconnectInitialMilliseconds: 25,
      databaseReconnectJitterRatio: 0,
      databaseReconnectMaxMilliseconds: 25,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerLeaseMilliseconds: 2_000,
      rpcAuthentication: authentication,
      sessionLeaseMilliseconds: 2_000,
      socketPath: join(root, "owner.sock"),
    });
    let router: Awaited<ReturnType<typeof startRuntimeRouter>> | undefined;
    try {
      await daemon.waitUntilReady();
      router = await startRuntimeRouter({
        databaseUrl: databaseUrl ?? "",
        rpcAuthentication: authentication,
        socketPath: join(root, "router.sock"),
      });
      const token = signRuntimeRpcGrant(
        secret,
        agentGrant(audience, [
          "execution.start",
          "execution.wait",
          "session.close",
          "session.create",
        ]),
      );
      const client = new UnixRuntimeClient(router.socketPath, { authorization: token });
      const session = await client.createSession({
        idempotencyKey: `m10-router-create-${randomUUID()}`,
        shell: "zsh",
        workspaceRoot: workspace,
      });
      expect(session.ownerId).toBe(ownerId);
      const started = await client.startExecute({
        actor: m10RouterAgent,
        command: "printf 'authenticated-router-owner\\n'",
        idempotencyKey: "m10-authenticated-router-execute",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const completed = await client.waitExecution(started.execution.id);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.output).toContain("authenticated-router-owner");
      await expect(
        new UnixRuntimeClient(daemon.socketPath).getSession(session.id),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await client.closeSession(session.id, session.generation);
    } finally {
      await router?.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      await pool.end();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});

const m10RouterAgent = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "m10-router-test",
  id: "agent-m10-router",
  principal: "m10-router-agent",
  type: "agent" as const,
};

function agentGrant(
  audience: string,
  operations: RuntimeRpcGrantClaims["operations"],
): RuntimeRpcGrantClaims {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return {
    actor: { ...m10RouterAgent, kind: "exact" },
    audience,
    expiresAt: issuedAt + 60,
    grantId: "m10-router-agent-grant",
    issuedAt,
    operations,
    version: 1,
  };
}
