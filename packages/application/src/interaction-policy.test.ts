import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
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
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  type: "human",
};
const otherHuman: Actor = {
  client: "console-b",
  id: "human-b",
  principal: "local-human-b",
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  type: "human",
};
const agent: Actor = {
  client: "mcp-a",
  id: "agent-a",
  principal: "local-agent-a",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent",
};
const scheduler: Actor = {
  client: "scheduler-a",
  id: "scheduler-a",
  principal: "local-scheduler-a",
  capabilities: ACTOR_CAPABILITY_PROFILES.scheduler,
  type: "scheduler",
};
const system: Actor = {
  client: "runtime-system",
  id: "system-a",
  principal: "local-system",
  capabilities: ACTOR_CAPABILITY_PROFILES.system,
  type: "system",
};

describe("M6.5 interaction policy and short Guard", () => {
  it("admits explicit line input through output churn but retains screen CAS and idempotency", async () => {
    const fixture = await createRunningFixture();
    const { runtime, session, executor, executionId } = fixture;
    const base = {
      actor: agent,
      sessionId: session.id,
      sessionGeneration: session.generation,
      targetExecutionId: executionId,
    };
    try {
      const observed = await runtime.getInteractionState(session.id, session.generation);
      const oldScreen = runtime.getSession(session.id).screenVersion;
      for (let i = 0; i < 100; i++) executor.output(`log ${i}\r\n`);
      await expect(
        runtime.sendInput({
          ...base,
          data: "status\n",
          expectedScreenVersion: oldScreen,
          idempotencyKey: "old-screen",
        }),
      ).rejects.toMatchObject({ code: "SCREEN_CHANGED" });
      const request = {
        ...base,
        data: "status\n",
        lineInput: {
          expectedInputVersion: observed.inputContext?.version ?? -1,
          expectedInteractionVersion: observed.version,
        },
        idempotencyKey: "line-once",
      };
      const sent = await runtime.sendInput(request);
      expect(sent.status).toBe("DELIVERED");
      const replay = await runtime.sendInput(request);
      expect(replay.id).toBe(sent.id);
      expect(executor.inputs).toEqual(["status\n"]);
      await expect(
        runtime.sendInput({
          ...request,
          lineInput: { ...request.lineInput, expectedInputVersion: sent.actionSequence },
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      await expect(
        runtime.sendInput({ ...request, idempotencyKey: "stale-new-key" }),
      ).rejects.toMatchObject({ code: "INPUT_CONTEXT_CHANGED" });
      const current = await runtime.getInteractionState(session.id, session.generation);
      expect(current.inputContext).toEqual({
        targetExecutionId: executionId,
        version: sent.actionSequence,
        state: "clear",
      });
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });

  it("rejects pending Human input even after Guard expiry and rejects input/Guard version races", async () => {
    let now = new Date("2026-09-04T00:00:00Z");
    const { runtime, session, executor, executionId } = await createRunningFixture(() => now);
    const base = {
      sessionId: session.id,
      sessionGeneration: session.generation,
      targetExecutionId: executionId,
    };
    const observe = () => runtime.getInteractionState(session.id, session.generation);
    const line = async (key: string) => {
      const state = await observe();
      return {
        ...base,
        actor: agent,
        data: "status\n",
        idempotencyKey: key,
        lineInput: {
          expectedInputVersion: state.inputContext?.version ?? -1,
          expectedInteractionVersion: state.version,
        },
      };
    };
    try {
      const stale = await line("before-human");
      const guard = await runtime.acquireInteractionGuard({
        ...base,
        actor: human,
        expectedVersion: 1,
        reason: "typing",
        ttlMilliseconds: 50,
      });
      await expect(runtime.sendInput(stale)).rejects.toMatchObject({ code: "INPUT_GUARDED" });
      await runtime.sendInput({
        ...base,
        actor: human,
        data: "unfinished",
        idempotencyKey: "human-partial",
      });
      now = new Date(now.getTime() + 100);
      const expired = await observe();
      expect(expired.version).toBe(guard.version + 1);
      expect(expired.inputContext?.state).toBe("pending");
      await expect(runtime.sendInput(stale)).rejects.toMatchObject({
        code: "INPUT_CONTEXT_CHANGED",
      });
      await expect(runtime.sendInput(await line("fresh-but-pending"))).rejects.toMatchObject({
        code: "INPUT_CONTEXT_UNSAFE",
      });
      await runtime.sendInput({
        ...base,
        actor: human,
        data: "\r",
        idempotencyKey: "human-submit",
      });
      const beforeAnotherHuman = await line("human-between-read-write");
      await runtime.sendInput({
        ...base,
        actor: otherHuman,
        data: "another\n",
        idempotencyKey: "other-human",
      });
      await expect(runtime.sendInput(beforeAnotherHuman)).rejects.toMatchObject({
        code: "INPUT_CONTEXT_CHANGED",
      });
      const race = await line("concurrent-line");
      const results = await Promise.allSettled([
        runtime.sendInput(race),
        runtime.sendInput({ ...race, idempotencyKey: "concurrent-line-2" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(executor.inputs).toEqual(["unfinished", "\r", "another\n", "status\n"]);
      const beforePolicy = await line("before-policy");
      const policy = await runtime.setInputPolicy({
        ...base,
        actor: human,
        expectedVersion: (await observe()).version,
        mode: "human_only",
      });
      await expect(runtime.sendInput(beforePolicy)).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      await runtime.setInputPolicy({
        ...base,
        actor: human,
        expectedVersion: policy.version,
        mode: "human_guarded",
      });
      await expect(runtime.sendInput(beforePolicy)).rejects.toMatchObject({
        code: "INPUT_CONTEXT_CHANGED",
      });
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });

  it("keeps unknown delivery/control context fail-closed and scopes line input to the exact target", async () => {
    const { runtime, session, executor, executionId } = await createRunningFixture();
    const base = {
      sessionId: session.id,
      sessionGeneration: session.generation,
      targetExecutionId: executionId,
      actor: agent,
    };
    try {
      const request = {
        ...base,
        data: "status\n",
        idempotencyKey: "target",
        lineInput: { expectedInputVersion: 0, expectedInteractionVersion: 1 },
      };
      await expect(
        runtime.sendInput({ ...request, sessionGeneration: session.generation + 1 }),
      ).rejects.toMatchObject({ code: "SESSION_GENERATION_CHANGED" });
      await expect(
        runtime.sendInput({ ...request, targetExecutionId: "wrong" }),
      ).rejects.toMatchObject({ code: "EXECUTION_CHANGED" });
      executor.failInput = true;
      await expect(runtime.sendInput(request)).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
      const unknown = await runtime.getInteractionState(session.id, session.generation);
      expect(unknown.inputContext?.state).toBe("unknown");
      executor.failInput = false;
      await runtime.sendInput({
        ...base,
        actor: human,
        data: "\r",
        idempotencyKey: "cannot-clear-unknown",
      });
      const current = await runtime.getInteractionState(session.id, session.generation);
      await expect(
        runtime.sendInput({
          ...request,
          idempotencyKey: "after-unknown",
          lineInput: {
            expectedInputVersion: current.inputContext?.version ?? -1,
            expectedInteractionVersion: current.version,
          },
        }),
      ).rejects.toMatchObject({ code: "INPUT_CONTEXT_UNSAFE" });
      expect((await runtime.sendInput(request)).status).toBe("UNKNOWN");
      expect(executor.inputs).toEqual(["status\n", "\r"]);
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });

  it("denies a missing capability before allocating an Action or touching the PTY", async () => {
    const fixture = await createRunningFixture();
    const inputlessAgent: Actor = {
      ...agent,
      capabilities: ["session.execute"],
      id: "agent-without-input",
    };
    const policylessHuman: Actor = {
      ...human,
      capabilities: ["interaction.guard.manage"],
      id: "human-without-policy",
    };
    const initialSession = fixture.runtime.getSession(fixture.session.id);
    try {
      await expect(
        fixture.runtime.sendInput({
          actor: inputlessAgent,
          data: "must-not-reach-pty\n",
          idempotencyKey: "missing-input-capability",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "terminal.input" },
      });
      await expect(
        fixture.runtime.setInputPolicy({
          actor: policylessHuman,
          expectedVersion: 1,
          mode: "common",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });

      expect(fixture.executor.inputs).toEqual([]);
      expect(fixture.runtime.getSession(fixture.session.id).actionSequence).toBe(
        initialSession.actionSequence,
      );
      expect(
        await fixture.runtime.getInteractionState(fixture.session.id, fixture.session.generation),
      ).toMatchObject({ policy: "human_guarded", version: 1 });
      const events = await fixture.runtime.queryEvents(
        fixture.session.id,
        fixture.session.generation,
        0,
        500,
      );
      expect(
        events.events.filter((event) => event.type === "interaction.policy_denied"),
      ).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain("must-not-reach-pty");
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("rejects process-local Actor identity drift", async () => {
    const fixture = await createRunningFixture();
    try {
      await expect(
        fixture.runtime.sendInput({
          actor: { ...agent, client: "forged-client" },
          data: "must-not-reach-pty\n",
          idempotencyKey: "actor-identity-drift",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
      expect(fixture.executor.inputs).toEqual([]);
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

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
        inputContext: { targetExecutionId: fixture.executionId, version: 0, state: "clear" },
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
    this.executor = new InteractiveExecutor(options.shell, options.onOutput);
    return Promise.resolve(this.executor);
  }
}

class InteractiveExecutor implements ShellExecutor {
  public readonly shellPid = 4242;
  public readonly inputs: string[] = [];
  public readonly controls: ControlDelivery[] = [];

  public failInput = false;
  public constructor(
    public readonly shell: ShellKind,
    public readonly output: (data: string) => void,
  ) {}

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: "/tmp", filteredEnvironment: {} };
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    callbacks.onStarted(command);
    return new Promise(() => undefined);
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
    if (this.failInput) throw new Error("uncertain write");
  }

  public writeSecret(data: string): void {
    this.inputs.push(data);
  }

  public finishSensitiveOutput(): void {}

  public sendControl(delivery: ControlDelivery): void {
    this.controls.push(delivery);
  }

  public resize(): void {}

  public close(): void {}
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
