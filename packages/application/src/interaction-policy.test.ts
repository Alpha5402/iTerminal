import type { Actor, ControlDelivery, ShellKind } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

import type {
  CreateExecutorOptions,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
} from "./ports.js";
import { RuntimeService } from "./runtime-service.js";

const human: Actor = {
  client: "console-a",
  id: "human-a",
  principal: "local-human-a",
  type: "human",
};
const otherHuman: Actor = {
  client: "console-b",
  id: "human-b",
  principal: "local-human-b",
  type: "human",
};
const agent: Actor = {
  client: "mcp-a",
  id: "agent-a",
  principal: "local-agent-a",
  type: "agent",
};
const scheduler: Actor = {
  client: "scheduler-a",
  id: "scheduler-a",
  principal: "local-scheduler-a",
  type: "scheduler",
};
const system: Actor = {
  client: "runtime-system",
  id: "system-a",
  principal: "local-system",
  type: "system",
};

describe("M6.5 interaction policy and short Guard", () => {
  it("enforces the complete four-policy by four-Actor interaction matrix", async () => {
    const fixture = await createRunningFixture();
    const modes = ["common", "human_guarded", "human_only", "agent_only"] as const;
    const actors = [human, agent, scheduler, system] as const;
    let state = await fixture.runtime.getInteractionState(
      fixture.session.id,
      fixture.session.generation,
    );
    try {
      for (const mode of modes) {
        if (state.policy !== mode) {
          state = await fixture.runtime.setInputPolicy({
            actor: human,
            expectedVersion: state.version,
            mode,
            sessionGeneration: fixture.session.generation,
            sessionId: fixture.session.id,
          });
        }
        for (const candidate of actors) {
          const request = fixture.runtime.sendInput({
            actor: candidate,
            data: `${mode}:${candidate.type}\n`,
            idempotencyKey: `matrix-${mode}-${candidate.type}`,
            sessionGeneration: fixture.session.generation,
            sessionId: fixture.session.id,
            targetExecutionId: fixture.executionId,
          });
          const allowed =
            (mode === "common" || mode === "human_guarded") &&
            (candidate.type === "human" || candidate.type === "agent")
              ? true
              : (mode === "human_only" && candidate.type === "human") ||
                (mode === "agent_only" && candidate.type === "agent");
          if (allowed) {
            await expect(request).resolves.toMatchObject({ status: "DELIVERED" });
          } else {
            await expect(request).rejects.toMatchObject({ code: "POLICY_DENIED" });
          }
        }
      }
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("guards Human raw interaction, permits audited emergency Control, and enforces modes", async () => {
    const fixture = await createRunningFixture();
    try {
      const initial = await fixture.runtime.getInteractionState(
        fixture.session.id,
        fixture.session.generation,
      );
      expect(initial).toEqual({
        policy: "human_guarded",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        version: 1,
      });

      const guarded = await fixture.runtime.acquireInteractionGuard({
        actor: human,
        expectedVersion: initial.version,
        reason: "raw key batch",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        ttlMilliseconds: 500,
      });
      await expect(
        fixture.runtime.sendInput({
          actor: agent,
          data: "agent-blocked\n",
          idempotencyKey: "guarded-agent",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "INPUT_GUARDED", retryable: true });
      expect(fixture.executor.inputs).toEqual([]);

      await fixture.runtime.sendInput({
        actor: human,
        data: "human-batch\n",
        idempotencyKey: "guard-holder-input",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        targetExecutionId: fixture.executionId,
      });
      await fixture.runtime.sendControl({
        actor: otherHuman,
        bypassGuard: true,
        delivery: { control: "ESC", mode: "TTY_CONTROL" },
        idempotencyKey: "emergency-control",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        targetExecutionId: fixture.executionId,
      });
      expect(fixture.executor.inputs).toEqual(["human-batch\n"]);
      expect(fixture.executor.controls).toEqual([{ control: "ESC", mode: "TTY_CONTROL" }]);

      const humanOnly = await fixture.runtime.setInputPolicy({
        actor: human,
        expectedVersion: guarded.version,
        mode: "human_only",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
      });
      expect(humanOnly).toMatchObject({ policy: "human_only", version: guarded.version + 1 });
      expect(humanOnly.guard).toBeUndefined();
      await expect(
        fixture.runtime.sendInput({
          actor: agent,
          data: "denied\n",
          idempotencyKey: "human-only-agent",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED", retryable: false });

      const agentOnly = await fixture.runtime.setInputPolicy({
        actor: human,
        expectedVersion: humanOnly.version,
        mode: "agent_only",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
      });
      await expect(
        fixture.runtime.sendControl({
          actor: human,
          bypassGuard: true,
          delivery: { control: "ESC", mode: "TTY_CONTROL" },
          idempotencyKey: "agent-only-human-control",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await fixture.runtime.sendInput({
        actor: agent,
        data: "agent-allowed\n",
        idempotencyKey: "agent-only-agent",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        targetExecutionId: fixture.executionId,
      });

      const common = await fixture.runtime.setInputPolicy({
        actor: human,
        expectedVersion: agentOnly.version,
        mode: "common",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
      });
      await expect(
        fixture.runtime.sendInput({
          actor: scheduler,
          data: "scheduler-denied\n",
          idempotencyKey: "common-scheduler",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(common.policy).toBe("common");
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("expires lazily once, caps renewals, and rejects stale versions", async () => {
    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const fixture = await createRunningFixture(() => new Date(now));
    try {
      let state = await fixture.runtime.acquireInteractionGuard({
        actor: human,
        expectedVersion: 1,
        reason: "bounded typing",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        ttlMilliseconds: 100,
      });
      const guardId = required(state.guard).id;
      for (let renewal = 1; renewal <= 3; renewal += 1) {
        state = await fixture.runtime.renewInteractionGuard({
          actor: human,
          expectedVersion: state.version,
          guardId,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          ttlMilliseconds: 100,
        });
        expect(state.guard?.renewals).toBe(renewal);
      }
      await expect(
        fixture.runtime.renewInteractionGuard({
          actor: human,
          expectedVersion: state.version,
          guardId,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          ttlMilliseconds: 100,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });

      now += 101;
      const expired = await fixture.runtime.getInteractionState(
        fixture.session.id,
        fixture.session.generation,
      );
      expect(expired.guard).toBeUndefined();
      expect(expired.version).toBe(state.version + 1);
      const reread = await fixture.runtime.getInteractionState(
        fixture.session.id,
        fixture.session.generation,
      );
      expect(reread.version).toBe(expired.version);
      await expect(
        fixture.runtime.releaseInteractionGuard({
          actor: human,
          expectedVersion: state.version,
          guardId,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "INTERACTION_GUARD_CHANGED",
        details: { currentVersion: expired.version, expectedVersion: state.version },
      });

      const events = await fixture.runtime.queryEvents(
        fixture.session.id,
        fixture.session.generation,
        0,
        500,
      );
      expect(
        events.events.filter((event) => event.type === "interaction.guard_expired"),
      ).toHaveLength(1);
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("returns an accepted idempotent replay before evaluating a later policy", async () => {
    const fixture = await createRunningFixture();
    try {
      const first = await fixture.runtime.sendInput({
        actor: agent,
        data: "once\n",
        idempotencyKey: "accepted-before-policy",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        targetExecutionId: fixture.executionId,
      });
      const humanOnly = await fixture.runtime.setInputPolicy({
        actor: human,
        expectedVersion: 1,
        mode: "human_only",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
      });
      const replay = await fixture.runtime.sendInput({
        actor: agent,
        data: "once\n",
        idempotencyKey: "accepted-before-policy",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
        targetExecutionId: fixture.executionId,
      });
      expect(replay.id).toBe(first.id);
      expect(fixture.executor.inputs).toEqual(["once\n"]);
      expect(humanOnly.policy).toBe("human_only");
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });
});

async function createRunningFixture(now?: () => Date): Promise<{
  readonly executionId: string;
  readonly executor: InteractiveExecutor;
  readonly runtime: RuntimeService;
  readonly session: Awaited<ReturnType<RuntimeService["createSession"]>>;
}> {
  const factory = new InteractiveExecutorFactory();
  const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
    ...(now === undefined ? {} : { now }),
  });
  const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
  const started = await runtime.startExecute({
    actor: agent,
    command: "interactive-fixture",
    idempotencyKey: "start-interactive",
    sessionGeneration: session.generation,
    sessionId: session.id,
  });
  await started.started;
  return {
    executionId: started.execution.id,
    executor: required(factory.executor),
    runtime,
    session,
  };
}

class InteractiveExecutorFactory implements ShellExecutorFactory {
  public executor: InteractiveExecutor | undefined;

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.executor = new InteractiveExecutor(options.shell);
    return Promise.resolve(this.executor);
  }
}

class InteractiveExecutor implements ShellExecutor {
  public readonly shellPid = 4242;
  public readonly inputs: string[] = [];
  public readonly controls: ControlDelivery[] = [];

  public constructor(public readonly shell: ShellKind) {}

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    callbacks.onStarted(command);
    return new Promise(() => undefined);
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public sendControl(delivery: ControlDelivery): void {
    this.controls.push(delivery);
  }

  public close(): void {}
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
