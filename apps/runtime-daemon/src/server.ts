import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RuntimeService } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import {
  LocalRuntimeGateway,
  startRuntimeRpcServer,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";

export interface RuntimeDaemonHandle extends RuntimeRpcServerHandle {
  readonly durable: boolean;
  readonly runtime: RuntimeService;
}

export async function startRuntimeDaemon(options: {
  readonly databaseUrl?: string;
  readonly ownerId?: string;
  readonly socketPath: string;
  readonly runtime?: RuntimeService;
}): Promise<RuntimeDaemonHandle> {
  if (!isAbsolute(options.socketPath)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime socket path must be absolute", {
      socketPath: options.socketPath,
    });
  }
  if (options.runtime !== undefined && options.databaseUrl !== undefined) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "A custom RuntimeService cannot be combined with daemon database configuration",
    );
  }
  const durability =
    options.databaseUrl === undefined
      ? undefined
      : new PostgresRuntimeDurability(options.databaseUrl);
  const ownerId = options.ownerId ?? runtimeOwnerId(options.socketPath);
  const runtime =
    options.runtime ??
    new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory(), {
      ...(durability === undefined ? {} : { durability }),
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
  return `owner_local_${createHash("sha256").update(socketPath).digest("hex").slice(0, 24)}`;
}

export function defaultRuntimeSocketPath(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : tmpdir();
  const user = typeof process.getuid === "function" ? process.getuid().toString() : "local";
  return join(base, `iterminal-${user}.sock`);
}
