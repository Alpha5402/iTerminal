import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { startHumanConsole, type HumanConsoleServerHandle } from "@iterminal/console";
import type { PostgresConnectionTarget } from "@iterminal/persistence-postgres";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";

import { consoleFileAuthorization } from "../../console/src/credential-file.js";
import { startCredentialRenewal, type CredentialRenewalStatus } from "./credential-renewal.js";

import { prepareLocalCredentials } from "./credentials.js";

export interface LocalStackHandle {
  readonly consoleUrl: string;
  readonly mcpConfigPath: string;
  readonly runtimeSocketPath: string;
  credentialStatus(): CredentialRenewalStatus;
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
  readonly agentName?: string;
  readonly additionalAgentNames?: readonly string[];
  readonly grantTtlSeconds?: number;
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
  const credentialOptions = {
    repositoryRoot: options.repositoryRoot,
    runtimeSocketPath: options.runtimeSocketPath,
    stateRoot: options.stateRoot,
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    ...(options.grantTtlSeconds === undefined ? {} : { grantTtlSeconds: options.grantTtlSeconds }),
  };
  const credentials = await prepareLocalCredentials(credentialOptions);
  const additionalNames = [...new Set(options.additionalAgentNames ?? [])].filter(
    (name) => name !== (options.agentName ?? "local"),
  );
  const refreshAdditional = async () => {
    for (const agentName of additionalNames)
      await prepareLocalCredentials({ ...credentialOptions, agentName });
  };
  await refreshAdditional();
  const renewal = startCredentialRenewal({
    expiresAt: credentials.expiresAt,
    refresh: async () => {
      await refreshAdditional();
      return (await prepareLocalCredentials(credentialOptions)).expiresAt;
    },
    onStatus: (status) => {
      if (status.phase === "expired" || status.phase === "stopped")
        process.stderr.write(
          `iTerminal credential renewal ${status.phase}; expiry ${new Date(status.expiresAt).toISOString()}\n`,
        );
    },
    onFailure: () =>
      process.stderr.write(
        "iTerminal credential renewal failed; existing grants remain valid only until expiry\n",
      ),
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
        authorizationProvider: consoleFileAuthorization(
          credentials.consoleCredentialPath,
          options.runtimeSocketPath,
        ),
      }),
      host: options.consoleHost ?? "127.0.0.1",
      mcpConfigPath: credentials.mcpConfigPath,
      port: options.consolePort ?? 4173,
      staticRoot: options.staticRoot,
    });
  } catch (error) {
    await renewal.close();
    await Promise.allSettled([consoleServer?.close(), daemon?.close()]);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    consoleUrl: consoleServer.url,
    mcpConfigPath: credentials.mcpConfigPath,
    credentialStatus: () => renewal.status(),
    runtimeSocketPath: daemon.socketPath,
    close: () => {
      closePromise ??= renewal.close().then(() => closeLocalStack(consoleServer, daemon));
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
