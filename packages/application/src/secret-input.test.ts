import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { createTestRuntime, humanActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it } from "vitest";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { force: true, recursive: true });
});

describe("M10.4 Human-only secret input", () => {
  it("keeps the secret out of Actions, Events, and Execution output and remains fail-closed", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const secret = "ITERM_SECRET_SENTINEL_93d9";
    try {
      const started = await runtime.startExecute({
        actor: humanActor,
        command: `IFS= read -r ITERM_SECRET; printf 'ECHO:%s\\n' "$ITERM_SECRET"`,
        idempotencyKey: "secret-reader",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await started.started;
      const action = await runtime.beginSecretInput({
        actor: humanActor,
        data: `${secret}\r`,
        idempotencyKey: "secret-submit-once",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
      expect(action).not.toHaveProperty("data");
      expect(JSON.stringify(action)).not.toContain(secret);
      const replay = await runtime.beginSecretInput({
        actor: humanActor,
        data: "DIFFERENT_TRANSIENT_VALUE\r",
        idempotencyKey: "secret-submit-once",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
      expect(replay.id).toBe(action.id);
      const completed = await started.completion;
      expect(completed.output).toContain("sensitive terminal output redacted");
      expect(completed.output).not.toContain(secret);
      expect(completed.output).not.toContain("DIFFERENT_TRANSIENT_VALUE");

      const active = runtime.getSensitiveInput({
        actor: humanActor,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(active).toMatchObject({ status: "ACTIVE", version: 1 });
      await expect(
        runtime.startExecute({
          actor: humanActor,
          command: "printf blocked",
          idempotencyKey: "blocked-during-sensitive-period",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "SENSITIVE_INPUT_ACTIVE" });

      const finished = await runtime.finishSensitiveInput({
        actor: humanActor,
        expectedVersion: 1,
        idempotencyKey: "finish-sensitive-period",
        outcome: "completed",
        sensitiveInputId: action.sensitiveInputId,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(finished).toMatchObject({ status: "COMPLETED", version: 2 });
      const visible = await runtime.startExecute({
        actor: humanActor,
        command: "printf 'VISIBLE_AFTER_REDACTION\\n'",
        idempotencyKey: "visible-after-sensitive-period",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect((await visible.completion).output).toContain("VISIBLE_AFTER_REDACTION");

      const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
      const serialized = JSON.stringify(events.events);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("DIFFERENT_TRANSIENT_VALUE");
      expect(events.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "sensitive_input.started",
          "interaction.write_attempted",
          "sensitive_input.delivered",
          "sensitive_input.completed",
        ]),
      );
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);

  it("does not release PTY barrier-prefix bytes retained across the redaction boundary", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const barrierEmittedPath = join(workspace, "partial-barrier-emitted");
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    try {
      const started = await runtime.startExecute({
        actor: humanActor,
        command:
          "IFS= read -r ignored; (sleep 0.05; printf '\\033]1337;iTerminalBar'; : > partial-barrier-emitted) &!; printf done",
        idempotencyKey: "partial-barrier-reader",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await started.started;
      const action = await runtime.beginSecretInput({
        actor: humanActor,
        data: "TRANSIENT_BOUNDARY_VALUE\r",
        idempotencyKey: "partial-barrier-secret",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
      await started.completion;
      await waitForPath(barrierEmittedPath);
      await runtime.finishSensitiveInput({
        actor: humanActor,
        expectedVersion: 1,
        idempotencyKey: "partial-barrier-finish",
        outcome: "completed",
        sensitiveInputId: action.sensitiveInputId,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const visible = await runtime.startExecute({
        actor: humanActor,
        command: "printf 'VISIBLE_BOUNDARY_CHECK\\n'",
        idempotencyKey: "partial-barrier-visible",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const output = (await visible.completion).output;
      expect(output).toContain("VISIBLE_BOUNDARY_CHECK");
      expect(output).not.toContain("iTerminalBar");
      expect(output).not.toContain("TRANSIENT_BOUNDARY_VALUE");
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);

  it("denies an Agent even when it presents the reserved secret capability", async () => {
    const runtime = createTestRuntime();
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const impersonatingAgent: Actor = {
      capabilities: ACTOR_CAPABILITY_PROFILES.human,
      client: "malicious-test-client",
      id: "agent-with-secret-capability",
      principal: "local-agent",
      type: "agent",
    };
    try {
      const started = await runtime.startExecute({
        actor: humanActor,
        command: "read -r ignored; sleep 30",
        idempotencyKey: "agent-secret-denial-reader",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await started.started;
      await expect(
        runtime.beginSecretInput({
          actor: impersonatingAgent,
          data: "MUST_NOT_BE_WRITTEN\r",
          idempotencyKey: "agent-secret-denied",
          sessionGeneration: session.generation,
          sessionId: session.id,
          targetExecutionId: started.execution.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const humanSecret = await runtime.beginSecretInput({
        actor: humanActor,
        data: "HUMAN_ONLY_SECRET\r",
        idempotencyKey: "human-secret-after-agent-denial",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
      await expect(
        runtime.sendInput({
          actor: impersonatingAgent,
          data: "AGENT_INTERFERENCE_MUST_NOT_WRITE\r",
          idempotencyKey: "agent-input-during-sensitive-period",
          sessionGeneration: session.generation,
          sessionId: session.id,
          targetExecutionId: started.execution.id,
        }),
      ).rejects.toMatchObject({ code: "SENSITIVE_INPUT_ACTIVE" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.sendControl({
        actor: humanActor,
        bypassGuard: true,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
        idempotencyKey: "stop-agent-secret-denial-reader",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
      await started.completion;
      await runtime.finishSensitiveInput({
        actor: humanActor,
        expectedVersion: 1,
        idempotencyKey: "finish-human-secret-after-agent-denial",
        outcome: "cancelled",
        sensitiveInputId: humanSecret.sensitiveInputId,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
      expect(JSON.stringify(events.events)).not.toContain("MUST_NOT_BE_WRITTEN");
      expect(JSON.stringify(events.events)).not.toContain("AGENT_INTERFERENCE_MUST_NOT_WRITE");
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "iterminal-secret-input-"));
  mkdirSync(join(workspace, "subdirectory"));
  workspaces.push(workspace);
  return workspace;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The marker is written after the PTY bytes. Yield once more so node-pty can deliver them.
  await new Promise((resolve) => setTimeout(resolve, 10));
}
