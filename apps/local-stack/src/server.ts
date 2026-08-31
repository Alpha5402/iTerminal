import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { startHumanConsole, type HumanConsoleServerHandle } from "@iterminal/console";
import type { PostgresConnectionTarget } from "@iterminal/persistence-postgres";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";

import { prepareLocalCredentials } from "./credentials.js";

export interface LocalStackHandle {
  readonly consoleUrl: string;
  readonly mcpConfigPath: string;
  readonly runtimeSocketPath: string;
  close(): Promise<void>;
}

export class LocalStackCloseError extends Error {
  readonly stages: readonly string[];

  constructor(stages: readonly string[], errors: readonly unknown[]) {
    super("Local stack did not close cleanly", {
      cause: new AggregateError(errors, "Local stack component close failed"),
    });
    this.name = "LocalStackCloseError";
    this.stages = [...stages];
  }
}

export interface StartLocalStackOptions {
  readonly agentExecuteApproval?: "optional" | "required";
  readonly consoleHost?: string;
  readonly consolePort?: number;
  readonly databaseUrl: PostgresConnectionTarget;
  readonly repositoryRoot: string;
  readonly runtimeSocketPath: string;
  readonly stateRoot: string;
  readonly staticRoot: string;
}

export async function startLocalStack(options: StartLocalStackOptions): Promise<LocalStackHandle> {
  for (const [name, path] of Object.entries({
    repositoryRoot: options.repositoryRoot,
    runtimeSocketPath: options.runtimeSocketPath,
    stateRoot: options.stateRoot,
    staticRoot: options.staticRoot,
  })) {
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  await access(join(options.staticRoot, "index.html"));
  const credentials = await prepareLocalCredentials({
    repositoryRoot: options.repositoryRoot,
    runtimeSocketPath: options.runtimeSocketPath,
    stateRoot: options.stateRoot,
  });
  let daemon: RuntimeDaemonHandle | undefined;
  let consoleServer: HumanConsoleServerHandle | undefined;
  try {
    daemon = await startRuntimeDaemon({
      ...(options.agentExecuteApproval === undefined
        ? {}
        : { agentExecuteApproval: options.agentExecuteApproval }),
      databaseUrl: options.databaseUrl,
      executionDispatch: "immediate",
      rpcAuthentication: {
        audience: credentials.rpcAudience,
        secret: credentials.rpcSecret,
      },
      socketPath: options.runtimeSocketPath,
    });
    await daemon.waitUntilReady();
    consoleServer = await startHumanConsole({
      gateway: new UnixRuntimeClient(options.runtimeSocketPath, {
        authorization: credentials.consoleGrant,
      }),
      host: options.consoleHost ?? "127.0.0.1",
      port: options.consolePort ?? 4173,
      staticRoot: options.staticRoot,
    });
  } catch (error) {
    await Promise.allSettled([consoleServer?.close(), daemon?.close()]);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    consoleUrl: consoleServer.url,
    mcpConfigPath: credentials.mcpConfigPath,
    runtimeSocketPath: daemon.socketPath,
    close: () => {
      closePromise ??= closeLocalStack(consoleServer, daemon);
      return closePromise;
    },
  };
}

async function closeLocalStack(
  consoleServer: HumanConsoleServerHandle,
  daemon: RuntimeDaemonHandle,
): Promise<void> {
  const errors: unknown[] = [];
  const failedStages: string[] = [];
  try {
    await consoleServer.close();
  } catch (error) {
    errors.push(error);
    failedStages.push("console");
  }
  try {
    await daemon.close();
  } catch (error) {
    errors.push(error);
    failedStages.push("runtime");
  }
  if (errors.length > 0) throw new LocalStackCloseError(failedStages, errors);
}
