import { runShellScenarios, type ShellScenarioReport } from "./scenarios.js";
import type { ShellKind } from "./shell-profile.js";

const requestedShell = readShellArgument(process.argv.slice(2));
const shells: readonly ShellKind[] =
  requestedShell === undefined ? ["bash", "zsh"] : [requestedShell];
const reports: ShellScenarioReport[] = [];

for (const shell of shells) {
  reports.push(
    await runShellScenarios(shell, (message) => {
      process.stderr.write(`[${shell}] ${message}\n`);
    }),
  );
}

const passed = reports.every((report) => report.passed);
process.stdout.write(`${JSON.stringify({ passed, reports }, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;

function readShellArgument(args: readonly string[]): ShellKind | undefined {
  const index = args.indexOf("--shell");
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value !== "bash" && value !== "zsh") {
    throw new Error(`--shell must be bash or zsh, received: ${value ?? "missing"}`);
  }
  return value;
}
