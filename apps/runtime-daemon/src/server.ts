import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RuntimeService, type RuntimeServiceOptions } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { XtermScreenProjectionFactory } from "@iterminal/terminal-screen";
import {
  LocalRuntimeGateway,
  runtimeOwnerIdForSocket,
  startRuntimeRpcServer,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";

import {
  startPostgresRecoverySupervisor,
  type PostgresRecoverySupervisor,
  type RuntimeDaemonDurabilityState,
} from "./postgres-recovery-supervisor.js";

export type { RuntimeDaemonDurabilityState } from "./postgres-recovery-supervisor.js";

export interface RuntimeDaemonHandle extends RuntimeRpcServerHandle {
  readonly durable: boolean;
  readonly runtime: RuntimeService;
  durabilityState(): RuntimeDaemonDurabilityState;
  waitUntilReady(): Promise<void>;
}

export async function startRuntimeDaemon(options: {
  readonly databaseHealthCheckMilliseconds?: number;
  readonly databaseUrl?: string;
  readonly executionDispatch?: "external" | "immediate";
  readonly hooks?: RuntimeServiceOptions["hooks"];
  readonly databaseStatementTimeoutMilliseconds?: number;
  readonly databaseReconnectInitialMilliseconds?: number;
  readonly databaseReconnectJitterRatio?: number;
  readonly databaseReconnectMaxMilliseconds?: number;
  readonly onDurabilityState?: (state: RuntimeDaemonDurabilityState) => void;
  readonly outboxMaxPending?: number;
  readonly ownerId?: string;
  readonly socketPath: string;
  readonly runtime?: RuntimeService;
}): Promise<RuntimeDaemonHandle> {
  if (!isAbsolute(options.socketPath)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime socket path must be absolute", {
      socketPath: options.socketPath,
    });
  }
  if (options.executionDispatch === "external" && options.databaseUrl === undefined) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "External Execution dispatch requires PostgreSQL durability",
    );
  }
  if (
    options.runtime !== undefined &&
    (options.databaseUrl !== undefined ||
      options.databaseHealthCheckMilliseconds !== undefined ||
      options.databaseStatementTimeoutMilliseconds !== undefined ||
      options.databaseReconnectInitialMilliseconds !== undefined ||
      options.databaseReconnectJitterRatio !== undefined ||
      options.databaseReconnectMaxMilliseconds !== undefined ||
      options.executionDispatch !== undefined ||
      options.hooks !== undefined ||
      options.onDurabilityState !== undefined ||
      options.outboxMaxPending !== undefined)
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "A custom RuntimeService cannot be combined with daemon database configuration",
    );
  }
  const durability =
    options.databaseUrl === undefined
      ? undefined
      : new PostgresRuntimeDurability(options.databaseUrl, {
          ...(options.databaseStatementTimeoutMilliseconds === undefined
            ? {}
            : { statementTimeoutMilliseconds: options.databaseStatementTimeoutMilliseconds }),
          ...(options.outboxMaxPending === undefined
            ? {}
            : { maxPendingOutbox: options.outboxMaxPending }),
        });
  const ownerId = options.ownerId ?? runtimeOwnerIdForSocket(options.socketPath);
  const runtime =
    options.runtime ??
    new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory(), {
      ...(durability === undefined ? {} : { durability }),
      ...(options.executionDispatch === undefined
        ? {}
        : { executionDispatch: options.executionDispatch }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ownerId,
      screenProjectionFactory: new XtermScreenProjectionFactory(),
    });
  let rpc: RuntimeRpcServerHandle | undefined;
  let durabilityState: RuntimeDaemonDurabilityState =
    durability === undefined
      ? { attempt: 0, phase: "DISABLED" }
      : { attempt: 0, phase: "CONNECTING" };
  const readyWaiters = new Set<Deferred<void>>();
  let closed = false;
  const isReady = (): boolean =>
    !closed &&
    (durabilityState.phase === "DISABLED" ||
      (durabilityState.phase === "READY" && runtime.isDurabilityHealthy()));
  const updateDurabilityState = (state: RuntimeDaemonDurabilityState): void => {
    durabilityState = state;
    try {
      options.onDurabilityState?.(state);
    } catch {
      // Diagnostics must not change Runtime readiness.
    }
    if (isReady()) {
      for (const waiter of readyWaiters) waiter.resolve();
      readyWaiters.clear();
    }
  };
  let supervisor: PostgresRecoverySupervisor | undefined;
  try {
    rpc = await startRuntimeRpcServer({
      gateway: new LocalRuntimeGateway(runtime),
      isReady,
      socketPath: options.socketPath,
    });
    if (durability !== undefined) {
      supervisor = startPostgresRecoverySupervisor({
        durability,
        runtime,
        updateState: updateDurabilityState,
        ...(options.databaseHealthCheckMilliseconds === undefined
          ? {}
          : { healthCheckMilliseconds: options.databaseHealthCheckMilliseconds }),
        ...(options.databaseReconnectInitialMilliseconds === undefined
          ? {}
          : { initialDelayMilliseconds: options.databaseReconnectInitialMilliseconds }),
        ...(options.databaseReconnectJitterRatio === undefined
          ? {}
          : { jitterRatio: options.databaseReconnectJitterRatio }),
        ...(options.databaseReconnectMaxMilliseconds === undefined
          ? {}
          : { maxDelayMilliseconds: options.databaseReconnectMaxMilliseconds }),
      });
      await supervisor.firstAttempt;
    }
  } catch (error) {
    await supervisor?.close().catch(() => undefined);
    await rpc?.close().catch(() => undefined);
    await durability?.close().catch(() => undefined);
    throw error;
  }
  if (rpc === undefined) {
    await durability?.close().catch(() => undefined);
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime RPC server did not start");
  }
  const rpcHandle = rpc;
  let closePromise: Promise<void> | undefined;
  return {
    durable: durability !== undefined,
    durabilityState: () => durabilityState,
    runtime,
    socketPath: rpcHandle.socketPath,
    close: () => {
      if (!closed) {
        closed = true;
        const failure = new RuntimeError(
          "RUNTIME_UNAVAILABLE",
          "Runtime daemon closed before PostgreSQL became ready",
          {},
          true,
        );
        for (const waiter of readyWaiters) waiter.reject(failure);
        readyWaiters.clear();
      }
      closePromise ??= closeDaemon(rpcHandle, runtime, durability, supervisor, durabilityState);
      return closePromise;
    },
    waitUntilReady: () => {
      if (isReady()) return Promise.resolve();
      if (closed) {
        return Promise.reject(
          new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime daemon is closed", {}, true),
        );
      }
      const waiter = deferred<void>();
      readyWaiters.add(waiter);
      return waiter.promise;
    },
  };
}

async function closeDaemon(
  rpc: RuntimeRpcServerHandle,
  runtime: RuntimeService,
  durability: PostgresRuntimeDurability | undefined,
  supervisor: PostgresRecoverySupervisor | undefined,
  durabilityState: RuntimeDaemonDurabilityState,
): Promise<void> {
  const errors: unknown[] = [];
  await rpc.close().catch((error: unknown) => errors.push(error));
  await supervisor?.close().catch((error: unknown) => errors.push(error));
  if (durabilityState.phase === "READY" && runtime.isDurabilityHealthy()) {
    for (const session of runtime.listSessions()) {
      if (session.status !== "CLOSED" && session.status !== "BROKEN") {
        await runtime
          .closeSession(session.id, session.generation)
          .catch((error: unknown) => errors.push(error));
      }
    }
  } else {
    runtime.shutdownLiveOwner("Runtime daemon stopped while PostgreSQL was unavailable");
  }
  await durability?.close().catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Runtime daemon did not close cleanly");
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

export function runtimeOwnerId(socketPath: string): string {
  return runtimeOwnerIdForSocket(socketPath);
}

export function defaultRuntimeSocketPath(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : tmpdir();
  const user = typeof process.getuid === "function" ? process.getuid().toString() : "local";
  return join(base, `iterminal-${user}.sock`);
}
