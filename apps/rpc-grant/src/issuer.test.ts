import { randomBytes } from "node:crypto";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { verifyRuntimeRpcGrant } from "@iterminal/runtime-rpc";
import { describe, expect, it } from "vitest";

import { issueRuntimeRpcGrant } from "./issuer.js";

describe("Runtime RPC grant issuer", () => {
  it("issues a verifiable exact Agent grant with canonical operations", () => {
    const secret = randomBytes(32);
    const issued = issueRuntimeRpcGrant(
      [
        "--type",
        "agent",
        "--client",
        "mcp-stdio",
        "--id",
        "agent-local",
        "--principal",
        "local-agent",
        "--operations",
        "session.list,execution.start",
        "--grant-id",
        "issuer-test",
        "--ttl-seconds",
        "60",
      ],
      { ITERM_RPC_AUTH_SECRET: secret.toString("base64url") },
      new Date(1_000_000),
    );
    const verified = verifyRuntimeRpcGrant(
      issued.token,
      { audience: "iterminal-runtime-rpc", now: () => new Date(1_000_000), secret },
      new Set(["execution.start", "session.list"]),
    );
    expect(verified.claims).toMatchObject({
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
        id: "agent-local",
        kind: "exact",
      },
      operations: ["execution.start", "session.list"],
    });
    expect(JSON.stringify(issued)).not.toContain(issued.token);
    expect(Object.keys(issued)).toEqual(["claims"]);
  });

  it("rejects unknown operations and mixed Actor scope fields", () => {
    const environment = { ITERM_RPC_AUTH_SECRET: randomBytes(32).toString("base64url") };
    expect(() =>
      issueRuntimeRpcGrant(
        [
          "--type",
          "agent",
          "--client",
          "mcp",
          "--id",
          "agent",
          "--principal",
          "agent",
          "--operations",
          "runtime.destroy",
        ],
        environment,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      issueRuntimeRpcGrant(
        [
          "--type",
          "human",
          "--client",
          "console",
          "--scope",
          "paired-prefix",
          "--id",
          "forbidden",
          "--id-prefix",
          "human_",
          "--principal-prefix",
          "local:",
          "--operations",
          "session.list",
        ],
        environment,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
