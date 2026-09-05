import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateExecutorOptions } from "@iterminal/application";
import { afterEach, describe, expect, it } from "vitest";

import {
  PtyShellExecutorFactory,
  type ShellStartupScheduler,
  type ShellStartupTimerHandle,
} from "./pty-shell-executor.js";

const OLD_EXECUTION_LIMIT_MILLISECONDS = 24 * 60 * 60 * 1_000;
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("A02 PTY execution lifetime", () => {
  it("keeps a real execution controllable after virtual time crosses the old limit", async () => {
    const scheduler = new ManualStartupScheduler();
    const executor = await new PtyShellExecutorFactory(undefined, scheduler).create(
      executorOptions(),
    );
    const started = deferred<void>();
    let settled = false;
    try {
      const completion = executor.execute("sleep 30", {
        onStarted: () => started.resolve(),
      });
      void completion.finally(() => {
        settled = true;
      });
      await started.promise;

      scheduler.advanceBy(OLD_EXECUTION_LIMIT_MILLISECONDS + 1);
      await Promise.resolve();

      expect(scheduler.pendingCount()).toBe(0);
      expect(settled).toBe(false);
      await delay(100);
      executor.sendControl({ control: "CTRL_C", mode: "TTY_CONTROL" });
      await expect(completion).resolves.toMatchObject({ exitCode: 130 });
    } finally {
      executor.close();
    }
  }, 20_000);

  it("retains the bounded startup handshake timeout on the injected scheduler", async () => {
    const scheduler = new ManualStartupScheduler();
    const creation = new PtyShellExecutorFactory(undefined, scheduler).create(executorOptions());

    scheduler.advanceBy(5_000);

    await expect(creation).rejects.toThrow("Timed out after 5000 ms waiting for Shell event");
    expect(scheduler.pendingCount()).toBe(0);
  });
});

function executorOptions(): CreateExecutorOptions {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "iterminal-a02-executor-"));
  workspaces.push(workspaceRoot);
  return {
    checkpointEnvironmentKeys: [],
    executorId: `executor-a02-${workspaces.length.toString()}`,
    onLifecycle: () => undefined,
    onOutput: () => undefined,
    sessionGeneration: 1,
    sessionId: `session-a02-${workspaces.length.toString()}`,
    shell: "zsh",
    workspaceRoot,
  };
}

class ManualStartupScheduler implements ShellStartupScheduler {
  #now = 0;
  readonly #tasks = new Set<ManualTask>();

  public schedule(callback: () => void, delayMilliseconds: number): ShellStartupTimerHandle {
    const task: ManualTask = {
      callback,
      cancelled: false,
      deadline: this.#now + delayMilliseconds,
    };
    this.#tasks.add(task);
    return {
      cancel: () => {
        task.cancelled = true;
        this.#tasks.delete(task);
      },
    };
  }

  public advanceBy(milliseconds: number): void {
    this.#now += milliseconds;
    for (const task of [...this.#tasks]) {
      if (task.cancelled || task.deadline > this.#now) continue;
      this.#tasks.delete(task);
      task.callback();
    }
  }

  public pendingCount(): number {
    return this.#tasks.size;
  }
}

interface ManualTask {
  readonly callback: () => void;
  cancelled: boolean;
  readonly deadline: number;
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
