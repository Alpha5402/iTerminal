import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RuntimeError } from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import { UnixRuntimeClient } from "./index.js";

describe("UnixRuntimeClient delivery classification", () => {
  it("marks a read failure retryable when the daemon is unavailable", async () => {
    const client = new UnixRuntimeClient(missingSocket("read"));

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      retryable: true,
    } satisfies Partial<RuntimeError>);
  });

  it("marks a mutating request unknown instead of replaying it", async () => {
    const client = new UnixRuntimeClient(missingSocket("mutation"));

    await expect(
      client.startExecute({
        actor: { client: "test", id: "agent-test", principal: "test", type: "agent" },
        command: "true",
        idempotencyKey: "unknown-delivery",
        sessionGeneration: 1,
        sessionId: "session-test",
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      retryable: false,
    } satisfies Partial<RuntimeError>);
  });
});

function missingSocket(suffix: string): string {
  return join(tmpdir(), `iterminal-missing-${process.pid.toString()}-${suffix}.sock`);
}
