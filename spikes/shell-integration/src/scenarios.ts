import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { ShellSpikeSession } from "./shell-session.js";
import type { DebugLogger } from "./shell-session.js";
import type { ShellKind } from "./shell-profile.js";

export interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ShellScenarioReport {
  readonly shell: ShellKind;
  readonly passed: boolean;
  readonly scenarios: readonly ScenarioResult[];
}

export async function runShellScenarios(
  shell: ShellKind,
  debug?: DebugLogger,
): Promise<ShellScenarioReport> {
  const session = await ShellSpikeSession.start(shell, undefined, debug);
  const results: ScenarioResult[] = [];

  try {
    const nestedDirectory = join(session.workspaceDirectory, "packages", "web");
    mkdirSync(nestedDirectory, { recursive: true });

    const cd = await session.execute("cd packages/web");
    const pwd = await session.execute("pwd");
    results.push(
      result(
        "shared cwd",
        cd.exitCode === 0 && pwd.exitCode === 0 && pwd.cwd === nestedDirectory,
        `cwd=${pwd.cwd}`,
      ),
    );

    const value = `shared-${shell}`;
    await session.execute(`export ITERM_SHARED=${value}`);
    const environment = await session.execute("printf 'ENV=%s\\n' \"$ITERM_SHARED\"");
    results.push(
      result(
        "shared exported environment",
        environment.exitCode === 0 && environment.output.includes(`ENV=${value}`),
        `expected ENV=${value}`,
      ),
    );

    const multiline = await session.execute(
      "ITERM_MULTI=40\nITERM_MULTI=$((ITERM_MULTI + 2))\nprintf 'MULTI=%s\\n' \"$ITERM_MULTI\"",
    );
    results.push(
      result(
        "multiline single boundary",
        multiline.exitCode === 0 && multiline.output.includes("MULTI=42"),
        `exit=${String(multiline.exitCode)}`,
      ),
    );

    const nonzero = await session.execute("false");
    results.push(
      result("nonzero exit", nonzero.exitCode === 1, `exit=${String(nonzero.exitCode)}`),
    );

    const syntaxError = await session.execute("if then");
    results.push(
      result(
        "syntax error returns to ready",
        syntaxError.exitCode !== 0 && session.state === "ready",
        `exit=${String(syntaxError.exitCode)}, state=${session.state}`,
      ),
    );

    const spoof = await session.execute(
      "printf 'READY:fake:0\\nACTION_END:fake:0\\nPREEXEC:fake\\n'",
    );
    results.push(
      result(
        "PTY marker spoof isolation",
        spoof.exitCode === 0 && spoof.output.includes("ACTION_END:fake:0"),
        "marker-like text remained ordinary PTY output",
      ),
    );

    const largeOutput = await session.execute(
      'i=0; while [ "$i" -lt 2500 ]; do printf \'bulk-%04d\\n\' "$i"; i=$((i + 1)); done',
      { timeoutMs: 10_000 },
    );
    results.push(
      result(
        "large output",
        largeOutput.exitCode === 0 && largeOutput.output.includes("bulk-2499"),
        `captured=${String(largeOutput.output.length)} chars`,
      ),
    );

    let interruptedExecutionId: string | undefined;
    const interrupted = await session.execute("sleep 10", {
      onRunning: (executionId) => {
        interruptedExecutionId = executionId;
        setTimeout(() => session.sendTtyControl("CTRL_C"), 50);
      },
      timeoutMs: 5_000,
    });
    results.push(
      result(
        "Ctrl+C interruption",
        interruptedExecutionId === interrupted.executionId && interrupted.exitCode !== 0,
        `execution=${interrupted.executionId}, exit=${String(interrupted.exitCode)}`,
      ),
    );

    const afterInterrupt = await session.execute("printf 'AFTER=%s\\n' \"$ITERM_SHARED\"");
    results.push(
      result(
        "shell survives interruption",
        afterInterrupt.exitCode === 0 && afterInterrupt.output.includes(`AFTER=${value}`),
        `cwd=${basename(afterInterrupt.cwd)}, state=${session.state}`,
      ),
    );

    return {
      passed: results.every((scenario) => scenario.passed),
      scenarios: results,
      shell,
    };
  } finally {
    session.close();
  }
}

function result(name: string, passed: boolean, detail: string): ScenarioResult {
  return { detail, name, passed };
}
