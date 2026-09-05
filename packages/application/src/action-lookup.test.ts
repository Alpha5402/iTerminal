import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeService,
  type ActionLookupFound,
  type CreateExecutorOptions,
  type RuntimeDurability,
  type ShellExecutionResult,
  type ShellExecutor,
  type ShellExecutorFactory,
} from "@iterminal/application";
import { ACTOR_CAPABILITY_PROFILES, RuntimeError, type Actor } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { afterEach, describe, expect, it } from "vitest";

const workspaces: string[] = [];
const actor: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "lookup-test",
  id: "agent-lookup",
  principal: "lookup-principal",
  type: "agent",
};

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { force: true, recursive: true });
});

describe("Action lookup", () => {
  it("observes a delayed acceptance without allocating or writing during either lookup", async () => {
    const store = new MemoryRuntimeStore();
    const executor = new CountingExecutor();
    const runtime = new RuntimeService(store, new CountingExecutorFactory(executor));
    const workspace = mkdtempSync(join(tmpdir(), "iterminal-action-lookup-"));
    workspaces.push(workspace);
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });

    const request = {
      actor,
      generation: session.generation,
      idempotencyKey: "delayed-action",
      sessionId: session.id,
    };
    expect(await runtime.lookupAction(request)).toMatchObject({
      kind: "not_found",
      mayStillBeInFlight: true,
    });
    expect(runtime.getSession(session.id).actionSequence).toBe(0);
    expect(executor.executeCalls).toBe(0);
    expect(executor.inputWrites).toBe(0);

    const execution = await runtime.execute({
      actor,
      command: "printf accepted",
      idempotencyKey: request.idempotencyKey,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    const writesAfterAcceptance = executor.executeCalls;
    const sequenceAfterAcceptance = runtime.getSession(session.id).actionSequence;
    const found = await runtime.lookupAction(request);
    expect(found).toMatchObject({
      actionId: execution.actionId,
      actionStatus: "COMPLETED",
      actionType: "execute",
      executionId: execution.id,
      executionStatus: "COMPLETED",
      kind: "found",
    });
    expect(found).not.toHaveProperty("requestHash");
    expect(found).not.toHaveProperty("command");
    expect(found).not.toHaveProperty("actor");
    expect(runtime.getSession(session.id).actionSequence).toBe(sequenceAfterAcceptance);
    expect(executor.executeCalls).toBe(writesAfterAcceptance);
    expect(executor.inputWrites).toBe(0);

    await runtime.closeSession(session.id, session.generation);
  });

  it("does not disclose facts across generation, Actor scope, or immutable identity", async () => {
    const runtime = new RuntimeService(
      new MemoryRuntimeStore(),
      new CountingExecutorFactory(new CountingExecutor()),
    );
    const workspace = mkdtempSync(join(tmpdir(), "iterminal-action-lookup-scope-"));
    workspaces.push(workspace);
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    await runtime.execute({
      actor,
      command: "true",
      idempotencyKey: "scoped-action",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });

    for (const requestActor of [
      { ...actor, id: "agent-other", principal: "other-principal" },
      { ...actor, principal: "forged-principal" },
    ]) {
      await expect(
        runtime.lookupAction({
          actor: requestActor,
          generation: session.generation,
          idempotencyKey: "scoped-action",
          sessionId: session.id,
        }),
      ).resolves.toMatchObject({ kind: "not_found", mayStillBeInFlight: true });
    }
    await expect(
      runtime.lookupAction({
        actor,
        generation: session.generation + 1,
        idempotencyKey: "scoped-action",
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ kind: "not_found", mayStillBeInFlight: true });

    await runtime.closeSession(session.id, session.generation);
  });

  it("preserves durable UNKNOWN and separates identity mismatch from infrastructure failure", async () => {
    const durableFound: ActionLookupFound = {
      acceptedAt: new Date(0).toISOString(),
      actionId: "act-unknown",
      actionStatus: "UNKNOWN",
      actionType: "execute",
      executionId: "exe-unknown",
      executionStatus: "UNKNOWN",
      generation: 4,
      idempotencyKey: "unknown-action",
      kind: "found",
      sessionId: "session-durable",
    };
    const foundRuntime = new RuntimeService(new MemoryRuntimeStore(), unavailableFactory(), {
      durability: {
        lookupAction: () => Promise.resolve(durableFound),
      } as unknown as RuntimeDurability,
    });
    await expect(
      foundRuntime.lookupAction({
        actor,
        generation: 4,
        idempotencyKey: "unknown-action",
        sessionId: "session-durable",
      }),
    ).resolves.toEqual(durableFound);

    const conflicting = new RuntimeService(new MemoryRuntimeStore(), unavailableFactory(), {
      durability: {
        lookupAction: () =>
          Promise.reject(new RuntimeError("ACTOR_IDENTITY_CONFLICT", "identity mismatch")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      conflicting.lookupAction({
        actor,
        generation: 4,
        idempotencyKey: "unknown-action",
        sessionId: "session-durable",
      }),
    ).resolves.toMatchObject({ kind: "not_found" });

    const unavailable = new RuntimeService(new MemoryRuntimeStore(), unavailableFactory(), {
      durability: {
        lookupAction: () => Promise.reject(new Error("database down")),
      } as unknown as RuntimeDurability,
    });
    await expect(
      unavailable.lookupAction({
        actor,
        generation: 4,
        idempotencyKey: "unknown-action",
        sessionId: "session-durable",
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
      retryable: true,
    });
  });
});

class CountingExecutorFactory implements ShellExecutorFactory {
  public constructor(private readonly executor: CountingExecutor) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.executor.options = options;
    return Promise.resolve(this.executor);
  }
}

class CountingExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public executeCalls = 0;
  public inputWrites = 0;
  public options: CreateExecutorOptions | undefined;

  public checkpoint() {
    return { cwd: this.options?.workspaceRoot ?? tmpdir(), filteredEnvironment: {} };
  }

  public execute(
    command: string,
    callbacks: { onStarted(observedCommand: string): void; onWriteAccepted?(): void },
  ): Promise<ShellExecutionResult> {
    this.executeCalls += 1;
    callbacks.onWriteAccepted?.();
    callbacks.onStarted(command);
    return Promise.resolve({
      cwd: this.options?.workspaceRoot ?? tmpdir(),
      exitCode: 0,
      filteredEnvironment: {},
      output: "accepted",
      outputTruncated: false,
    });
  }

  public writeInput(): void {
    this.inputWrites += 1;
  }

  public writeSecret(): void {
    this.inputWrites += 1;
  }

  public finishSensitiveOutput(): void {}
  public sendControl(): void {}
  public resize(): void {}
  public close(): void {}
}

function unavailableFactory(): ShellExecutorFactory {
  return { create: () => Promise.reject(new Error("executor must not be created")) };
}
