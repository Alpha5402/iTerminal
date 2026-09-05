import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShellKind } from "@iterminal/domain";
import { afterEach, describe, expect, it } from "vitest";

import { PtyShellExecutorFactory } from "./pty-shell-executor.js";

describe.each(["bash", "zsh"] as const)("native %s prompt dispatch", (shell: ShellKind) => {
  const fixtures: string[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("renders the submitted command without exposing the Runtime wrapper or token", async () => {
    const root = await mkdtemp(join(tmpdir(), `iterminal-native-${shell}-`));
    fixtures.push(root);
    const workspace = join(root, "a", "deliberately", "long", "publish");
    await mkdir(workspace, { recursive: true });
    const observed: string[] = [];
    const started: string[] = [];
    const executor = await new PtyShellExecutorFactory().create({
      checkpointEnvironmentKeys: [],
      executorId: `native-${shell}-executor`,
      onLifecycle: () => undefined,
      onOutput: (data) => observed.push(data),
      shell,
      sessionGeneration: 1,
      sessionId: `native-${shell}-session`,
      workspaceRoot: workspace,
    });
    const command = `printf '${shell.toUpperCase()}_NATIVE_OK\\n'`;
    try {
      const result = await executor.execute(command, {
        onStarted: (value) => started.push(value),
      });
      const terminalBytes = observed.join("").replaceAll("\r", "");
      expect(started).toEqual([command]);
      expect(terminalBytes).toContain("printf");
      expect(terminalBytes).toContain(`${shell.toUpperCase()}_NATIVE_OK`);
      expect(terminalBytes).not.toContain("__it_execute");
      expect(terminalBytes).not.toContain("iTerminalBarrier=");
      expect(terminalBytes).not.toMatch(/iterminal:(?:bash|zsh)/u);
      expect(terminalBytes).toMatch(/@[^ ]+ publish [%#$] /u);
      expect(terminalBytes).not.toContain(`${root}/a/deliberately/long/publish`);
      expect(result.exitCode).toBe(0);
    } finally {
      executor.close();
    }
  });

  it("submits multiline input as one persistent Shell action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), `iterminal-multiline-${shell}-`));
    fixtures.push(workspace);
    const executor = await new PtyShellExecutorFactory().create({
      checkpointEnvironmentKeys: [],
      executorId: `multiline-${shell}-executor`,
      onLifecycle: () => undefined,
      onOutput: () => undefined,
      shell,
      sessionGeneration: 1,
      sessionId: `multiline-${shell}-session`,
      workspaceRoot: workspace,
    });
    try {
      const result = await executor.execute(
        "ITERM_NATIVE_MULTILINE=shared\nprintf 'MULTILINE=%s\\n' \"$ITERM_NATIVE_MULTILINE\"",
        { onStarted: () => undefined },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("MULTILINE=shared");
      const followUp = await executor.execute("printf '%s\\n' \"$ITERM_NATIVE_MULTILINE\"", {
        onStarted: () => undefined,
      });
      expect(followUp.output).toContain("shared");
    } finally {
      executor.close();
    }
  });

  it("returns to READY with a nonzero result for invalid syntax", async () => {
    const workspace = await mkdtemp(join(tmpdir(), `iterminal-syntax-${shell}-`));
    fixtures.push(workspace);
    const executor = await new PtyShellExecutorFactory().create({
      checkpointEnvironmentKeys: [],
      executorId: `syntax-${shell}-executor`,
      onLifecycle: () => undefined,
      onOutput: () => undefined,
      shell,
      sessionGeneration: 1,
      sessionId: `syntax-${shell}-session`,
      workspaceRoot: workspace,
    });
    try {
      const result = await executor.execute("echo )", { onStarted: () => undefined });
      expect(result.exitCode).not.toBe(0);
    } finally {
      executor.close();
    }
  });
});
