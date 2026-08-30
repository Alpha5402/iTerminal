import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import {
  signRuntimeRpcGrant,
  UnixRuntimeClient,
  type RuntimeRpcGrantClaims,
} from "@iterminal/runtime-rpc";
import { describe, expect, it } from "vitest";

import { startRuntimeDaemon } from "./server.js";

describe("M10.2 direct Runtime RPC authentication", () => {
  it("rejects an unsigned caller and a body-forged Human before executing a real zsh command", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itm10-rpc-direct-")));
    const secret = randomBytes(32);
    const authentication = { audience: "iterminal-m10-direct", secret };
    const daemon = await startRuntimeDaemon({
      rpcAuthentication: authentication,
      socketPath: join(root, "runtime.sock"),
    });
    const token = signRuntimeRpcGrant(
      secret,
      agentGrant("iterminal-m10-direct", [
        "execution.start",
        "execution.wait",
        "session.close",
        "session.create",
      ]),
    );
    const client = new UnixRuntimeClient(daemon.socketPath, { authorization: token });
    try {
      await expect(new UnixRuntimeClient(daemon.socketPath).listSessions()).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      const session = await client.createSession({ shell: "zsh", workspaceRoot: root });
      await expect(
        client.startExecute({
          actor: {
            capabilities: ACTOR_CAPABILITY_PROFILES.human,
            client: "human-console-web",
            id: "human_console_forged",
            principal: "local-console:forged",
            type: "human",
          },
          command: "printf forged",
          idempotencyKey: "m10-forged-human",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const started = await client.startExecute({
        actor: m10Agent,
        command: "printf 'authenticated-direct\\n'",
        idempotencyKey: "m10-authenticated-direct",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const completed = await client.waitExecution(started.execution.id);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.output).toContain("authenticated-direct");
      await client.closeSession(session.id, session.generation);
    } finally {
      await daemon.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);
});

const m10Agent = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "m10-direct-test",
  id: "agent-m10-direct",
  principal: "m10-direct-agent",
  type: "agent" as const,
};

function agentGrant(
  audience: string,
  operations: RuntimeRpcGrantClaims["operations"],
): RuntimeRpcGrantClaims {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return {
    actor: { ...m10Agent, kind: "exact" },
    audience,
    expiresAt: issuedAt + 60,
    grantId: "m10-direct-agent-grant",
    issuedAt,
    operations,
    version: 1,
  };
}
