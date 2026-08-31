import { spawn } from "node:child_process";
import { join } from "node:path";

export function buildLocalConsole(repositoryRoot: string): Promise<void> {
  return runCommand("pnpm", ["--filter", "@iterminal/console", "build"], repositoryRoot);
}

export function startManagedPostgres(options: {
  readonly password: string;
  readonly port: number;
  readonly projectName: string;
  readonly repositoryRoot: string;
}): Promise<void> {
  return runCommand(
    "docker",
    [
      "compose",
      "-p",
      options.projectName,
      "-f",
      join(options.repositoryRoot, "infra/compose/local.yml"),
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "60",
    ],
    options.repositoryRoot,
    {
      ITERM_LOCAL_POSTGRES_PASSWORD: options.password,
      ITERM_LOCAL_POSTGRES_PORT: options.port.toString(),
    },
  );
}

export function stopManagedPostgres(options: {
  readonly password: string;
  readonly port: number;
  readonly projectName: string;
  readonly repositoryRoot: string;
}): Promise<void> {
  return runCommand(
    "docker",
    [
      "compose",
      "-p",
      options.projectName,
      "-f",
      join(options.repositoryRoot, "infra/compose/local.yml"),
      "stop",
      "postgres",
    ],
    options.repositoryRoot,
    {
      ITERM_LOCAL_POSTGRES_PASSWORD: options.password,
      ITERM_LOCAL_POSTGRES_PORT: options.port.toString(),
    },
  );
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", () => reject(new Error(`Unable to start ${command}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited ${code === null ? `after ${signal ?? "unknown signal"}` : `with ${code.toString()}`}`,
        ),
      );
    });
  });
}
