import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PtyProcessGuardian, type PtyProcessGuardianEvent } from "./pty-process-guardian.js";
import { PtyShellExecutorFactory } from "./pty-shell-executor.js";

describe("PTY Process Guardian", () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("reclaims a registered Shell session before a delayed descendant effect", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "iterminal-guardian-"));
    fixtures.push(workspace);
    const escapedEffect = join(workspace, "escaped.txt");
    const reclaimed = deferred<PtyProcessGuardianEvent>();
    const guardian = new PtyProcessGuardian({
      leaseTimeoutMilliseconds: 1_000,
      onEvent: (event) => {
        if (event.reason === "lease_timeout") reclaimed.resolve(event);
      },
      terminationGraceMilliseconds: 100,
    });
    const executor = await new PtyShellExecutorFactory(guardian).create({
      checkpointEnvironmentKeys: [],
      onOutput: () => undefined,
      shell: "zsh",
      workspaceRoot: workspace,
    });
    try {
      await guardian.renew(300);
      const started = deferred<void>();
      const execution = executor
        .execute(`(sleep 0.8; printf 'escaped\\n' >> ${shellQuote(escapedEffect)}) & sleep 30`, {
          onStarted: () => started.resolve(),
        })
        .catch((error: unknown) => error);
      await started.promise;
      const event = await reclaimed.promise;
      expect(event.registeredSessions).toBe(1);
      expect(event.processCount).toBeGreaterThanOrEqual(2);
      await expect(waitUntilProcessGone(executor.shellPid)).resolves.toBeUndefined();
      await delay(900);
      await expect(readOptional(escapedEffect)).resolves.toBe("");
      await execution;
    } finally {
      executor.close();
      await guardian.close();
    }
  }, 10_000);

  it("runs outside the Runtime process group so terminal SIGINT cannot kill it", async () => {
    const guardian = new PtyProcessGuardian({ leaseTimeoutMilliseconds: 1_000 });
    try {
      const guardianPid = guardian.pid;
      if (guardianPid === undefined) throw new Error("Process Guardian PID is unavailable");
      expect(() => process.kill(-guardianPid, 0)).not.toThrow();
      await guardian.renew(500);
    } finally {
      await guardian.close();
    }
  });
});

async function waitUntilProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(20);
  }
  throw new Error(`Process Guardian did not reclaim Shell PID ${pid.toString()}`);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
