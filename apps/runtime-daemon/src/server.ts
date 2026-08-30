import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RuntimeService, type RuntimeServiceOptions } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import {
  LocalRuntimeGateway,
  runtimeOwnerIdForSocket,
  startRuntimeRpcServer,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";

export interface RuntimeDaemonHandle extends RuntimeRpcServerHandle {
  readonly durable: boolean;
  readonly runtime: RuntimeService;
}

export async function startRuntimeDaemon(options: {
  readonly databaseUrl?: string;
  readonly executionDispatch?: "external" | "immediate";
  readonly hooks?: RuntimeServiceOptions["hooks"];
  readonly databaseStatementTimeoutMilliseconds?: number;
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
      options.databaseStatementTimeoutMilliseconds !== undefined ||
      options.executionDispatch !== undefined ||
      options.hooks !== undefined ||
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
    });
  let rpc: RuntimeRpcServerHandle | undefined;
  let ready = false;
  try {
    rpc = await startRuntimeRpcServer({
      gateway: new LocalRuntimeGateway(runtime),
      isReady: () => ready,
      socketPath: options.socketPath,
    });
    await durability?.migrate();
    await runtime.recoverDurableOwner("runtime owner restarted without a graceful close");
    ready = true;
  } catch (error) {
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
    runtime,
    socketPath: rpcHandle.socketPath,
    close: () => {
      closePromise ??= closeDaemon(rpcHandle, runtime, durability);
      return closePromise;
    },
  };
}

async function closeDaemon(
  rpc: RuntimeRpcServerHandle,
  runtime: RuntimeService,
  durability: PostgresRuntimeDurability | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  await rpc.close().catch((error: unknown) => errors.push(error));
  for (const session of runtime.listSessions()) {
    if (session.status !== "CLOSED") {
      await runtime
        .closeSession(session.id, session.generation)
        .catch((error: unknown) => errors.push(error));
    }
  }
  await durability?.close().catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Runtime daemon did not close cleanly");
  }
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
