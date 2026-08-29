import { accessSync, constants } from "node:fs";

import { describe, expect, it } from "vitest";

import { runShellScenarios } from "./scenarios.js";
import type { ShellKind } from "./shell-profile.js";

const shells: readonly ShellKind[] = ["bash", "zsh"];

describe.each(shells)("%s persistent Shell integration", (shell) => {
  const executable = `/bin/${shell}`;
  const available = (() => {
    try {
      accessSync(executable, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!available)(
    "passes the M0 shared-state and boundary scenarios",
    async () => {
      const report = await runShellScenarios(shell);
      expect(report.scenarios, JSON.stringify(report, null, 2)).not.toContainEqual(
        expect.objectContaining({ passed: false }),
      );
      expect(report.passed).toBe(true);
    },
    30_000,
  );
});
