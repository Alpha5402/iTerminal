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
import type { ControlDelivery, ShellKind } from "@iterminal/domain";
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

describe("A04 HTTP/Application idempotency ordering", () => {
  it("replays Execute/Input/Control facts before freshness without repeating executor writes", async () => {
    const factory = new CountingExecutorFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const executeRequest = {
      actor: agentActor,
      command: "fixture-interactive-command",
      idempotencyKey: "a04-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    } as const;

    const first = await runtime.startExecute(executeRequest);
    await first.started;
    const executor = factory.latest();
    const inputRequest = {
      actor: agentActor,
      data: "fixture input\n",
      idempotencyKey: "a04-input",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: first.execution.id,
    } as const;
    const controlRequest = {
      actor: agentActor,
      delivery: { control: "ESC", mode: "TTY_CONTROL" },
      idempotencyKey: "a04-control",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: first.execution.id,
    } as const;
    const input = await runtime.sendInput(inputRequest);
    const control = await runtime.sendControl(controlRequest);
    expect(executor.inputWrites).toEqual([inputRequest.data]);
    expect(executor.controlWrites).toEqual([controlRequest.delivery]);

    executor.complete();
    await expect(first.completion).resolves.toMatchObject({ status: "COMPLETED" });
    expect(runtime.getSession(session.id).status).toBe("READY");

    const executeReplay = await runtime.startExecute(executeRequest);
    const inputReplay = await runtime.sendInput(inputRequest);
    const controlReplay = await runtime.sendControl(controlRequest);
    expect(executeReplay.action.id).toBe(first.action.id);
    expect(executeReplay.execution.id).toBe(first.execution.id);
    expect(inputReplay.id).toBe(input.id);
    expect(controlReplay.id).toBe(control.id);
    expect(executor.executeCount).toBe(1);
    expect(executor.inputWrites).toEqual([inputRequest.data]);
    expect(executor.controlWrites).toEqual([controlRequest.delivery]);

    await expect(
      runtime.startExecute({ ...executeRequest, command: "changed-command" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      runtime.sendInput({ ...inputRequest, data: "changed input\n" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      runtime.sendControl({
        ...controlRequest,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const forgedActor = { ...agentActor, principal: "forged-principal" };
    await expect(
      runtime.startExecute({ ...executeRequest, actor: forgedActor }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
    await expect(runtime.sendInput({ ...inputRequest, actor: forgedActor })).rejects.toMatchObject({
      code: "ACTOR_IDENTITY_CONFLICT",
    });
    await expect(
      runtime.sendControl({ ...controlRequest, actor: forgedActor }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
    const strippedActor = { ...agentActor, capabilities: ["session.execute"] as const };
    await expect(
      runtime.sendInput({ ...inputRequest, actor: strippedActor }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
    await expect(
      runtime.sendControl({ ...controlRequest, actor: strippedActor }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });

    const otherPrincipal = await runtime.startExecute({ ...executeRequest, actor: humanActor });
    await otherPrincipal.started;
    expect(otherPrincipal.action.id).not.toBe(first.action.id);
    expect(otherPrincipal.execution.id).not.toBe(first.execution.id);
    expect(executor.executeCount).toBe(2);
    await expect(
      runtime.sendInput({ ...inputRequest, idempotencyKey: "a04-stale-input" }),
    ).rejects.toMatchObject({ code: "EXECUTION_CHANGED" });
    await expect(
      runtime.sendControl({ ...controlRequest, idempotencyKey: "a04-stale-control" }),
    ).rejects.toMatchObject({ code: "EXECUTION_CHANGED" });
    executor.complete();
    await otherPrincipal.completion;
    await runtime.closeSession(session.id, session.generation);
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

describe("A02 fatal execution settlement", () => {
  it("marks a definite pre-write adapter rejection FAILED and releases its executor", async () => {
    const factory = new FailureMatrixExecutorFactory("before_write_failure");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "printf 'not-written\n'",
      idempotencyKey: "a02-before-write",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    await expect(started.started).rejects.toThrow("Fixture rejected before write");
    await expect(started.completion).rejects.toThrow("Fixture rejected before write");
    expect(runtime.getExecution(started.execution.id).status).toBe("FAILED");
    expect(runtime.getSession(session.id).status).toBe("BROKEN");
    expect(factory.latest().closeCount).toBe(1);
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.filter((event) => event.type === "execution.failed")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "execution.unknown")).toHaveLength(0);
  });

  it("marks an accepted write without completion UNKNOWN and releases its executor", async () => {
    const factory = new FailureMatrixExecutorFactory("after_write_failure");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "printf 'delivery-uncertain\n'",
      idempotencyKey: "a02-after-write",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    await expect(started.started).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await expect(started.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    const execution = runtime.getExecution(started.execution.id);
    expect(execution.status).toBe("UNKNOWN");
    expect(execution.exitCode).toBeUndefined();
    expect(runtime.getSession(session.id).status).toBe("BROKEN");
    expect(factory.latest().closeCount).toBe(1);
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(events.events.filter((event) => event.type === "execution.unknown")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "execution.failed")).toHaveLength(0);
  });

  it("settles a pre-start accepted write in external dispatch without deadlocking", async () => {
    const factory = new FailureMatrixExecutorFactory("after_write_failure");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
      executionDispatch: "external",
    });
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const admitted = await runtime.startExecute({
      actor: agentActor,
      command: "printf 'external-delivery-uncertain\n'",
      idempotencyKey: "a02-external-after-write",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    await expect(runtime.dispatchExecution(admitted.execution.id)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
    });
    await expect(admitted.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    expect(runtime.getExecution(admitted.execution.id).status).toBe("UNKNOWN");
    expect(runtime.getSession(session.id).status).toBe("BROKEN");
    expect(factory.latest().closeCount).toBe(1);
  });

  it("keeps a real completion result and the executor writable for the next action", async () => {
    const factory = new FailureMatrixExecutorFactory("completion");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory);
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });

    const completed = await runtime.execute({
      actor: agentActor,
      command: "true",
      idempotencyKey: "a02-completed",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.exitCode).toBe(0);
    expect(runtime.getSession(session.id).status).toBe("READY");
    expect(factory.latest().closeCount).toBe(0);
    await runtime.closeSession(session.id, session.generation);
  });

  it("preserves an observed completion through external dispatch", async () => {
    const factory = new FailureMatrixExecutorFactory("completion");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
      executionDispatch: "external",
    });
    const session = await runtime.createSession({
      shell: "zsh",
      workspaceRoot: createWorkspace(),
    });
    const admitted = await runtime.startExecute({
      actor: agentActor,
      command: "true",
      idempotencyKey: "a02-external-completed",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    const dispatched = await runtime.dispatchExecution(admitted.execution.id);
    await expect(dispatched.completion).resolves.toMatchObject({
      exitCode: 0,
      status: "COMPLETED",
    });
    expect(runtime.getSession(session.id).status).toBe("READY");
    expect(factory.latest().closeCount).toBe(0);
    await runtime.closeSession(session.id, session.generation);
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

type FailureMatrixMode = "before_write_failure" | "after_write_failure" | "completion";

class FailureMatrixExecutorFactory implements ShellExecutorFactory {
  #executor: FailureMatrixExecutor | undefined;

  public constructor(private readonly mode: FailureMatrixMode) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.#executor = new FailureMatrixExecutor(options, this.mode);
    return Promise.resolve(this.#executor);
  }

  public latest(): FailureMatrixExecutor {
    if (this.#executor === undefined) throw new Error("No failure-matrix executor was created");
    return this.#executor;
  }
}

class FailureMatrixExecutor implements ShellExecutor {
  public readonly shellPid = 424_243;
  public readonly shell: ShellKind;
  public closeCount = 0;

  public constructor(
    private readonly options: CreateExecutorOptions,
    private readonly mode: FailureMatrixMode,
  ) {
    this.shell = options.shell;
  }

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: this.options.workspaceRoot, filteredEnvironment: {} };
  }

  public execute(
    command: string,
    callbacks: Readonly<{
      onStarted: (observedCommand: string) => void;
      onWriteAccepted?: () => void;
    }>,
  ): Promise<ShellExecutionResult> {
    if (this.mode === "before_write_failure") {
      return Promise.reject(new Error("Fixture rejected before write"));
    }
    callbacks.onWriteAccepted?.();
    if (this.mode === "after_write_failure") {
      return Promise.reject(new Error("Fixture rejected after write"));
    }
    callbacks.onStarted(command);
    return Promise.resolve({
      cwd: this.options.workspaceRoot,
      exitCode: 0,
      filteredEnvironment: {},
      output: "",
      outputTruncated: false,
    });
  }

  public writeInput(): void {}
  public writeSecret(): void {}
  public finishSensitiveOutput(): void {}
  public sendControl(): void {}
  public resize(): void {}

  public close(): void {
    this.closeCount += 1;
  }
}

class CountingExecutorFactory implements ShellExecutorFactory {
  #executor: CountingExecutor | undefined;

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.#executor = new CountingExecutor(options);
    return Promise.resolve(this.#executor);
  }

  public latest(): CountingExecutor {
    if (this.#executor === undefined) throw new Error("No counting executor was created");
    return this.#executor;
  }
}

class CountingExecutor implements ShellExecutor {
  public readonly shellPid = 424_244;
  public readonly shell: ShellKind;
  public readonly controlWrites: ControlDelivery[] = [];
  public readonly inputWrites: string[] = [];
  public executeCount = 0;

  readonly #options: CreateExecutorOptions;
  #resolveExecution: ((result: ShellExecutionResult) => void) | undefined;

  public constructor(options: CreateExecutorOptions) {
    this.#options = options;
    this.shell = options.shell;
  }

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: this.#options.workspaceRoot, filteredEnvironment: {} };
  }

  public execute(
    command: string,
    callbacks: Readonly<{
      onStarted: (observedCommand: string) => void;
      onWriteAccepted?: () => void;
    }>,
  ): Promise<ShellExecutionResult> {
    this.executeCount += 1;
    callbacks.onWriteAccepted?.();
    callbacks.onStarted(command);
    return new Promise<ShellExecutionResult>((resolve) => {
      this.#resolveExecution = resolve;
    });
  }

  public complete(): void {
    const resolve = this.#resolveExecution;
    if (resolve === undefined) throw new Error("No counting execution is running");
    this.#resolveExecution = undefined;
    resolve({
      cwd: this.#options.workspaceRoot,
      exitCode: 0,
      filteredEnvironment: {},
      output: "",
      outputTruncated: false,
    });
  }

  public writeInput(data: string): void {
    this.inputWrites.push(data);
  }

  public sendControl(delivery: ControlDelivery): void {
    this.controlWrites.push(delivery);
  }

  public writeSecret(): void {}
  public finishSensitiveOutput(): void {}
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
