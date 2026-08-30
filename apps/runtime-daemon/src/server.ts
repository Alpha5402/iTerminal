import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  RuntimeService,
  type RuntimeOwnerRecord,
  type RuntimeServiceOptions,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import {
  PostgresRuntimeDurability,
  PostgresRuntimeOwnerRegistry,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { XtermScreenProjectionFactory } from "@iterminal/terminal-screen";
import {
  LocalRuntimeGateway,
  defaultRuntimeSocketPath,
  runtimeOwnerIdForSocket,
  startRuntimeRpcServer,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";

export { defaultRuntimeSocketPath };

import {
  startPostgresRecoverySupervisor,
  type PostgresRecoverySupervisor,
  type RuntimeDaemonDurabilityState,
} from "./postgres-recovery-supervisor.js";

export type { RuntimeDaemonDurabilityState } from "./postgres-recovery-supervisor.js";

export interface RuntimeDaemonDrainState {
  readonly pendingSessionCreations: number;
  readonly phase: "DRAINING" | "SETTLED" | "TIMED_OUT";
}

export interface RuntimeDaemonHandle extends RuntimeRpcServerHandle {
  readonly durable: boolean;
  readonly runtime: RuntimeService;
  durabilityState(): RuntimeDaemonDurabilityState;
  ownerRegistration(): RuntimeOwnerRecord | undefined;
  waitUntilReady(): Promise<void>;
}

const DEFAULT_OWNER_LEASE_MILLISECONDS = 15_000;
const DEFAULT_SESSION_LEASE_MILLISECONDS = 15_000;
const DEFAULT_DATABASE_HEALTH_CHECK_MILLISECONDS = 1_000;
const DEFAULT_DRAIN_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_CAPACITY_WEIGHT = 1;

export async function startRuntimeDaemon(options: {
  readonly actionRateLimitWindowMilliseconds?: number;
  readonly actorActionRateLimit?: number;
  readonly beforeAcceptExecuteCommit?: () => void;
  readonly capacityWeight?: number;
  readonly checkpointEnvironmentKeys?: readonly string[];
  readonly databaseHealthCheckMilliseconds?: number;
  readonly databaseUrl?: PostgresConnectionTarget;
  readonly executionDispatch?: "external" | "immediate";
  readonly hooks?: RuntimeServiceOptions["hooks"];
  readonly databaseStatementTimeoutMilliseconds?: number;
  readonly databaseReconnectInitialMilliseconds?: number;
  readonly databaseReconnectJitterRatio?: number;
  readonly databaseReconnectMaxMilliseconds?: number;
  readonly drainTimeoutMilliseconds?: number;
  readonly onDrainState?: (state: RuntimeDaemonDrainState) => void;
  readonly onDurabilityState?: (state: RuntimeDaemonDurabilityState) => void;
  readonly outboxMaxPending?: number;
  readonly ownerId?: string;
  readonly ownerInstanceId?: string;
  readonly ownerLeaseMilliseconds?: number;
  readonly sessionLeaseMilliseconds?: number;
  readonly sessionActionRateLimit?: number;
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
    options.databaseUrl === undefined &&
    (options.actionRateLimitWindowMilliseconds !== undefined ||
      options.actorActionRateLimit !== undefined ||
      options.beforeAcceptExecuteCommit !== undefined ||
      options.capacityWeight !== undefined ||
      options.drainTimeoutMilliseconds !== undefined ||
      options.onDrainState !== undefined ||
      options.ownerInstanceId !== undefined ||
      options.ownerLeaseMilliseconds !== undefined ||
      options.sessionActionRateLimit !== undefined ||
      options.sessionLeaseMilliseconds !== undefined)
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Runtime owner registry configuration requires PostgreSQL durability",
    );
  }
  if (
    options.runtime !== undefined &&
    (options.actionRateLimitWindowMilliseconds !== undefined ||
      options.actorActionRateLimit !== undefined ||
      options.databaseUrl !== undefined ||
      options.beforeAcceptExecuteCommit !== undefined ||
      options.capacityWeight !== undefined ||
      options.databaseHealthCheckMilliseconds !== undefined ||
      options.databaseStatementTimeoutMilliseconds !== undefined ||
      options.checkpointEnvironmentKeys !== undefined ||
      options.databaseReconnectInitialMilliseconds !== undefined ||
      options.databaseReconnectJitterRatio !== undefined ||
      options.databaseReconnectMaxMilliseconds !== undefined ||
      options.drainTimeoutMilliseconds !== undefined ||
      options.executionDispatch !== undefined ||
      options.hooks !== undefined ||
      options.onDrainState !== undefined ||
      options.onDurabilityState !== undefined ||
      options.outboxMaxPending !== undefined ||
      options.ownerInstanceId !== undefined ||
      options.ownerLeaseMilliseconds !== undefined ||
      options.sessionActionRateLimit !== undefined ||
      options.sessionLeaseMilliseconds !== undefined)
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "A custom RuntimeService cannot be combined with daemon database configuration",
    );
  }
  const capacityWeight = boundedCapacityWeight(options.capacityWeight ?? DEFAULT_CAPACITY_WEIGHT);
  const durability =
    options.databaseUrl === undefined
      ? undefined
      : new PostgresRuntimeDurability(options.databaseUrl, {
          ...(options.actionRateLimitWindowMilliseconds === undefined
            ? {}
            : { actionRateLimitWindowMilliseconds: options.actionRateLimitWindowMilliseconds }),
          ...(options.actorActionRateLimit === undefined
            ? {}
            : { actorActionRateLimit: options.actorActionRateLimit }),
          ...(options.beforeAcceptExecuteCommit === undefined
            ? {}
            : { beforeAcceptExecuteCommit: options.beforeAcceptExecuteCommit }),
          ...(options.databaseStatementTimeoutMilliseconds === undefined
            ? {}
            : { statementTimeoutMilliseconds: options.databaseStatementTimeoutMilliseconds }),
          ...(options.outboxMaxPending === undefined
            ? {}
            : { maxPendingOutbox: options.outboxMaxPending }),
          ...(options.sessionActionRateLimit === undefined
            ? {}
            : { sessionActionRateLimit: options.sessionActionRateLimit }),
        });
  const ownerRegistry =
    options.databaseUrl === undefined
      ? undefined
      : new PostgresRuntimeOwnerRegistry(options.databaseUrl, {
          ...(options.databaseStatementTimeoutMilliseconds === undefined
            ? {}
            : { statementTimeoutMilliseconds: options.databaseStatementTimeoutMilliseconds }),
        });
  const ownerId = options.ownerId ?? runtimeOwnerIdForSocket(options.socketPath);
  const ownerInstanceId = options.ownerInstanceId ?? `runtime_${randomUUID()}`;
  const ownerLeaseMilliseconds = positiveInteger(
    options.ownerLeaseMilliseconds ?? DEFAULT_OWNER_LEASE_MILLISECONDS,
    "ownerLeaseMilliseconds",
  );
  const sessionLeaseMilliseconds = positiveInteger(
    options.sessionLeaseMilliseconds ?? DEFAULT_SESSION_LEASE_MILLISECONDS,
    "sessionLeaseMilliseconds",
  );
  const databaseHealthCheckMilliseconds = positiveInteger(
    options.databaseHealthCheckMilliseconds ?? DEFAULT_DATABASE_HEALTH_CHECK_MILLISECONDS,
    "databaseHealthCheckMilliseconds",
  );
  const drainTimeoutMilliseconds = positiveInteger(
    options.drainTimeoutMilliseconds ?? DEFAULT_DRAIN_TIMEOUT_MILLISECONDS,
    "drainTimeoutMilliseconds",
  );
  if (
    ownerRegistry !== undefined &&
    (ownerLeaseMilliseconds <= databaseHealthCheckMilliseconds * 2 ||
      sessionLeaseMilliseconds <= databaseHealthCheckMilliseconds * 2)
  ) {
    await Promise.all([durability?.close(), ownerRegistry.close()]);
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Runtime owner and Session leases must exceed two database health-check intervals",
      {
        databaseHealthCheckMilliseconds,
        ownerLeaseMilliseconds,
        sessionLeaseMilliseconds,
      },
    );
  }
  const runtime =
    options.runtime ??
    new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory(), {
      ...(durability === undefined ? {} : { durability }),
      ...(options.checkpointEnvironmentKeys === undefined
        ? {}
        : { checkpointEnvironmentKeys: options.checkpointEnvironmentKeys }),
      ...(options.executionDispatch === undefined
        ? {}
        : { executionDispatch: options.executionDispatch }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ownerId,
      screenProjectionFactory: new XtermScreenProjectionFactory(),
      sessionLeaseMilliseconds,
    });
  let rpc: RuntimeRpcServerHandle | undefined;
  let durabilityState: RuntimeDaemonDurabilityState =
    durability === undefined
      ? { attempt: 0, phase: "DISABLED" }
      : { attempt: 0, phase: "CONNECTING" };
  const readyWaiters = new Set<Deferred<void>>();
  let closing = false;
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
        ...(ownerRegistry === undefined
          ? {}
          : {
              ownership: {
                capacityWeight,
                endpoint: options.socketPath,
                instanceId: ownerInstanceId,
                leaseMilliseconds: ownerLeaseMilliseconds,
                ownerId,
                registry: ownerRegistry,
              },
            }),
        healthCheckMilliseconds: databaseHealthCheckMilliseconds,
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
    await ownerRegistry?.close().catch(() => undefined);
    throw error;
  }
  if (rpc === undefined) {
    await durability?.close().catch(() => undefined);
    await ownerRegistry?.close().catch(() => undefined);
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime RPC server did not start");
  }
  const rpcHandle = rpc;
  let closePromise: Promise<void> | undefined;
  return {
    durable: durability !== undefined,
    durabilityState: () => durabilityState,
    ownerRegistration: () => supervisor?.ownerRegistration(),
    runtime,
    socketPath: rpcHandle.socketPath,
    close: () => {
      if (!closing) {
        closing = true;
        const failure = new RuntimeError(
          "RUNTIME_UNAVAILABLE",
          "Runtime daemon closed before PostgreSQL became ready",
          {},
          true,
        );
        for (const waiter of readyWaiters) waiter.reject(failure);
        readyWaiters.clear();
      }
      closePromise ??= closeDaemon(
        rpcHandle,
        runtime,
        durability,
        ownerRegistry,
        supervisor,
        durabilityState,
        drainTimeoutMilliseconds,
        ownerLeaseMilliseconds,
        options.onDrainState,
      ).finally(() => {
        closed = true;
      });
      return closePromise;
    },
    waitUntilReady: () => {
      if (closing) {
        return Promise.reject(
          new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime daemon is closing", {}, true),
        );
      }
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
  ownerRegistry: PostgresRuntimeOwnerRegistry | undefined,
  supervisor: PostgresRecoverySupervisor | undefined,
  durabilityState: RuntimeDaemonDurabilityState,
  drainTimeoutMilliseconds: number,
  ownerLeaseMilliseconds: number,
  onDrainState: ((state: RuntimeDaemonDrainState) => void) | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  const ownerRegistration = supervisor?.ownerRegistration();
  let canPersistShutdown =
    durabilityState.phase === "READY" &&
    runtime.isDurabilityHealthy() &&
    ownerRegistration !== undefined;
  if (canPersistShutdown && ownerRegistry !== undefined && ownerRegistration !== undefined) {
    try {
      const draining = await ownerRegistry.beginOwnerDrain(
        ownerRegistration,
        ownerLeaseMilliseconds,
      );
      runtime.activateDurableOwner(draining);
      await runtime.renewDurableSessionLeases();
      const deadline = Date.now() + drainTimeoutMilliseconds;
      let pendingSessionCreations = await ownerRegistry.countPendingSessionCreations(draining);
      reportDrainState(onDrainState, {
        pendingSessionCreations,
        phase: "DRAINING",
      });
      while (pendingSessionCreations > 0 && Date.now() < deadline) {
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        pendingSessionCreations = await ownerRegistry.countPendingSessionCreations(draining);
      }
      const remainingMilliseconds = Math.max(1, deadline - Date.now());
      const rpcDrained =
        rpc.drain === undefined
          ? await rpc.close().then(() => true)
          : await rpc.drain(remainingMilliseconds);
      reportDrainState(onDrainState, {
        pendingSessionCreations,
        phase: pendingSessionCreations === 0 && rpcDrained ? "SETTLED" : "TIMED_OUT",
      });
    } catch (error) {
      errors.push(error);
      runtime.reportDurabilityUnavailable(error);
      canPersistShutdown = false;
      await rpc.close().catch((closeError: unknown) => errors.push(closeError));
    }
  } else {
    await rpc.close().catch((error: unknown) => errors.push(error));
  }
  if (canPersistShutdown && runtime.isDurabilityHealthy()) {
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
  await supervisor?.close().catch((error: unknown) => errors.push(error));
  if (
    canPersistShutdown &&
    runtime.isDurabilityHealthy() &&
    ownerRegistry !== undefined &&
    ownerRegistration !== undefined
  ) {
    await ownerRegistry.stopOwner(ownerRegistration).catch((error: unknown) => errors.push(error));
  }
  await durability?.close().catch((error: unknown) => errors.push(error));
  await ownerRegistry?.close().catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Runtime daemon did not close cleanly");
  }
}

function reportDrainState(
  report: ((state: RuntimeDaemonDrainState) => void) | undefined,
  state: RuntimeDaemonDrainState,
): void {
  try {
    report?.(state);
  } catch {
    // Diagnostics must not change Runtime shutdown semantics.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

function boundedCapacityWeight(value: number): number {
  const weight = positiveInteger(value, "capacityWeight");
  if (weight > 1_000) {
    throw new RuntimeError("INVALID_REQUEST", "capacityWeight must be at most 1000", {
      capacityWeight: value,
    });
  }
  return weight;
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
