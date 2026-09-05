import { tmpdir } from "node:os";

import {
  RuntimeService,
  type CreateExecutorOptions,
  type ExecutionOutputReadRequest,
  type RuntimeDurability,
  type ShellExecutor,
  type ShellExecutorFactory,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

describe("Application durable Execution output reads", () => {
  it("returns durable bytes without allocating Actions, Events, sequences, or PTY writes", async () => {
    const executor = new ReadOnlyExecutor();
    const store = new MemoryRuntimeStore();
    const session = {
      actionSequence: 7,
      createdAt: new Date(0).toISOString(),
      eventSequence: 11,
      generation: 1,
      id: "session-output-read",
      ownerId: "local",
      screenVersion: 3,
      shell: "zsh" as const,
      status: "RUNNING" as const,
      workspaceRoot: "/tmp",
    };
    store.createSession(session);
    const runtime = new RuntimeService(store, new ReadOnlyExecutorFactory(executor), {
      durability: {
        readExecutionOutput: (request: ExecutionOutputReadRequest) =>
          Promise.resolve({
            chunks: [
              { byteLength: 9, contentBase64: Buffer.from("sanitized", "utf8").toString("base64") },
            ],
            encoding: "base64",
            executionId: request.executionId,
            executionState: "RUNNING",
            gap: null,
            generation: request.generation,
            hasMore: false,
            nextCursor: "opaque-cursor",
            persistenceLag: "possible",
            retention: { minimumAvailableSequence: 1, source: "durable" },
            sessionId: request.sessionId,
            stream: "pty",
          }),
      } as unknown as RuntimeDurability,
    });
    const before = runtime.getSession(session.id);

    await expect(
      runtime.readExecutionOutput({
        executionId: "execution-output-read",
        generation: session.generation,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({
      executionState: "RUNNING",
      hasMore: false,
      persistenceLag: "possible",
    });

    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: before.actionSequence,
      eventSequence: before.eventSequence,
      status: "RUNNING",
    });
    expect(executor.writes).toBe(0);
  });

  it("preserves semantic cursor errors and classifies infrastructure failures", async () => {
    const unavailable = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory());
    await expect(
      unavailable.readExecutionOutput({
        executionId: "execution-missing",
        generation: 1,
        sessionId: "session-missing",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });

    const failed = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory(), {
      durability: {
        readExecutionOutput: () =>
          Promise.reject(new Error("database credentials must not cross Application")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      failed.readExecutionOutput({
        executionId: "execution-failed",
        generation: 1,
        sessionId: "session-failed",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: "Durable Execution output reading is temporarily unavailable",
    });

    const resync = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory(), {
      durability: {
        readExecutionOutput: () =>
          Promise.reject(new RuntimeError("RESYNC_REQUIRED", "Cursor is outside retention")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      resync.readExecutionOutput({
        cursor: "opaque",
        executionId: "execution-retained",
        generation: 1,
        sessionId: "session-retained",
      }),
    ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  });
});

class ReadOnlyExecutorFactory implements ShellExecutorFactory {
  public constructor(private readonly executor = new ReadOnlyExecutor()) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.executor.options = options;
    return Promise.resolve(this.executor);
  }
}

class ReadOnlyExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public options: CreateExecutorOptions | undefined;
  public writes = 0;

  public checkpoint() {
    return { cwd: this.options?.workspaceRoot ?? tmpdir(), filteredEnvironment: {} };
  }

  public execute(): never {
    this.writes += 1;
    throw new Error("Execution output read must not execute");
  }

  public writeInput(): void {
    this.writes += 1;
  }

  public writeSecret(): void {
    this.writes += 1;
  }

  public finishSensitiveOutput(): void {}
  public sendControl(): void {
    this.writes += 1;
  }

  public resize(): void {
    this.writes += 1;
  }

  public close(): void {}
}
