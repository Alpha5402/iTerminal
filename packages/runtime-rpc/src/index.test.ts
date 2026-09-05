import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";

import type { SecretInputAction } from "@iterminal/domain";
import { ACTOR_CAPABILITY_PROFILES, RuntimeError } from "@iterminal/domain";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  authorizeRuntimeRpcGrant,
  runtimeRpcAuthenticationFromEnvironment,
  runtimeRpcAuthorizationFromEnvironment,
  signRuntimeRpcGrant,
  startRuntimeRpcServer,
  UnixRuntimeClient,
  verifyRuntimeRpcGrant,
  type RuntimeGateway,
  type RuntimeRpcGrantClaims,
} from "./index.js";

describe("UnixRuntimeClient delivery classification", () => {
  it("round-trips one compact observation and enforces its distinct grant", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-observe-"));
    const secret = randomBytes(32);
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        observeExecution: (request, signal) => {
          calls += 1;
          expect(request).toEqual({
            executionId: "execution-rpc",
            generation: 3,
            sessionId: "session-rpc",
            waitMs: 10_000,
          });
          expect(signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            gap: null,
            identity: {
              executionId: request.executionId,
              generation: request.generation,
              sessionId: request.sessionId,
            },
            nextActions: ["wait_for_completion"],
            nextCursor: null,
            output: {
              byteLength: 0,
              contentBase64: "",
              encoding: "base64",
              hasMore: false,
              retention: { minimumAvailableSequence: 1, source: "durable" },
              stream: "pty",
              text: "",
              textStatus: "complete",
            },
            state: {
              completed: false,
              executionState: "RUNNING",
              persistenceLag: "possible",
            },
          });
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.observe"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.output.read"])),
    });
    try {
      await expect(
        allowed.observeExecution({
          executionId: "execution-rpc",
          generation: 3,
          sessionId: "session-rpc",
        }),
      ).resolves.toMatchObject({
        state: { completed: false, executionState: "RUNNING" },
      });
      await expect(
        denied.observeExecution({
          executionId: "execution-rpc",
          generation: 3,
          sessionId: "session-rpc",
          waitMs: 0,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("round-trips bounded Execution wait v2 and enforces its distinct grant", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-wait-v2-"));
    const secret = randomBytes(32);
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        waitExecutionV2: (request, signal) => {
          calls += 1;
          expect(request).toEqual({ executionId: "execution-rpc", waitMs: 10_000 });
          expect(signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            completed: false,
            executionId: request.executionId,
            executionState: "RUNNING",
          });
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.wait.v2"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.wait"])),
    });
    try {
      await expect(allowed.waitExecutionV2({ executionId: "execution-rpc" })).resolves.toEqual({
        completed: false,
        executionId: "execution-rpc",
        executionState: "RUNNING",
      });
      await expect(
        denied.waitExecutionV2({ executionId: "execution-rpc", waitMs: 0 }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("preserves bounded-wait backend unavailability instead of returning incomplete", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-wait-outage-"));
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        waitExecutionV2: () =>
          Promise.reject(
            new RuntimeError("RUNTIME_UNAVAILABLE", "fixture backend unavailable", {}, true),
          ),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    try {
      await expect(
        new UnixRuntimeClient(server.socketPath).waitExecutionV2({
          executionId: "execution-rpc",
          waitMs: 0,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("round-trips bounded Execution output and enforces its distinct read grant", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-output-"));
    const secret = randomBytes(32);
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        readExecutionOutput: (request) => {
          calls += 1;
          const content = Buffer.from("durable-pty", "utf8");
          return Promise.resolve({
            chunks: [{ byteLength: content.length, contentBase64: content.toString("base64") }],
            encoding: "base64",
            executionId: request.executionId,
            executionState: "RUNNING",
            gap: null,
            generation: request.generation,
            hasMore: false,
            nextCursor: "opaque-cursor",
            persistenceLag: "possible",
            retention: { minimumAvailableSequence: 1, source: "durable" },
            sessionId: request.sessionId,
            stream: "pty",
          });
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.output.read"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["artifact.read"])),
    });
    try {
      await expect(
        allowed.readExecutionOutput({
          executionId: "execution-rpc",
          generation: 3,
          maxBytes: 8 * 1024,
          sessionId: "session-rpc",
        }),
      ).resolves.toMatchObject({
        executionState: "RUNNING",
        persistenceLag: "possible",
      });
      await expect(
        denied.readExecutionOutput({
          executionId: "execution-rpc",
          generation: 3,
          sessionId: "session-rpc",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("round-trips bounded Artifact ranges and enforces the read operation grant", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-artifact-read-"));
    const secret = randomBytes(32);
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        readArtifact: (request) => {
          calls += 1;
          return Promise.resolve({
            artifactId: request.artifactId,
            contentBase64: Buffer.from("hello", "utf8").toString("base64"),
            contentType: "application/octet-stream",
            eof: true,
            generation: request.generation,
            kind: "found",
            nextOffset: 5,
            offsetBytes: request.offsetBytes,
            returnedBytes: 5,
            sessionId: request.sessionId,
            totalBytes: 5,
          });
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["artifact.read"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"])),
    });
    try {
      await expect(
        allowed.readArtifact({
          artifactId: "art-rpc",
          generation: 3,
          maxBytes: 8 * 1024,
          offsetBytes: 0,
          sessionId: "session-rpc",
        }),
      ).resolves.toMatchObject({ kind: "found", returnedBytes: 5 });
      await expect(
        denied.readArtifact({
          artifactId: "art-rpc",
          generation: 3,
          offsetBytes: 0,
          sessionId: "session-rpc",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("round-trips bounded Action lookup results through the authenticated Actor contract", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-action-lookup-"));
    const secret = randomBytes(32);
    const lookupActor = {
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      client: "test-mcp",
      id: "agent-rpc-test",
      principal: "local-agent-test",
      type: "agent",
    } as const;
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        lookupAction: (request) => {
          calls += 1;
          return Promise.resolve({
            acceptedAt: new Date(0).toISOString(),
            actionId: "action-rpc",
            actionStatus: "UNKNOWN",
            actionType: "execute",
            executionId: "execution-rpc",
            executionStatus: "UNKNOWN",
            generation: request.generation,
            idempotencyKey: request.idempotencyKey,
            kind: "found",
            sessionId: request.sessionId,
          } as const);
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["action.lookup"])),
    });
    try {
      await expect(
        allowed.lookupAction({
          actor: lookupActor,
          generation: 3,
          idempotencyKey: "lookup-rpc",
          sessionId: "session-rpc",
        }),
      ).resolves.toMatchObject({ kind: "found", actionStatus: "UNKNOWN" });
      expect(calls).toBe(1);

      await expect(
        allowed.lookupAction({
          actor: { ...lookupActor, principal: "forged" },
          generation: 3,
          idempotencyKey: "lookup-rpc",
          sessionId: "session-rpc",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);

      const wrongOperation = new UnixRuntimeClient(server.socketPath, {
        authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"])),
      });
      await expect(
        wrongOperation.lookupAction({
          actor: lookupActor,
          generation: 3,
          idempotencyKey: "lookup-rpc",
          sessionId: "session-rpc",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("round-trips compacted exact-scope history and enforces its distinct grant", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-history-lookup-"));
    const secret = randomBytes(32);
    const lookupActor = {
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      client: "test-mcp",
      id: "agent-rpc-test",
      principal: "local-agent-test",
      type: "agent",
    } as const;
    let calls = 0;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        lookupHistory: (request) => {
          calls += 1;
          return Promise.resolve({
            fact: {
              acceptedAt: new Date(0).toISOString(),
              actionId: "action-history-rpc",
              actionStatus: "UNKNOWN",
              actionType: "execute",
              executionId: "execution-history-rpc",
              executionStatus: "UNKNOWN",
              targetType: "action",
            },
            generation: request.generation,
            kind: "compacted",
            retention: { expiredAt: new Date(1).toISOString(), state: "expired" },
            sessionId: request.sessionId,
            target: request.target,
          });
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["history.lookup"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["action.lookup"])),
    });
    const request = {
      actor: lookupActor,
      generation: 3,
      sessionId: "session-rpc",
      target: { idempotencyKey: "history-rpc", type: "action" as const },
    };
    try {
      await expect(allowed.lookupHistory(request)).resolves.toMatchObject({
        kind: "compacted",
        retention: { state: "expired" },
      });
      await expect(denied.lookupHistory(request)).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        allowed.lookupHistory({ ...request, actor: { ...lookupActor, principal: "forged" } }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("negotiates and validates the live Runtime capability response", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-capabilities-"));
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        getRuntimeCapabilities: () =>
          Promise.resolve({
            buildId: "runtime-test-1",
            features: ["action.execute.v1", "runtime.capabilities.v1"],
            protocolVersion: "1",
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    try {
      await expect(
        new UnixRuntimeClient(server.socketPath).getRuntimeCapabilities(),
      ).resolves.toEqual({
        buildId: "runtime-test-1",
        features: ["action.execute.v1", "runtime.capabilities.v1"],
        protocolVersion: "1",
      });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

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
        actor: {
          capabilities: ACTOR_CAPABILITY_PROFILES.agent,
          client: "test",
          id: "agent-test",
          principal: "test",
          type: "agent",
        },
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

  it("bounds active sockets and expires an incomplete request frame before dispatch", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-resource-bounds-"));
    const socketPath = join(fixture, "runtime.sock");
    await expect(
      startRuntimeRpcServer({
        gateway: stubGateway(),
        resourceLimits: { maxConnections: 0 },
        socketPath,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const server = await startRuntimeRpcServer({
      gateway: stubGateway(),
      resourceLimits: { maxConnections: 1, requestReadTimeoutMilliseconds: 100 },
      socketPath,
    });
    const idle = createConnection(server.socketPath);
    let overCapacity: ReturnType<typeof createConnection> | undefined;
    try {
      await waitForSocketConnect(idle);
      overCapacity = createConnection(server.socketPath);
      await waitForSocketConnect(overCapacity);
      await expect(waitForSocketClose(overCapacity, 1_000)).resolves.toBeUndefined();
      await expect(waitForSocketClose(idle, 1_000)).resolves.toBeUndefined();
      await expect(new UnixRuntimeClient(server.socketPath).listSessions()).resolves.toEqual([]);
    } finally {
      idle.destroy();
      overCapacity?.destroy();
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects non-canonical or missing Actor capabilities at the RPC boundary", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-capability-schema-"));
    const server = await startRuntimeRpcServer({
      gateway: stubGateway(),
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
          id: "invalid-actor-capabilities",
          input: {
            actor: { client: "raw", id: "raw-agent", principal: "raw", type: "agent" },
            command: "true",
            generation: 1,
            idempotencyKey: "invalid-actor-capabilities",
            sessionId: "session-test",
          },
          operation: "execution.start",
        })}\n`,
      );
      await expect(readResponse(socket)).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
        id: "invalid-actor-capabilities",
        ok: false,
      });
    } finally {
      socket.destroy();
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

  it("propagates a bounded Execution wait disconnect to the server waiter", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-wait-abort-"));
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
        waitExecutionV2: (_request, signal) =>
          new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                announceAborted();
                reject(new Error("bounded Execution wait client disconnected"));
              },
              { once: true },
            );
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const socket = createConnection(server.socketPath);
    try {
      await waitForSocketConnect(socket);
      socket.write(
        `${JSON.stringify({
          id: "execution-wait-v2-abort-test",
          input: { executionId: "execution-rpc", waitMs: 30_000 },
          operation: "execution.wait.v2",
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

  it("lets an adapter AbortSignal cancel the same bounded owner wait", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-execution-wait-signal-"));
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
        waitExecutionV2: (_request, signal) =>
          new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                announceAborted();
                reject(new Error("bounded Execution wait aborted"));
              },
              { once: true },
            );
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const controller = new AbortController();
    const waiting = new UnixRuntimeClient(server.socketPath).waitExecutionV2(
      { executionId: "execution-rpc", waitMs: 30_000 },
      controller.signal,
    );
    try {
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

  it("stops accepting new sockets while an active response drains successfully", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-drain-active-"));
    let announceStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const server = await startRuntimeRpcServer({
      gateway: {
        ...stubGateway(),
        listSessions: async () => {
          announceStarted();
          await released;
          return [];
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath);
    const response = client.listSessions();
    try {
      await started;
      if (server.drain === undefined) throw new Error("RPC drain capability is missing");
      const draining = server.drain(1_000);
      releaseResponse();
      await expect(response).resolves.toEqual([]);
      await expect(draining).resolves.toBe(true);
      await expect(new UnixRuntimeClient(server.socketPath).listSessions()).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
    } finally {
      releaseResponse();
      await server.close().catch(() => undefined);
      await rm(fixture, { force: true, recursive: true });
    }
  });
});

describe("Runtime RPC signed grants", () => {
  it("requires the explicit read operation grant for capability negotiation", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-capability-auth-"));
    const secret = randomBytes(32);
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        getRuntimeCapabilities: () =>
          Promise.resolve({
            buildId: "auth-test",
            features: ["runtime.capabilities.v1"],
            protocolVersion: "1",
          }),
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const allowed = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["runtime.capabilities"])),
    });
    const denied = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"])),
    });
    try {
      await expect(allowed.getRuntimeCapabilities()).resolves.toMatchObject({
        buildId: "auth-test",
      });
      await expect(denied.getRuntimeCapabilities()).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("keeps configured and verified bearer material out of ordinary serialization", () => {
    const secret = randomBytes(32);
    const token = signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"]));
    const grant = verifyRuntimeRpcGrant(
      token,
      { audience: "runtime-rpc-test", secret },
      new Set(["session.list"]),
    );
    const client = new UnixRuntimeClient(join(tmpdir(), "runtime.sock"), { authorization: token });

    expect(JSON.stringify(grant)).not.toContain(token);
    expect(JSON.stringify(client)).not.toContain(token);
    expect(Object.keys(grant)).toEqual(["claims"]);
    expect(Object.keys(client)).toEqual([]);
  });

  it("removes the active bearer from known and unknown RPC failures", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-error-boundary-"));
    const secret = randomBytes(32);
    const token = signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"]));
    let knownFailure = true;
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: {
        ...stubGateway(),
        listSessions: () => {
          if (knownFailure) {
            knownFailure = false;
            return Promise.reject(
              new RuntimeError("RUNTIME_UNAVAILABLE", `credential=${token}`, { token }, true),
            );
          }
          return Promise.reject(new Error(`unexpected credential=${token}`));
        },
      },
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath, { authorization: token });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = await client.listSessions().catch((reason: unknown) => reason);
        expect(error).toMatchObject({
          code: "RUNTIME_UNAVAILABLE",
          details: {},
          message: "Runtime RPC request failed",
          retryable: true,
        });
        expect(JSON.stringify(error)).not.toContain(token);
      }
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("authenticates the Human-only secret operation before gateway dispatch", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "it-rpc-secret-auth-"));
    const secret = randomBytes(32);
    const human = {
      capabilities: ACTOR_CAPABILITY_PROFILES.human,
      client: "human-console-web",
      id: "human_console_secret-auth",
      principal: "local-console:secret-auth",
      type: "human",
    } as const;
    let calls = 0;
    const gateway: RuntimeGateway = {
      ...stubGateway(),
      beginSecretInput: (request) => {
        calls += 1;
        return Promise.resolve({
          acceptedAt: "2026-08-31T00:00:00.000Z",
          actionSequence: 1,
          actor: request.actor,
          id: "act_secret_auth",
          idempotencyKey: request.idempotencyKey,
          requestHash: "a".repeat(64),
          sensitiveInputId: "sec_secret_auth",
          sessionGeneration: request.sessionGeneration,
          sessionId: request.sessionId,
          status: "DELIVERED",
          targetExecutionId: request.targetExecutionId,
          type: "secret_input",
        } satisfies SecretInputAction);
      },
    };
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway,
      socketPath: join(fixture, "runtime.sock"),
    });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = signRuntimeRpcGrant(secret, {
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "human-console-web",
        idPrefix: "human_console_",
        kind: "paired_prefix",
        principalPrefix: "local-console:",
        type: "human",
      },
      audience: "runtime-rpc-test",
      expiresAt: issuedAt + 60,
      grantId: "secret-console-prefix-test",
      issuedAt,
      operations: ["secret.input.begin"],
      version: 1,
    });
    const client = new UnixRuntimeClient(server.socketPath, { authorization: token });
    try {
      await expect(
        client.beginSecretInput({
          actor: human,
          data: "TRANSIENT_TEST_VALUE\r",
          idempotencyKey: "secret-auth-test",
          sessionGeneration: 1,
          sessionId: "session-secret-auth",
          targetExecutionId: "execution-secret-auth",
        }),
      ).resolves.toMatchObject({ sensitiveInputId: "sec_secret_auth" });
      expect(calls).toBe(1);
      await expect(
        client.beginSecretInput({
          actor: { ...human, id: "human_console_mismatch", principal: "local-console:other" },
          data: "MUST_NOT_DISPATCH\r",
          idempotencyKey: "secret-auth-mismatch",
          sessionGeneration: 1,
          sessionId: "session-secret-auth",
          targetExecutionId: "execution-secret-auth",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("requires a valid unexpired grant and enforces its operation allowlist", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-auth-"));
    const secret = randomBytes(32);
    const authentication = { audience: "runtime-rpc-test", secret };
    const server = await startRuntimeRpcServer({
      authentication,
      gateway: stubGateway(),
      socketPath: join(fixture, "runtime.sock"),
    });
    const token = signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"]));
    try {
      await expect(new UnixRuntimeClient(server.socketPath).listSessions()).rejects.toMatchObject({
        code: "POLICY_DENIED",
        message: "Runtime RPC authorization failed",
      });
      await expect(
        new UnixRuntimeClient(server.socketPath, { authorization: `${token}x` }).listSessions(),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const authorized = new UnixRuntimeClient(server.socketPath, { authorization: token });
      await expect(authorized.listSessions()).resolves.toEqual([]);
      await expect(authorized.getSession("not-allowed")).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("binds an exact grant to the Actor instead of trusting the request body", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-actor-auth-"));
    const secret = randomBytes(32);
    const server = await startRuntimeRpcServer({
      authentication: { audience: "runtime-rpc-test", secret },
      gateway: stubGateway(),
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, exactAgentGrant(["execution.start"])),
    });
    try {
      await expect(
        client.startExecute({
          actor: {
            capabilities: ACTOR_CAPABILITY_PROFILES.human,
            client: "human-console-web",
            id: "human-forged",
            principal: "local-console:forged",
            type: "human",
          },
          command: "true",
          idempotencyKey: "forged-human",
          sessionGeneration: 1,
          sessionId: "session-test",
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("forwards only a verified request grant across a Router-style RPC hop", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-auth-forward-"));
    const secret = randomBytes(32);
    const authentication = { audience: "runtime-rpc-test", secret };
    const owner = await startRuntimeRpcServer({
      authentication,
      gateway: stubGateway(),
      socketPath: join(fixture, "owner.sock"),
    });
    const router = await startRuntimeRpcServer({
      authentication,
      gateway: new UnixRuntimeClient(owner.socketPath),
      socketPath: join(fixture, "router.sock"),
    });
    const token = signRuntimeRpcGrant(secret, exactAgentGrant(["session.list"]));
    try {
      await expect(
        new UnixRuntimeClient(router.socketPath, { authorization: token }).listSessions(),
      ).resolves.toEqual([]);
      await expect(new UnixRuntimeClient(owner.socketPath).listSessions()).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      await router.close();
      await owner.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an expired grant at the owner boundary", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iterminal-rpc-auth-expired-"));
    const secret = randomBytes(32);
    const claims = exactAgentGrant(["session.list"], 1_000);
    const server = await startRuntimeRpcServer({
      authentication: {
        audience: "runtime-rpc-test",
        now: () => new Date(1_061_000),
        secret,
      },
      gateway: stubGateway(),
      socketPath: join(fixture, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(server.socketPath, {
      authorization: signRuntimeRpcGrant(secret, claims),
    });
    try {
      await expect(client.listSessions()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await server.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("admits only a paired Human Console id and principal suffix", () => {
    const secret = randomBytes(32);
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = signRuntimeRpcGrant(secret, {
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "human-console-web",
        idPrefix: "human_console_",
        kind: "paired_prefix",
        principalPrefix: "local-console:",
        type: "human",
      },
      audience: "runtime-rpc-test",
      expiresAt: issuedAt + 60,
      grantId: "console-prefix-test",
      issuedAt,
      operations: ["execution.start"],
      version: 1,
    });
    const grant = verifyRuntimeRpcGrant(
      token,
      { audience: "runtime-rpc-test", secret },
      new Set(["execution.start"]),
    );
    expect(() =>
      authorizeRuntimeRpcGrant(grant, "execution.start", {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "human-console-web",
        id: "human_console_cookie-1",
        principal: "local-console:cookie-1",
        type: "human",
      }),
    ).not.toThrow();
    expect(() =>
      authorizeRuntimeRpcGrant(grant, "execution.start", {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "human-console-web",
        id: "human_console_cookie-1",
        principal: "local-console:cookie-2",
        type: "human",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("requires production credentials and permits only an explicit test bypass", () => {
    const encodedSecret = randomBytes(32).toString("base64url");
    const malformedSecret = "ITERM_RPC_SECRET_SENTINEL_not-base64url!";
    expect(() => runtimeRpcAuthenticationFromEnvironment({})).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    const malformedError = (() => {
      try {
        runtimeRpcAuthenticationFromEnvironment({ ITERM_RPC_AUTH_SECRET: malformedSecret });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(malformedError).toBeInstanceOf(RuntimeError);
    expect(JSON.stringify(malformedError)).not.toContain(malformedSecret);
    expect(
      runtimeRpcAuthenticationFromEnvironment({ ITERM_RPC_AUTH_SECRET: encodedSecret }),
    ).toMatchObject({ audience: "iterminal-runtime-rpc" });
    expect(() => runtimeRpcAuthorizationFromEnvironment({})).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(
      runtimeRpcAuthorizationFromEnvironment({
        ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
        NODE_ENV: "test",
      }),
    ).toBeUndefined();
    expect(() =>
      runtimeRpcAuthorizationFromEnvironment({ ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1" }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
  });
});

function missingSocket(suffix: string): string {
  return join(tmpdir(), `iterminal-missing-${process.pid.toString()}-${suffix}.sock`);
}

function exactAgentGrant(
  operations: RuntimeRpcGrantClaims["operations"],
  issuedAt = Math.floor(Date.now() / 1_000),
): RuntimeRpcGrantClaims {
  return {
    actor: {
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      client: "test-mcp",
      id: "agent-rpc-test",
      kind: "exact",
      principal: "local-agent-test",
      type: "agent",
    },
    audience: "runtime-rpc-test",
    expiresAt: issuedAt + 60,
    grantId: "rpc-test-grant",
    issuedAt,
    operations,
    version: 1,
  };
}

function readResponse(socket: ReturnType<typeof createConnection>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("RPC response JSON is invalid"));
      }
    });
    socket.once("error", reject);
  });
}

function waitForSocketConnect(socket: ReturnType<typeof createConnection>): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function waitForSocketClose(
  socket: ReturnType<typeof createConnection>,
  timeoutMilliseconds: number,
): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Runtime RPC socket close")),
      timeoutMilliseconds,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function stubGateway(): RuntimeGateway {
  const unsupported = (): never => {
    throw new Error("Unexpected gateway operation");
  };
  return {
    lookupAction: unsupported,
    readArtifact: unsupported,
    readExecutionOutput: unsupported,
    beginSecretInput: unsupported,
    decideApproval: unsupported,
    getApproval: unsupported,
    listApprovals: unsupported,
    requestExecuteApproval: unsupported,
    closeSession: unsupported,
    createSession: unsupported,
    forkSession: unsupported,
    finishSensitiveInput: unsupported,
    dispatchExecution: unsupported,
    acquireInteractionGuard: unsupported,
    getExecution: unsupported,
    getInteractionState: unsupported,
    getScreen: unsupported,
    getScreenCells: unsupported,
    getScreenDiff: unsupported,
    getScreenRegion: unsupported,
    getSensitiveInput: unsupported,
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
