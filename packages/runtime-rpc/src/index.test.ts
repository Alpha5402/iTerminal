import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RuntimeError } from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import { startRuntimeRpcServer, UnixRuntimeClient, type RuntimeGateway } from "./index.js";

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

  it("rejects requests until the bound daemon declares readiness", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-ready-"));
    let ready = false;
    const server = await startRuntimeRpcServer({
      gateway: stubGateway(),
      isReady: () => ready,
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath);

    try {
      await expect(client.listSessions()).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        retryable: true,
      } satisfies Partial<RuntimeError>);
      ready = true;
      await expect(client.listSessions()).resolves.toEqual([]);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });
});

function missingSocket(suffix: string): string {
  return join(tmpdir(), `iterminal-missing-${process.pid.toString()}-${suffix}.sock`);
}

function stubGateway(): RuntimeGateway {
  const unsupported = (): never => {
    throw new Error("Unexpected gateway operation");
  };
  return {
    closeSession: unsupported,
    createSession: unsupported,
    dispatchExecution: unsupported,
    getExecution: unsupported,
    getScreen: unsupported,
    getSession: unsupported,
    listSessions: () => Promise.resolve([]),
    queryEvents: unsupported,
    sendControl: unsupported,
    sendInput: unsupported,
    startExecute: unsupported,
    waitExecution: unsupported,
  };
}
