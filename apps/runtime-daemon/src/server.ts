import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RuntimeService } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import {
  LocalRuntimeGateway,
  startRuntimeRpcServer,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";

export interface RuntimeDaemonHandle extends RuntimeRpcServerHandle {
  readonly runtime: RuntimeService;
}

export async function startRuntimeDaemon(options: {
  readonly socketPath: string;
  readonly runtime?: RuntimeService;
}): Promise<RuntimeDaemonHandle> {
  if (!isAbsolute(options.socketPath)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime socket path must be absolute", {
      socketPath: options.socketPath,
    });
  }
  const runtime =
    options.runtime ?? new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory());
  const rpc = await startRuntimeRpcServer({
    gateway: new LocalRuntimeGateway(runtime),
    socketPath: options.socketPath,
  });
  return {
    runtime,
    socketPath: rpc.socketPath,
    close: async () => {
      try {
        await rpc.close();
      } finally {
        for (const session of runtime.listSessions()) {
          if (session.status !== "CLOSED") {
            runtime.closeSession(session.id, session.generation);
          }
        }
      }
    },
  };
}

export function defaultRuntimeSocketPath(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : tmpdir();
  const user = typeof process.getuid === "function" ? process.getuid().toString() : "local";
  return join(base, `iterminal-${user}.sock`);
}
