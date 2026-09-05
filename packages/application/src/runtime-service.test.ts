import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeService,
  type CreateExecutorOptions,
  type ShellExecutionResult,
  type ShellExecutor,
  type ShellExecutorFactory,
  type ShellExecutorLifecycleEvent,
} from "@iterminal/application";
import type { ShellKind } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { agentActor, createTestRuntime, humanActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it } from "vitest";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe.each(["bash", "zsh"] as const)("M1 %s Runtime", (shell: ShellKind) => {
  it("shares cwd and exported environment across equal actors", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell, workspaceRoot: workspace });
    try {
      await runtime.execute({
        actor: agentActor,
        command: "cd packages/web && export ITERM_M1=shared",
        idempotencyKey: `${shell}-state-1`,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const observed = await runtime.execute({
        actor: humanActor,
        command: 'printf \'PWD=%s ENV=%s\\n\' "$PWD" "$ITERM_M1"',
        idempotencyKey: `${shell}-state-2`,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(observed.output).toContain(`PWD=${join(realpathSync(workspace), "packages", "web")}`);
      expect(observed.output).toContain("ENV=shared");
      expect(runtime.getSession(session.id).status).toBe("READY");
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);
});

describe("M1 Action Runtime", () => {
  it("deduplicates concurrent root Session creation and rejects request drift", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const request = {
      idempotencyKey: "session-create-once",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };

    const [first, replay] = await Promise.all([
      runtime.createSession(request),
      runtime.createSession(request),
    ]);
    expect(replay.id).toBe(first.id);
    expect(runtime.listSessions()).toHaveLength(1);
    await expect(runtime.createSession({ ...request, shell: "bash" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await runtime.closeSession(first.id, first.generation);
  });

  it("fails fast when Busy and lets Human/Agent input target one Python execution", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    try {
      const python = await runtime.startExecute({
        actor: agentActor,
        command: "python3 -q",
        idempotencyKey: "python-start",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await python.started;

      await expect(
        runtime.sendInput({
          actor: agentActor,
          data: "ignored\n",
          idempotencyKey: "python-start",
          sessionGeneration: session.generation,
          sessionId: session.id,
          targetExecutionId: python.execution.id,
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));

      await expect(
        runtime.startExecute({
          actor: humanActor,
          command: "pwd",
          idempotencyKey: "busy-execute",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "PTY_BUSY" }));

      await expect(
        runtime.sendInput({
          actor: agentActor,
          data: "ignored\n",
          idempotencyKey: "stale-input",
          sessionGeneration: session.generation,
          sessionId: session.id,
          targetExecutionId: "exe_stale",
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "EXECUTION_CHANGED" }));

      const screenVersion = runtime.getSession(session.id).screenVersion;
      await expect(
        runtime.sendInput({
          actor: agentActor,
          data: "ignored\n",
          expectedScreenVersion: screenVersion + 100,
          idempotencyKey: "stale-screen",
          sessionGeneration: session.generation,
          sessionId: session.id,
          targetExecutionId: python.execution.id,
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "SCREEN_CHANGED" }));

      const humanInput = await runtime.sendInput({
        actor: humanActor,
        data: "shared_value = 41\n",
        idempotencyKey: "python-human-input",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: python.execution.id,
      });
      const agentInput = await runtime.sendInput({
        actor: agentActor,
        data: "print(shared_value + 1)\n",
        idempotencyKey: "python-agent-input",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: python.execution.id,
      });
      await runtime.sendInput({
        actor: humanActor,
        data: "exit()\n",
        idempotencyKey: "python-exit",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: python.execution.id,
      });
      const completed = await python.completion;
      expect(humanInput.targetExecutionId).toBe(python.execution.id);
      expect(agentInput.targetExecutionId).toBe(python.execution.id);
      expect(completed.output).toContain("42");
      expect(completed.status).toBe("COMPLETED");

      const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
      expect(events.events.some((event) => event.type === "interaction.input_delivered")).toBe(
        true,
      );
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);

  it("records TTY Ctrl+C and returns the persistent Shell to READY", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    try {
      const sleeping = await runtime.startExecute({
        actor: agentActor,
        command: "sleep 10",
        idempotencyKey: "sleep-start",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await sleeping.started;
      await delay(100);
      const control = await runtime.sendControl({
        actor: humanActor,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
        idempotencyKey: "sleep-control",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: sleeping.execution.id,
      });
      const interrupted = await sleeping.completion;
      expect(control.status).toBe("DELIVERED");
      expect(interrupted.status).toBe("INTERRUPTED");
      expect(interrupted.exitCode).toBe(130);
      expect(runtime.getSession(session.id).status).toBe("READY");
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);

  it("enforces idempotency request hashes and generation checks", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    try {
      const first = await runtime.execute({
        actor: agentActor,
        command: "true",
        idempotencyKey: "same-key",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const replay = await runtime.execute({
        actor: agentActor,
        command: "true",
        idempotencyKey: "same-key",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(replay.id).toBe(first.id);
      await expect(
        runtime.startExecute({
          actor: agentActor,
          command: "false",
          idempotencyKey: "same-key",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
      await expect(runtime.queryEvents(session.id, session.generation + 1)).rejects.toThrowError(
        expect.objectContaining({ code: "SESSION_GENERATION_CHANGED" }),
      );
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });
});

describe("A01 Shell lifecycle", () => {
  it("breaks an idle READY generation once and rejects later Execute without a PTY write", async () => {
    const factory = new LifecycleExecutorFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const executor = factory.latest();

    executor.emitExit({ exitCode: 7, signal: 9 });
    executor.emitExit({ exitCode: 7, signal: 9 });
    await waitFor(() => runtime.getSession(session.id).status === "BROKEN");

    await expect(
      runtime.startExecute({
        actor: agentActor,
        command: "printf 'must-not-run\\n'",
        idempotencyKey: "after-shell-exit",
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "SESSION_BROKEN" });
    expect(executor.executeCount).toBe(0);
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.filter((event) => event.type === "session.broken")).toHaveLength(1);
    expect(events.events.find((event) => event.type === "session.broken")?.payload).toEqual({
      exitCode: 7,
      reason: "shell_process_exit",
      signal: 9,
    });
  });

  it("settles a RUNNING execution as UNKNOWN once without inventing an exit code", async () => {
    const factory = new LifecycleExecutorFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const running = await runtime.startExecute({
      actor: agentActor,
      command: "sleep 30",
      idempotencyKey: "running-shell-exit",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await running.started;

    const executor = factory.latest();
    executor.emitExit({ exitCode: 137, signal: 9 });
    executor.emitExit({ exitCode: 137, signal: 9 });
    await expect(running.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await waitFor(() => runtime.getSession(session.id).status === "BROKEN");

    const execution = runtime.getExecution(running.execution.id);
    expect(execution.status).toBe("UNKNOWN");
    expect(execution.exitCode).toBeUndefined();
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.filter((event) => event.type === "execution.unknown")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "session.broken")).toHaveLength(1);
  });

  it("ignores stale identity/generation notifications and delayed exit after rebuild", async () => {
    const factory = new LifecycleExecutorFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const executor = factory.latest();

    executor.emitExit({ executorId: "executor_from_old_generation" });
    executor.emitExit({ sessionGeneration: session.generation + 1 });
    await delay(10);

    expect(runtime.getSession(session.id).status).toBe("READY");
    expect((await runtime.queryEvents(session.id, session.generation, 0, 500)).events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session.broken" })]),
    );

    executor.emitExit({ exitCode: 9, signal: 9 });
    await waitFor(() => runtime.getSession(session.id).status === "BROKEN");
    const rebuilt = await runtime.forkSession({
      actor: humanActor,
      allowStale: true,
      expectedCheckpointVersion: 1,
      idempotencyKey: "rebuild-after-shell-exit",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    executor.emitExit({ exitCode: 9, signal: 9 });
    await delay(10);

    expect(runtime.getSession(rebuilt.session.id).status).toBe("READY");
    await runtime.closeSession(rebuilt.session.id, rebuilt.session.generation);
  });

  it("does not turn an active close into a broken lifecycle transition", async () => {
    const factory = new LifecycleExecutorFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const executor = factory.latest();

    await runtime.closeSession(session.id, session.generation);
    executor.emitExit({ exitCode: 0 });
    await delay(10);

    expect(runtime.getSession(session.id).status).toBe("CLOSED");
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.filter((event) => event.type === "session.broken")).toHaveLength(0);
  });

  it("does not publish READY when the executor exits during startup", async () => {
    const factory = new LifecycleExecutorFactory(true);
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);

    await expect(
      runtime.createSession({ shell: "zsh", workspaceRoot: createWorkspace() }),
    ).rejects.toThrow("Shell Executor exited before Session startup completed");

    const [session] = runtime.listSessions();
    expect(session?.status).toBe("BROKEN");
    if (session === undefined) throw new Error("Expected failed Session projection");
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.some((event) => event.type === "session.shell_ready")).toBe(false);
  });
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "iterminal-m1-test-"));
  mkdirSync(join(workspace, "packages", "web"), { recursive: true });
  workspaces.push(workspace);
  return workspace;
}

class LifecycleExecutorFactory implements ShellExecutorFactory {
  readonly #executors: LifecycleExecutor[] = [];

  public constructor(private readonly exitDuringCreate = false) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    const executor = new LifecycleExecutor(options);
    this.#executors.push(executor);
    if (this.exitDuringCreate) executor.emitExit({ exitCode: 1 });
    return Promise.resolve(executor);
  }

  public latest(): LifecycleExecutor {
    const executor = this.#executors.at(-1);
    if (executor === undefined) throw new Error("No lifecycle executor was created");
    return executor;
  }
}

class LifecycleExecutor implements ShellExecutor {
  public readonly shellPid = 424_242;
  public readonly shell: ShellKind;
  public executeCount = 0;

  readonly #options: CreateExecutorOptions;
  #rejectExecution: ((error: Error) => void) | undefined;

  public constructor(options: CreateExecutorOptions) {
    this.#options = options;
    this.shell = options.shell;
  }

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return {
      cwd: this.#options.initialCwd ?? this.#options.workspaceRoot,
      filteredEnvironment: {},
    };
  }

  public execute(
    command: string,
    callbacks: Readonly<{ onStarted: (observedCommand: string) => void }>,
  ): Promise<ShellExecutionResult> {
    this.executeCount += 1;
    callbacks.onStarted(command);
    return new Promise<ShellExecutionResult>((_resolve, reject) => {
      this.#rejectExecution = reject;
    });
  }

  public emitExit(
    overrides: Partial<Omit<ShellExecutorLifecycleEvent, "reason" | "sessionId" | "type">> = {},
  ): void {
    this.#options.onLifecycle({
      executorId: overrides.executorId ?? this.#options.executorId,
      reason: "shell_process_exit",
      sessionGeneration: overrides.sessionGeneration ?? this.#options.sessionGeneration,
      sessionId: this.#options.sessionId,
      type: "exited",
      ...(overrides.exitCode === undefined ? {} : { exitCode: overrides.exitCode }),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    });
    this.#rejectExecution?.(new Error("Fixture Shell exited"));
    this.#rejectExecution = undefined;
  }

  public writeInput(): void {}
  public writeSecret(): void {}
  public finishSensitiveOutput(): void {}
  public sendControl(): void {}
  public resize(): void {}
  public close(): void {}
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle state");
    await delay(5);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
