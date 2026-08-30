import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";

import type { RuntimeError } from "@iterminal/domain";
import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
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
    expect(() => runtimeRpcAuthenticationFromEnvironment({})).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
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

function stubGateway(): RuntimeGateway {
  const unsupported = (): never => {
    throw new Error("Unexpected gateway operation");
  };
  return {
    decideApproval: unsupported,
    getApproval: unsupported,
    listApprovals: unsupported,
    requestExecuteApproval: unsupported,
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
