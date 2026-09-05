import { tmpdir } from "node:os";

import {
  RuntimeService,
  type ArtifactReadRequest,
  type CreateExecutorOptions,
  type RuntimeDurability,
  type ShellExecutor,
  type ShellExecutorFactory,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

describe("Application Artifact reads", () => {
  it("returns durable bytes without allocating Actions, Events, sequences, or PTY writes", async () => {
    const executor = new ReadOnlyExecutor();
    const store = new MemoryRuntimeStore();
    const session = {
      actionSequence: 0,
      createdAt: new Date(0).toISOString(),
      eventSequence: 0,
      generation: 1,
      id: "session-artifact-read",
      ownerId: "local",
      screenVersion: 0,
      shell: "zsh" as const,
      status: "READY" as const,
      workspaceRoot: "/tmp",
    };
    store.createSession(session);
    const runtime = new RuntimeService(store, new ReadOnlyExecutorFactory(executor), {
      durability: {
        readArtifact: (request: ArtifactReadRequest) =>
          Promise.resolve({
            artifactId: request.artifactId,
            contentBase64: Buffer.from("sanitized", "utf8").toString("base64"),
            contentType: "application/octet-stream",
            eof: true,
            generation: request.generation,
            kind: "found",
            nextOffset: 9,
            offsetBytes: request.offsetBytes,
            returnedBytes: 9,
            sessionId: request.sessionId,
            totalBytes: 9,
          }),
      } as unknown as RuntimeDurability,
    });
    const before = runtime.getSession(session.id);

    await expect(
      runtime.readArtifact({
        artifactId: "art_sanitized",
        generation: session.generation,
        offsetBytes: 0,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ kind: "found", returnedBytes: 9 });

    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: before.actionSequence,
      eventSequence: before.eventSequence,
    });
    expect(executor.writes).toBe(0);
  });

  it("separates invalid ranges and durable outages from scoped read outcomes", async () => {
    const unavailable = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory());
    await expect(
      unavailable.readArtifact({
        artifactId: "art_missing",
        generation: 1,
        offsetBytes: 0,
        sessionId: "session-missing",
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
      retryable: true,
    });

    const failed = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory(), {
      durability: {
        readArtifact: () => Promise.reject(new Error("database credentials must stay private")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      failed.readArtifact({
        artifactId: "art_unknown",
        generation: 1,
        offsetBytes: 0,
        sessionId: "session-unknown",
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      message: "Durable Artifact reading is temporarily unavailable",
    });

    const invalid = new RuntimeService(new MemoryRuntimeStore(), new ReadOnlyExecutorFactory(), {
      durability: {
        readArtifact: () =>
          Promise.reject(new RuntimeError("INVALID_REQUEST", "Artifact offset exceeds range")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      invalid.readArtifact({
        artifactId: "art_retained",
        generation: 1,
        offsetBytes: 4,
        sessionId: "session-retained",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
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
    throw new Error("Artifact read must not execute");
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
