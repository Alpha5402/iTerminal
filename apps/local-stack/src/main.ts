import { resolve } from "node:path";

import { operationalErrorMessage } from "@iterminal/observability";
import {
  configuredPostgresConnectionTarget,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";

import {
  ensureLocalPostgresPassword,
  localPostgresUrl,
  readLocalPostgresPassword,
} from "./credentials.js";
import { buildLocalConsole, startManagedPostgres, stopManagedPostgres } from "./processes.js";
import { LocalStackCloseError, startLocalStack, type LocalStackHandle } from "./server.js";

await main();

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage:
  pnpm local
  pnpm local:stop

Default: build Console assets, start the managed loopback PostgreSQL container, durable Runtime,
and Human Console, then write a private MCP config under .iterminal/local.

Set ITERM_DATABASE_URL or ITERM_DATABASE_URLS to use an external writable PostgreSQL primary without
managing Docker. Optional: ITERM_LOCAL_STATE_DIR, ITERM_LOCAL_POSTGRES_PORT,
ITERM_LOCAL_COMPOSE_PROJECT, ITERM_CONSOLE_PORT, ITERM_AGENT_EXECUTE_APPROVAL,
ITERM_LOCAL_SKIP_CONSOLE_BUILD=1, ITERM_AGENT_NAME (stable per-Agent identity), ITERM_ADDITIONAL_AGENT_NAMES (comma-separated).
`);
    return;
  }

  try {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const stateRoot = resolve(
      process.env.ITERM_LOCAL_STATE_DIR ?? resolve(repositoryRoot, ".iterminal/local"),
    );
    const postgresPort = parsePort(
      "ITERM_LOCAL_POSTGRES_PORT",
      process.env.ITERM_LOCAL_POSTGRES_PORT ?? "55432",
      false,
    );
    const composeProject = parseComposeProject(
      process.env.ITERM_LOCAL_COMPOSE_PROJECT ?? "iterminal-local",
    );
    const externalDatabase = configuredPostgresConnectionTarget({
      ...(process.env.ITERM_DATABASE_URL === undefined
        ? {}
        : { url: process.env.ITERM_DATABASE_URL }),
      ...(process.env.ITERM_DATABASE_URLS === undefined
        ? {}
        : { urls: process.env.ITERM_DATABASE_URLS }),
    });
    const managesPostgres = externalDatabase === undefined;

    if (process.argv.includes("--stop-database")) {
      if (!managesPostgres) {
        process.stdout.write(
          "iTerminal local stack does not own the configured external database\n",
        );
        return;
      }
      const postgresPassword = await readLocalPostgresPassword(stateRoot);
      if (postgresPassword === undefined) {
        process.stdout.write("iTerminal managed local PostgreSQL has no local state to stop\n");
        return;
      }
      await stopManagedPostgres({
        password: postgresPassword,
        port: postgresPort,
        projectName: composeProject,
        repositoryRoot,
      });
      process.stdout.write("iTerminal managed local PostgreSQL stopped; named volume preserved\n");
      return;
    }

    const postgresPassword = managesPostgres
      ? await ensureLocalPostgresPassword(stateRoot)
      : undefined;
    await runStack({
      composeProject,
      externalDatabase,
      managesPostgres,
      postgresPassword,
      postgresPort,
      repositoryRoot,
      stateRoot,
    });
  } catch (error) {
    process.stderr.write(`${operationalErrorMessage(error, "iTerminal local stack failed")}\n`);
    process.exitCode = 1;
  }
}

async function runStack(input: {
  readonly composeProject: string;
  readonly externalDatabase: PostgresConnectionTarget | undefined;
  readonly managesPostgres: boolean;
  readonly postgresPassword: string | undefined;
  readonly postgresPort: number;
  readonly repositoryRoot: string;
  readonly stateRoot: string;
}): Promise<void> {
  let managedPostgresStarted = false;
  let stack: LocalStackHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownSignal: "SIGINT" | "SIGTERM" | undefined;
  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    shutdownPromise ??= (async () => {
      process.stderr.write(`iTerminal local stack stopping after ${signal}\n`);
      const errors: unknown[] = [];
      const failedStages: string[] = [];
      if (stack !== undefined) {
        try {
          await stack.close();
        } catch (error) {
          errors.push(error);
          if (error instanceof LocalStackCloseError) {
            failedStages.push(...error.stages.map((stage) => `application:${stage}`));
          } else {
            failedStages.push("application");
          }
        }
      }
      if (managedPostgresStarted && input.postgresPassword !== undefined) {
        try {
          await stopManagedPostgres({
            password: input.postgresPassword,
            port: input.postgresPort,
            projectName: input.composeProject,
            repositoryRoot: input.repositoryRoot,
          });
        } catch (error) {
          errors.push(error);
          failedStages.push("postgres");
        }
      }
      if (errors.length > 0) throw new LocalStackShutdownError(failedStages, errors);
    })();
    return shutdownPromise;
  };
  const handleSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shutdownSignal !== undefined) return;
    shutdownSignal = signal;
    void shutdown(signal).then(
      () => process.exit(signal === "SIGINT" ? 130 : 0),
      (error: unknown) => failShutdown(error),
    );
  };

  try {
    if (process.env.ITERM_LOCAL_SKIP_CONSOLE_BUILD !== "1") {
      await buildLocalConsole(input.repositoryRoot);
    }
    let databaseUrl = input.externalDatabase;
    if (input.managesPostgres) {
      if (input.postgresPassword === undefined)
        throw new Error("Local PostgreSQL password is missing");
      managedPostgresStarted = true;
      await startManagedPostgres({
        password: input.postgresPassword,
        port: input.postgresPort,
        projectName: input.composeProject,
        repositoryRoot: input.repositoryRoot,
      });
      databaseUrl = localPostgresUrl(input.postgresPassword, input.postgresPort);
    }
    if (databaseUrl === undefined) throw new Error("Local PostgreSQL target is missing");
    stack = await startLocalStack({
      ...(process.env.ITERM_ADDITIONAL_AGENT_NAMES === undefined
        ? {}
        : { additionalAgentNames: process.env.ITERM_ADDITIONAL_AGENT_NAMES.split(",") }),
      ...(process.env.ITERM_AGENT_NAME === undefined
        ? {}
        : { agentName: process.env.ITERM_AGENT_NAME }),
      agentExecuteApproval: parseApproval(process.env.ITERM_AGENT_EXECUTE_APPROVAL),
      consolePort: parsePort("ITERM_CONSOLE_PORT", process.env.ITERM_CONSOLE_PORT ?? "4173", true),
      databaseUrl,
      repositoryRoot: input.repositoryRoot,
      runtimeSocketPath: resolve(input.stateRoot, "runtime.sock"),
      stateRoot: input.stateRoot,
      staticRoot: resolve(input.repositoryRoot, "dist/console-web"),
    });
    process.stdout.write(
      `${JSON.stringify({
        consoleUrl: stack.consoleUrl,
        database: input.managesPostgres ? "managed-local-postgres" : "external-postgres",
        mcpConfigPath: stack.mcpConfigPath,
        runtimeSocketPath: stack.runtimeSocketPath,
        type: "iterminal.local.ready",
      })}\n`,
    );
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  } catch (error) {
    if (stack !== undefined || managedPostgresStarted) {
      await shutdown("SIGTERM").catch(() => undefined);
    }
    process.stderr.write(`${operationalErrorMessage(error, "iTerminal local stack failed")}\n`);
    process.exitCode = 1;
  }
}

class LocalStackShutdownError extends Error {
  readonly stages: readonly string[];

  constructor(stages: readonly string[], errors: readonly unknown[]) {
    super("Local stack shutdown failed", {
      cause: new AggregateError(errors, "Local stack component shutdown failed"),
    });
    this.name = "LocalStackShutdownError";
    this.stages = [...stages];
  }
}

function parsePort(name: string, raw: string, allowZero: boolean): number {
  const value = Number.parseInt(raw, 10);
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 65_535 ||
    value.toString() !== raw
  ) {
    throw new Error(`${name} must be an integer between ${minimum.toString()} and 65535`);
  }
  return value;
}

function parseComposeProject(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new Error(
      "ITERM_LOCAL_COMPOSE_PROJECT must be 1-63 lowercase letters, digits, underscores, or hyphens",
    );
  }
  return value;
}

function parseApproval(value: string | undefined): "optional" | "required" {
  if (value === undefined || value === "optional") return "optional";
  if (value === "required") return "required";
  throw new Error("ITERM_AGENT_EXECUTE_APPROVAL must be 'optional' or 'required'");
}

function failShutdown(error: unknown): never {
  const stages =
    error instanceof LocalStackShutdownError ? ` stages=${error.stages.join(",")}` : "";
  process.stderr.write(
    `${operationalErrorMessage(error, "iTerminal local stack shutdown failed")}${stages}\n`,
  );
  process.exit(1);
}
