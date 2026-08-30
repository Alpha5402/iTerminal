import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";

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

  it("aborts a bounded screen wait when its RPC client disconnects", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-screen-abort-"));
    let announceStarted!: () => void;
    let announceAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      announceAborted = resolve;
    });
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        waitForScreen: (_request, signal) =>
          new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                announceAborted();
                reject(new Error("aborted by test client"));
              },
              { once: true },
            );
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const socket = createConnection(server.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `${JSON.stringify({
          id: "screen-abort-test",
          input: {
            condition: { stableMilliseconds: 1_000, type: "stable" },
            generation: 1,
            sessionId: "session-test",
            timeoutMilliseconds: 5_000,
          },
          operation: "screen.wait",
        })}\n`,
      );
      await started;
      socket.destroy();
      await aborted;
    } finally {
      socket.destroy();
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("lets an adapter abort its Unix client screen wait and closes the server request", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-client-abort-"));
    let announceStarted!: () => void;
    let announceAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      announceAborted = resolve;
    });
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        waitForScreen: (_request, signal) =>
          new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                announceAborted();
                reject(new Error("aborted by Console adapter"));
              },
              { once: true },
            );
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath);
    const controller = new AbortController();
    try {
      const waiting = client.waitForScreen(
        {
          condition: { afterVersion: 0, type: "version" },
          generation: 1,
          sessionId: "session-test",
          timeoutMilliseconds: 5_000,
        },
        controller.signal,
      );
      await started;
      const rejected = expect(waiting).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      controller.abort();
      await rejected;
      await aborted;
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("aborts and awaits active requests before server close resolves", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-close-active-"));
    let announceStarted!: () => void;
    let aborted = false;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        waitForScreen: (_request, signal) =>
          new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("server closing"));
              },
              { once: true },
            );
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath);
    const waiting = client.waitForScreen({
      condition: { afterVersion: 0, type: "version" },
      generation: 1,
      sessionId: "session-test",
      timeoutMilliseconds: 5_000,
    });
    try {
      await started;
      const rejected = expect(waiting).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      await server.close();
      expect(aborted).toBe(true);
      await rejected;
    } finally {
      await server.close().catch(() => undefined);
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
    forkSession: unsupported,
    dispatchExecution: unsupported,
    acquireInteractionGuard: unsupported,
    getExecution: unsupported,
    getInteractionState: unsupported,
    getScreen: unsupported,
    getScreenCells: unsupported,
    getScreenDiff: unsupported,
    getScreenRegion: unsupported,
    getTerminalState: unsupported,
    getSession: unsupported,
    getSessionCheckpoint: unsupported,
    listSessions: () => Promise.resolve([]),
    queryEvents: unsupported,
    releaseInteractionGuard: unsupported,
    resizeTerminal: unsupported,
    renewInteractionGuard: unsupported,
    searchScreen: unsupported,
    sendControl: unsupported,
    sendInput: unsupported,
    setInputPolicy: unsupported,
    startExecute: unsupported,
    waitExecution: unsupported,
    waitForScreen: unsupported,
  };
}
