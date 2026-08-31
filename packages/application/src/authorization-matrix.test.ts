import {
  ACTOR_CAPABILITIES,
  ACTOR_CAPABILITY_PROFILES,
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  type Actor,
  type ControlDelivery,
  type ShellKind,
  type TerminalScreenSnapshot,
} from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

import type {
  CreateExecutorOptions,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
  TerminalScreenProjection,
} from "./ports.js";
import { RuntimeService } from "./runtime-service.js";

const human = actor("human", "human-matrix", ACTOR_CAPABILITY_PROFILES.human);
const agent = actor("agent", "agent-matrix", ACTOR_CAPABILITY_PROFILES.agent);
const scheduler = actor("scheduler", "scheduler-matrix", ACTOR_CAPABILITY_PROFILES.scheduler);
const system = actor("system", "system-matrix", ACTOR_CAPABILITY_PROFILES.system);

describe("M10.10 layered authorization matrix", () => {
  it("freezes the canonical construction profiles", () => {
    expect(ACTOR_CAPABILITY_PROFILES).toEqual({
      agent: [
        "approval.request",
        "session.execute",
        "session.fork",
        "terminal.control",
        "terminal.input",
        "terminal.resize",
      ],
      human: [...ACTOR_CAPABILITIES],
      scheduler: ["session.execute"],
      system: [
        "interaction.policy.manage",
        "session.execute",
        "session.fork",
        "terminal.control",
        "terminal.resize",
      ],
    });
  });

  it("denies every missing operation capability before Action or PTY side effects", async () => {
    const fixture = await createRunningFixture();
    const baselineSession = fixture.runtime.getSession(fixture.session.id);
    const approval = await fixture.runtime.requestExecuteApproval({
      actionIdempotencyKey: "matrix-approved-action",
      actor: agent,
      command: "approved-later",
      reason: "Exercise Approval authorization",
      requestIdempotencyKey: "matrix-approval-request",
      sessionGeneration: fixture.session.generation,
      sessionId: fixture.session.id,
    });
    const guarded = await fixture.runtime.acquireInteractionGuard({
      actor: human,
      expectedVersion: 1,
      reason: "Exercise Guard authorization",
      sessionGeneration: fixture.session.generation,
      sessionId: fixture.session.id,
    });
    const missingExecute = actor("agent", "missing-execute", ["terminal.input"]);
    const limitedHuman = actor("human", "limited-human", ["session.execute"]);
    const limitedAgent = actor("agent", "limited-agent", ["session.execute"]);
    const stateBeforeDenials = await fixture.runtime.getInteractionState(
      fixture.session.id,
      fixture.session.generation,
    );

    try {
      await expect(
        fixture.runtime.startExecute({
          actor: missingExecute,
          command: "must-not-execute",
          idempotencyKey: "missing-execute",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "session.execute" },
      });
      await expect(
        fixture.runtime.forkSession({
          actor: limitedAgent,
          allowStale: true,
          expectedCheckpointVersion: 1,
          idempotencyKey: "missing-fork",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "session.fork" },
      });
      await expect(
        fixture.runtime.sendInput({
          actor: limitedAgent,
          data: "INPUT_SENTINEL_MUST_NOT_REACH_PTY\n",
          idempotencyKey: "missing-input",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "terminal.input" },
      });
      await expect(
        fixture.runtime.sendControl({
          actor: limitedHuman,
          delivery: { control: "ESC", mode: "TTY_CONTROL" },
          idempotencyKey: "missing-control",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "terminal.control" },
      });
      await expect(
        fixture.runtime.resizeTerminal({
          actor: limitedHuman,
          columns: 121,
          expectedGeometryVersion: 1,
          idempotencyKey: "missing-resize",
          rows: 40,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "terminal.resize" },
      });
      await expect(
        fixture.runtime.setInputPolicy({
          actor: limitedHuman,
          expectedVersion: guarded.version,
          mode: "common",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.acquireInteractionGuard({
          actor: limitedHuman,
          expectedVersion: guarded.version,
          reason: "Must not replace the current Guard",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.renewInteractionGuard({
          actor: limitedHuman,
          expectedVersion: guarded.version,
          guardId: guarded.guard!.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "interaction.guard.manage" },
      });
      await expect(
        fixture.runtime.releaseInteractionGuard({
          actor: limitedHuman,
          expectedVersion: guarded.version,
          guardId: guarded.guard!.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "interaction.guard.manage" },
      });
      await expect(
        fixture.runtime.requestExecuteApproval({
          actionIdempotencyKey: "missing-approval-action",
          actor: limitedAgent,
          command: "must-not-request-approval",
          reason: "Missing capability",
          requestIdempotencyKey: "missing-approval-request",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "approval.request" },
      });
      await expect(
        fixture.runtime.getApproval({
          actor: limitedHuman,
          approvalId: approval.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "approval.decide" },
      });
      await expect(
        fixture.runtime.listApprovals({
          actor: limitedHuman,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "approval.decide" },
      });
      await expect(
        fixture.runtime.decideApproval({
          actor: limitedHuman,
          approvalId: approval.id,
          decision: "approve",
          expectedVersion: approval.version,
          idempotencyKey: "missing-approval-decision",
          reason: "Missing capability",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "approval.decide" },
      });
      await expect(
        fixture.runtime.beginSecretInput({
          actor: limitedHuman,
          data: "SECRET_SENTINEL_MUST_NOT_REACH_PTY\r",
          idempotencyKey: "missing-secret",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "secret.input" },
      });
      expect(() =>
        fixture.runtime.getSensitiveInput({
          actor: limitedHuman,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
      await expect(
        fixture.runtime.finishSensitiveInput({
          actor: limitedHuman,
          expectedVersion: 1,
          idempotencyKey: "missing-secret-finish",
          outcome: "cancelled",
          sensitiveInputId: "sec_missing",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({
        code: "POLICY_DENIED",
        details: { capability: "secret.input" },
      });

      expect(fixture.runtime.getSession(fixture.session.id).actionSequence).toBe(
        baselineSession.actionSequence,
      );
      expect(
        await fixture.runtime.getInteractionState(fixture.session.id, fixture.session.generation),
      ).toEqual(stateBeforeDenials);
      expect(fixture.factory.executors).toHaveLength(1);
      expect(fixture.executor.commands).toEqual(["keep-running"]);
      expect(fixture.executor.inputs).toEqual([]);
      expect(fixture.executor.secrets).toEqual([]);
      expect(fixture.executor.controls).toEqual([]);
      expect(fixture.executor.resizes).toEqual([]);
      const events = await fixture.runtime.queryEvents(
        fixture.session.id,
        fixture.session.generation,
        0,
        500,
      );
      expect(JSON.stringify(events)).not.toContain("INPUT_SENTINEL_MUST_NOT_REACH_PTY");
      expect(JSON.stringify(events)).not.toContain("SECRET_SENTINEL_MUST_NOT_REACH_PTY");
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("keeps Actor-type restrictions when an Actor presents every capability", async () => {
    const fixture = await createRunningFixture();
    const elevatedAgent = actor("agent", "elevated-agent", ACTOR_CAPABILITIES);
    const elevatedScheduler = actor("scheduler", "elevated-scheduler", ACTOR_CAPABILITIES);
    const elevatedSystem = actor("system", "elevated-system", ACTOR_CAPABILITIES);
    const elevatedHuman = actor("human", "elevated-human", ACTOR_CAPABILITIES);
    const otherElevatedAgent = actor("agent", "other-elevated-agent", ACTOR_CAPABILITIES);

    try {
      await expect(
        fixture.runtime.setInputPolicy({
          actor: elevatedAgent,
          expectedVersion: 1,
          mode: "common",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.acquireInteractionGuard({
          actor: elevatedAgent,
          expectedVersion: 1,
          reason: "Agent cannot become Human",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.sendInput({
          actor: elevatedScheduler,
          data: "scheduler-must-not-interact\n",
          idempotencyKey: "elevated-scheduler-input",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.sendControl({
          actor: elevatedSystem,
          delivery: { control: "ESC", mode: "TTY_CONTROL" },
          idempotencyKey: "elevated-system-control",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.resizeTerminal({
          actor: elevatedSystem,
          columns: 121,
          expectedGeometryVersion: 1,
          idempotencyKey: "elevated-system-resize",
          rows: 40,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.sendControl({
          actor: elevatedAgent,
          bypassGuard: true,
          delivery: { control: "ESC", mode: "TTY_CONTROL" },
          idempotencyKey: "agent-guard-bypass",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.beginSecretInput({
          actor: elevatedAgent,
          data: "AGENT_SECRET_MUST_NOT_REACH_PTY\r",
          idempotencyKey: "elevated-agent-secret",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
          targetExecutionId: fixture.executionId,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(() =>
        fixture.runtime.getSensitiveInput({
          actor: elevatedAgent,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

      await expect(
        fixture.runtime.requestExecuteApproval({
          actionIdempotencyKey: "human-cannot-request-action",
          actor: elevatedHuman,
          command: "true",
          reason: "Human is not an Agent requester",
          requestIdempotencyKey: "human-cannot-request",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const approval = await fixture.runtime.requestExecuteApproval({
        actionIdempotencyKey: "elevated-agent-action",
        actor: elevatedAgent,
        command: "true",
        reason: "Verify Approval role boundaries",
        requestIdempotencyKey: "elevated-agent-request",
        sessionGeneration: fixture.session.generation,
        sessionId: fixture.session.id,
      });
      await expect(
        fixture.runtime.decideApproval({
          actor: elevatedAgent,
          approvalId: approval.id,
          decision: "approve",
          expectedVersion: approval.version,
          idempotencyKey: "agent-cannot-decide",
          reason: "Agent cannot become Human",
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.getApproval({
          actor: otherElevatedAgent,
          approvalId: approval.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.listApprovals({
          actor: elevatedSystem,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        fixture.runtime.getApproval({
          actor: elevatedAgent,
          approvalId: approval.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).resolves.toMatchObject({ id: approval.id });
      await expect(
        fixture.runtime.getApproval({
          actor: elevatedHuman,
          approvalId: approval.id,
          sessionGeneration: fixture.session.generation,
          sessionId: fixture.session.id,
        }),
      ).resolves.toMatchObject({ id: approval.id });

      expect(fixture.executor.inputs).toEqual([]);
      expect(fixture.executor.secrets).toEqual([]);
      expect(fixture.executor.controls).toEqual([]);
      expect(fixture.executor.resizes).toEqual([]);
    } finally {
      await fixture.runtime.closeSession(fixture.session.id, fixture.session.generation);
    }
  });

  it("requires Approval only for Agent Execute under the required policy", async () => {
    const factory = new MatrixExecutorFactory("immediate");
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
      agentExecuteApproval: "required",
      screenProjectionFactory: matrixScreenFactory,
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });

    try {
      for (const candidate of [human, scheduler, system]) {
        const started = await runtime.startExecute({
          actor: candidate,
          command: `execute-as-${candidate.type}`,
          idempotencyKey: `execute-as-${candidate.type}`,
          sessionGeneration: session.generation,
          sessionId: session.id,
        });
        await expect(started.completion).resolves.toMatchObject({ status: "COMPLETED" });
      }

      await expect(
        runtime.startExecute({
          actor: agent,
          command: "execute-as-agent",
          idempotencyKey: "execute-as-agent",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      const pending = await runtime.requestExecuteApproval({
        actionIdempotencyKey: "execute-as-agent",
        actor: agent,
        command: "execute-as-agent",
        reason: "Required policy matrix",
        requestIdempotencyKey: "request-execute-as-agent",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const approved = await runtime.decideApproval({
        actor: human,
        approvalId: pending.id,
        decision: "approve",
        expectedVersion: pending.version,
        idempotencyKey: "approve-execute-as-agent",
        reason: "Reviewed exact Agent Execute",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const agentStarted = await runtime.startExecute({
        actor: agent,
        approvalId: approved.id,
        command: "execute-as-agent",
        idempotencyKey: "execute-as-agent",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await expect(agentStarted.completion).resolves.toMatchObject({ status: "COMPLETED" });

      const actionSequence = runtime.getSession(session.id).actionSequence;
      await expect(
        runtime.startExecute({
          actor: human,
          approvalId: approved.id,
          command: "human-must-not-consume-agent-approval",
          idempotencyKey: "human-with-agent-approval",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(runtime.getSession(session.id).actionSequence).toBe(actionSequence);
      expect(factory.executors[0]?.commands).toEqual([
        "execute-as-human",
        "execute-as-scheduler",
        "execute-as-system",
        "execute-as-agent",
      ]);
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });
});

async function createRunningFixture(): Promise<{
  readonly executionId: string;
  readonly executor: MatrixExecutor;
  readonly factory: MatrixExecutorFactory;
  readonly runtime: RuntimeService;
  readonly session: Awaited<ReturnType<RuntimeService["createSession"]>>;
}> {
  const factory = new MatrixExecutorFactory("pending");
  const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
    screenProjectionFactory: matrixScreenFactory,
  });
  const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
  const started = await runtime.startExecute({
    actor: agent,
    command: "keep-running",
    idempotencyKey: "keep-running",
    sessionGeneration: session.generation,
    sessionId: session.id,
  });
  await started.started;
  const executor = factory.executors[0];
  if (executor === undefined) throw new Error("Expected MatrixExecutor");
  return { executionId: started.execution.id, executor, factory, runtime, session };
}

function actor(type: Actor["type"], id: string, capabilities: Actor["capabilities"]): Actor {
  return {
    capabilities,
    client: `matrix-${type}-client`,
    id,
    principal: `matrix-${type}-principal`,
    type,
  };
}

class MatrixExecutorFactory implements ShellExecutorFactory {
  public readonly executors: MatrixExecutor[] = [];

  public constructor(private readonly completion: "immediate" | "pending") {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    const executor = new MatrixExecutor(options.shell, this.completion);
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

class MatrixExecutor implements ShellExecutor {
  public readonly shellPid = 5656;
  public readonly commands: string[] = [];
  public readonly inputs: string[] = [];
  public readonly secrets: string[] = [];
  public readonly controls: ControlDelivery[] = [];
  public readonly resizes: Readonly<{ columns: number; rows: number }>[] = [];

  public constructor(
    public readonly shell: ShellKind,
    private readonly completion: "immediate" | "pending",
  ) {}

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: "/tmp", filteredEnvironment: {} };
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    this.commands.push(command);
    callbacks.onStarted(command);
    if (this.completion === "pending") return new Promise(() => undefined);
    return Promise.resolve({
      cwd: "/tmp",
      exitCode: 0,
      filteredEnvironment: {},
      output: "",
      outputTruncated: false,
    });
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public writeSecret(data: string): void {
    this.secrets.push(data);
  }

  public finishSensitiveOutput(): void {}

  public sendControl(delivery: ControlDelivery): void {
    this.controls.push(delivery);
  }

  public resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  public close(): void {}
}

const matrixScreenFactory = {
  create(identity: {
    readonly sessionGeneration: number;
    readonly sessionId: string;
  }): TerminalScreenProjection {
    let columns = CANONICAL_TERMINAL_COLUMNS;
    let rows = CANONICAL_TERMINAL_ROWS;
    let geometryVersion = 1;
    let screenVersion = 0;
    const snapshot = (): TerminalScreenSnapshot => ({
      buffer: "normal",
      columns,
      cursor: { column: 0, row: 0 },
      geometryVersion,
      lines: Array.from({ length: rows }, () => ""),
      rows,
      screenVersion,
      sessionGeneration: identity.sessionGeneration,
      sessionId: identity.sessionId,
    });
    const unused = (): Promise<never> => Promise.reject(new Error("Unused matrix screen read"));
    return {
      cells: unused,
      diff: unused,
      dispose: () => undefined,
      region: unused,
      resize: (nextColumns, nextRows, nextScreenVersion) => {
        columns = nextColumns;
        rows = nextRows;
        geometryVersion += 1;
        screenVersion = nextScreenVersion;
        return Promise.resolve(snapshot());
      },
      search: unused,
      snapshot: () => Promise.resolve(snapshot()),
      waitForVersion: () => Promise.resolve(undefined),
      write: (_data, nextScreenVersion) => {
        screenVersion = nextScreenVersion;
      },
    };
  },
};
