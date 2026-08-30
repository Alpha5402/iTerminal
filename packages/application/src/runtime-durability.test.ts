import type {
  DurableExecuteAdmission,
  DurableExecuteAdmissionResult,
  RuntimeDurability,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
} from "./index.js";
import type { EventPage } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

import { RuntimeService } from "./runtime-service.js";

const actor = {
  client: "durability-test",
  id: "agent-durability",
  principal: "durability-test",
  type: "agent" as const,
};

describe("Runtime durable write-ahead boundary", () => {
  it("keeps external Execute reserved until one idempotent owner dispatch", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      executionDispatch: "external",
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const admitted = await runtime.startExecute({
      actor,
      command: "python3 -q",
      idempotencyKey: "external-dispatch",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(executor.commands).toEqual([]);
    expect(runtime.getSession(session.id).status).toBe("RESERVED");

    const [left, right] = await Promise.all([
      runtime.dispatchExecution(admitted.execution.id),
      runtime.dispatchExecution(admitted.execution.id),
    ]);
    expect(left.execution.id).toBe(admitted.execution.id);
    expect(right.execution.id).toBe(admitted.execution.id);
    expect(executor.commands).toEqual(["python3 -q"]);
    expect(durability.writeAttempts).toBe(1);
    await runtime.closeSession(session.id, session.generation);
  });

  it("does not write Execute to the Shell when durable admission fails", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    durability.failExecute = true;

    await expect(
      runtime.startExecute({
        actor,
        command: "touch must-not-run",
        idempotencyKey: "execute-before-write",
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(executor.commands).toEqual([]);
    expect(executor.closed).toBe(true);
    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: 0,
      status: "BROKEN",
    });
  });

  it("does not write Input when its immutable Action cannot be persisted", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const started = await runtime.startExecute({
      actor,
      command: "python3 -q",
      idempotencyKey: "interactive-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    durability.failInteraction = true;

    await expect(
      runtime.sendInput({
        actor,
        data: "print('must-not-run')\n",
        idempotencyKey: "input-before-write",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(executor.inputs).toEqual([]);
    expect(executor.closed).toBe(true);
    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: 1,
      status: "BROKEN",
    });
  });
});

class RecordingFactory implements ShellExecutorFactory {
  public constructor(private readonly executor: RecordingExecutor) {}

  public create(): Promise<ShellExecutor> {
    return Promise.resolve(this.executor);
  }
}

class RecordingExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public readonly commands: string[] = [];
  public readonly inputs: string[] = [];
  public closed = false;

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    this.commands.push(command);
    callbacks.onStarted(command);
    return new Promise(() => undefined);
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public sendControl(): void {}

  public close(): void {
    this.closed = true;
  }
}

class ControlledDurability implements RuntimeDurability {
  public failExecute = false;
  public failInteraction = false;
  public writeAttempts = 0;

  public createSession(): Promise<void> {
    return Promise.resolve();
  }

  public markSessionReady(): Promise<void> {
    return Promise.resolve();
  }

  public markSessionBroken(): Promise<void> {
    return Promise.resolve();
  }

  public closeSession(): Promise<void> {
    return Promise.resolve();
  }

  public acceptExecute(input: DurableExecuteAdmission): Promise<DurableExecuteAdmissionResult> {
    if (this.failExecute) return Promise.reject(unavailable());
    return Promise.resolve({
      actionId: input.action.id,
      actionSequence: input.action.actionSequence,
      executionId: input.execution.id,
      replayed: false,
    });
  }

  public markExecutionRunning(): Promise<void> {
    return Promise.resolve();
  }

  public markExecutionWriteAttempted(): Promise<void> {
    this.writeAttempts += 1;
    return Promise.resolve();
  }

  public finishExecution(): Promise<void> {
    return Promise.resolve();
  }

  public failExecution(): Promise<void> {
    return Promise.resolve();
  }

  public acceptInteraction(): Promise<void> {
    return this.failInteraction ? Promise.reject(unavailable()) : Promise.resolve();
  }

  public finishInteraction(): Promise<void> {
    return Promise.resolve();
  }

  public appendEvent(): Promise<void> {
    return Promise.resolve();
  }

  public queryEvents(): Promise<EventPage> {
    return Promise.resolve({ events: [], truncated: false });
  }

  public recoverOwner(): Promise<{
    readonly brokenSessions: number;
    readonly unknownExecutions: number;
  }> {
    return Promise.resolve({ brokenSessions: 0, unknownExecutions: 0 });
  }
}

function unavailable(): RuntimeError {
  return new RuntimeError("RUNTIME_UNAVAILABLE", "injected durable failure", {}, true);
}
