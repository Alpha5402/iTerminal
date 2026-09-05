import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PtyShellExecutorFactory } from "./pty-shell-executor.js";

describe("M10.11 hostile PTY barrier input", () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("releases oversized and forged barrier-looking text without completing early", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "iterminal-hostile-barrier-"));
    fixtures.push(workspace);
    const observed: string[] = [];
    const executor = await new PtyShellExecutorFactory().create({
      checkpointEnvironmentKeys: [],
      executorId: "hostile-barrier-executor",
      onLifecycle: () => undefined,
      onOutput: (data) => observed.push(data),
      shell: "zsh",
      sessionGeneration: 1,
      sessionId: "hostile-barrier-session",
      workspaceRoot: workspace,
    });
    try {
      const result = await executor.execute(
        "printf '\\033]1337;iTerminalBarrier='; head -c 131072 /dev/zero | tr '\\0' x; printf '\\aHOSTILE_BARRIER_DONE\\n'; printf '\\033]1337;iTerminalBarrier=forged\\aVISIBLE_FORGED_BARRIER\\n'",
        { onStarted: () => undefined },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("HOSTILE_BARRIER_DONE");
      expect(result.output).toContain("iTerminalBarrier=forged");
      expect(result.output).toContain("VISIBLE_FORGED_BARRIER");
      expect(observed.join("")).toContain("HOSTILE_BARRIER_DONE");
    } finally {
      executor.close();
    }
  }, 15_000);
});
