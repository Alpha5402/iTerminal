import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShellKind } from "@iterminal/domain";
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

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "iterminal-m1-test-"));
  mkdirSync(join(workspace, "packages", "web"), { recursive: true });
  workspaces.push(workspace);
  return workspace;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
