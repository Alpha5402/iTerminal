import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShellKind } from "@iterminal/domain";
import { agentActor, createTestRuntime, humanActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

describe("M7.1 checkpoint environment policy", () => {
  it.each(["AWS_SECRET_ACCESS_KEY", "LD_PRELOAD", "ITERMINAL_CONTROL_FIFO"])(
    "rejects credential-like or Runtime-unsafe allowlist key %s",
    (environmentKey) => {
      expect(() => createTestRuntime({ checkpointEnvironmentKeys: [environmentKey] })).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );
});

describe.each(["bash", "zsh"] as const)("M7.1 %s checkpoint fork", (shell: ShellKind) => {
  it("rebuilds cwd and allowlisted env while parent state remains independent", async () => {
    const runtime = createTestRuntime({ checkpointEnvironmentKeys: ["ITERM_M7_SAFE"] });
    const workspace = await createWorkspace();
    const parent = await runtime.createSession({ shell, workspaceRoot: workspace });
    const children: string[] = [];
    try {
      expect(runtime.getSessionCheckpoint(parent.id, parent.generation)).toMatchObject({
        environmentKeys: [],
        stale: false,
        version: 1,
      });
      await runtime.execute({
        actor: humanActor,
        command:
          "cd packages/web && export ITERM_M7_SAFE=shared UNLISTED_SECRET=do-not-copy && alias parent_only='printf hidden'",
        idempotencyKey: `${shell}-checkpoint-state`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      const checkpoint = runtime.getSessionCheckpoint(parent.id, parent.generation);
      expect(checkpoint).toMatchObject({
        cwd: join(await realpath(workspace), "packages", "web"),
        environmentKeys: ["ITERM_M7_SAFE"],
        stale: false,
        version: 2,
      });
      expect(JSON.stringify(checkpoint)).not.toContain("shared");
      expect(JSON.stringify(checkpoint)).not.toContain("do-not-copy");

      const request = {
        actor: agentActor,
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version,
        idempotencyKey: `${shell}-ready-fork`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      } as const;
      const fork = await runtime.forkSession(request);
      children.push(fork.session.id);
      expect(fork).toMatchObject({
        checkpoint: { stale: false, version: 3 },
        replayed: false,
        session: {
          generation: 1,
          lineage: {
            checkpointVersion: 3,
            parentGeneration: parent.generation,
            parentSessionId: parent.id,
          },
          status: "READY",
        },
      });
      expect(fork.limitations).toEqual(
        expect.arrayContaining([
          "process_state_not_copied",
          "repl_editor_state_not_copied",
          "shell_implicit_state_not_copied",
          "workspace_filesystem_shared",
          "filtered_environment_only",
        ]),
      );
      const childState = await runtime.execute({
        actor: agentActor,
        command:
          'printf \'PWD=%s SAFE=%s SECRET=%s\\n\' "$PWD" "$ITERM_M7_SAFE" "${UNLISTED_SECRET-unset}"; alias parent_only >/dev/null 2>&1; printf \'ALIAS=%s\\n\' "$?"',
        idempotencyKey: `${shell}-child-state`,
        sessionGeneration: fork.session.generation,
        sessionId: fork.session.id,
      });
      expect(childState.output).toContain(
        `PWD=${join(await realpath(workspace), "packages", "web")}`,
      );
      expect(childState.output).toContain("SAFE=shared SECRET=unset");
      expect(childState.output).toContain("ALIAS=1");

      const replay = await runtime.forkSession(request);
      expect(replay.replayed).toBe(true);
      expect(replay.session.id).toBe(fork.session.id);
      await expect(runtime.forkSession({ ...request, allowStale: true })).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
      });

      const active = await runtime.startExecute({
        actor: humanActor,
        command: "sleep 30",
        idempotencyKey: `${shell}-parent-busy`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      await active.started;
      const staleCheckpoint = runtime.getSessionCheckpoint(parent.id, parent.generation);
      expect(staleCheckpoint).toMatchObject({ stale: true, version: 3 });
      const staleRequest = {
        actor: agentActor,
        allowStale: false,
        expectedCheckpointVersion: staleCheckpoint.version,
        idempotencyKey: `${shell}-busy-fork`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      } as const;
      await expect(runtime.forkSession(staleRequest)).rejects.toMatchObject({
        code: "CHECKPOINT_STALE",
      });
      const staleFork = await runtime.forkSession({ ...staleRequest, allowStale: true });
      children.push(staleFork.session.id);
      expect(staleFork.checkpoint).toMatchObject({ stale: true, version: 3 });
      expect(runtime.getSession(parent.id).status).toBe("RUNNING");
      const independent = await runtime.execute({
        actor: agentActor,
        command: "printf 'CHILD_READY=%s\\n' \"$ITERM_M7_SAFE\"",
        idempotencyKey: `${shell}-busy-child`,
        sessionGeneration: staleFork.session.generation,
        sessionId: staleFork.session.id,
      });
      expect(independent.output).toContain("CHILD_READY=shared");
      await runtime.sendControl({
        actor: humanActor,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
        idempotencyKey: `${shell}-parent-stop`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
        targetExecutionId: active.execution.id,
      });
      await active.completion;
    } finally {
      for (const childId of children) {
        const child = runtime.getSession(childId);
        await runtime.closeSession(child.id, child.generation).catch(() => undefined);
      }
      await runtime.closeSession(parent.id, parent.generation).catch(() => undefined);
    }
  }, 45_000);

  it("rejects a checkpoint whose cwd disappears instead of falling back", async () => {
    const runtime = createTestRuntime();
    const workspace = await createWorkspace();
    const removed = join(workspace, "packages", "web");
    const parent = await runtime.createSession({ shell, workspaceRoot: workspace });
    try {
      await runtime.execute({
        actor: humanActor,
        command: "cd packages/web",
        idempotencyKey: `${shell}-removed-cwd`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      const checkpoint = runtime.getSessionCheckpoint(parent.id, parent.generation);
      await rm(removed, { recursive: true });
      await expect(
        runtime.forkSession({
          actor: agentActor,
          allowStale: false,
          expectedCheckpointVersion: checkpoint.version,
          idempotencyKey: `${shell}-invalid-fork`,
          sessionGeneration: parent.generation,
          sessionId: parent.id,
        }),
      ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
      expect(runtime.listSessions()).toHaveLength(1);
      expect(runtime.getSession(parent.id).status).toBe("READY");
    } finally {
      await runtime.closeSession(parent.id, parent.generation).catch(() => undefined);
    }
  }, 30_000);

  it("omits allowlisted environment values outside the bounded policy", async () => {
    const runtime = createTestRuntime({ checkpointEnvironmentKeys: ["ITERM_M7_SAFE"] });
    const workspace = await createWorkspace();
    const parent = await runtime.createSession({ shell, workspaceRoot: workspace });
    let childId: string | undefined;
    try {
      await runtime.execute({
        actor: humanActor,
        command: "export ITERM_M7_SAFE=$'line\\nvalue'",
        idempotencyKey: `${shell}-multiline-env`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      expect(runtime.getSessionCheckpoint(parent.id, parent.generation).environmentKeys).toEqual(
        [],
      );
      await runtime.execute({
        actor: humanActor,
        command: `export ITERM_M7_SAFE="$(printf 'x%.0s' {1..4097})"`,
        idempotencyKey: `${shell}-oversized-env`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      const checkpoint = runtime.getSessionCheckpoint(parent.id, parent.generation);
      expect(checkpoint.environmentKeys).toEqual([]);
      const fork = await runtime.forkSession({
        actor: agentActor,
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version,
        idempotencyKey: `${shell}-multiline-env-fork`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      childId = fork.session.id;
      const observed = await runtime.execute({
        actor: agentActor,
        command: 'printf "SAFE=%s\\n" "${ITERM_M7_SAFE-unset}"',
        idempotencyKey: `${shell}-multiline-env-child`,
        sessionGeneration: fork.session.generation,
        sessionId: fork.session.id,
      });
      expect(observed.output).toContain("SAFE=unset");
    } finally {
      if (childId !== undefined) {
        const child = runtime.getSession(childId);
        await runtime.closeSession(child.id, child.generation).catch(() => undefined);
      }
      await runtime.closeSession(parent.id, parent.generation).catch(() => undefined);
    }
  }, 30_000);

  it("rebuilds from the last completed checkpoint after the live parent becomes BROKEN", async () => {
    const runtime = createTestRuntime({ checkpointEnvironmentKeys: ["ITERM_M7_SAFE"] });
    const workspace = await createWorkspace();
    const parent = await runtime.createSession({ shell, workspaceRoot: workspace });
    let childId: string | undefined;
    try {
      await runtime.execute({
        actor: humanActor,
        command: "cd packages/web && export ITERM_M7_SAFE=before-owner-loss",
        idempotencyKey: `${shell}-broken-state`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      const checkpoint = runtime.getSessionCheckpoint(parent.id, parent.generation);
      runtime.shutdownLiveOwner("injected owner loss");
      expect(runtime.getSession(parent.id).status).toBe("BROKEN");
      expect(runtime.getSessionCheckpoint(parent.id, parent.generation).stale).toBe(true);
      const fork = await runtime.forkSession({
        actor: agentActor,
        allowStale: true,
        expectedCheckpointVersion: checkpoint.version,
        idempotencyKey: `${shell}-broken-fork`,
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      });
      childId = fork.session.id;
      expect(fork.checkpoint).toMatchObject({ stale: true, version: checkpoint.version });
      const observed = await runtime.execute({
        actor: agentActor,
        command: 'printf \'PWD=%s SAFE=%s\\n\' "$PWD" "$ITERM_M7_SAFE"',
        idempotencyKey: `${shell}-broken-child-state`,
        sessionGeneration: fork.session.generation,
        sessionId: fork.session.id,
      });
      expect(observed.output).toContain(
        `PWD=${join(await realpath(workspace), "packages", "web")}`,
      );
      expect(observed.output).toContain("SAFE=before-owner-loss");
    } finally {
      if (childId !== undefined) {
        const child = runtime.getSession(childId);
        await runtime.closeSession(child.id, child.generation).catch(() => undefined);
      }
      await runtime.closeSession(parent.id, parent.generation).catch(() => undefined);
    }
  }, 30_000);
});

async function createWorkspace(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "iterminal-m7-fork-"));
  fixtureRoots.push(fixture);
  const workspace = join(fixture, "workspace");
  await mkdir(join(workspace, "packages", "web"), { recursive: true });
  return workspace;
}
