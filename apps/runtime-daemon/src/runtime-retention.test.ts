import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const fixtures: string[] = [];
const daemons: RuntimeDaemonHandle[] = [];

const actor: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "b07-runtime-retention-test",
  id: "agent-b07-runtime-retention",
  principal: "local-b07-runtime-retention",
  type: "agent",
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture, { force: true, recursive: true });
  }
});

describe("B07 real daemon bounded memory", () => {
  it("keeps its own PTY controllable after ordinary Action capacity is exhausted", async () => {
    let fixtureRoot = await mkdtemp("/tmp/iterminal-b07-retention-");
    fixtureRoot = await realpath(fixtureRoot);
    fixtures.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, "workspace");
    await mkdir(workspaceRoot);
    const daemon = await startRuntimeDaemon({
      retention: {
        eventBytesPerGeneration: 64 * 1024,
        eventEntriesPerGeneration: 6,
        memoryOnlyActionBytes: 1024 * 1024,
        memoryOnlyActionEntries: 5,
        memoryOnlyControlReserveBytes: 64 * 1024,
        memoryOnlyControlReserveEntries: 1,
      },
      socketPath: join(fixtureRoot, "runtime.sock"),
    });
    daemons.push(daemon);
    const session = await daemon.runtime.createSession({ shell: "zsh", workspaceRoot });
    process.stdout.write("B07_L2 session-ready\n");

    const completed = await daemon.runtime.startExecute({
      actor,
      command: "printf 'b07-complete\\n'",
      idempotencyKey: "b07-real-completed",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await completed.started;
    await expect(completed.completion).resolves.toMatchObject({ status: "COMPLETED" });
    process.stdout.write("B07_L2 first-completed\n");

    const active = await daemon.runtime.startExecute({
      actor,
      command: "sleep 30",
      idempotencyKey: "b07-real-active",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await active.started;
    process.stdout.write("B07_L2 active-started\n");
    for (let index = 0; index < 2; index += 1) {
      await daemon.runtime.sendInput({
        actor,
        data: "x",
        idempotencyKey: `b07-real-input-${index.toString()}`,
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: active.execution.id,
      });
    }
    await expect(
      daemon.runtime.sendInput({
        actor,
        data: "blocked",
        idempotencyKey: "b07-real-input-blocked",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: active.execution.id,
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE", retryable: false });
    process.stdout.write("B07_L2 ordinary-rejected\n");
    await expect(
      daemon.runtime.sendControl({
        actor,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
        idempotencyKey: "b07-real-control-reserve",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: active.execution.id,
      }),
    ).resolves.toMatchObject({ status: "DELIVERED" });
    process.stdout.write("B07_L2 control-delivered\n");
    await expect(
      daemon.runtime.closeSession(session.id, session.generation),
    ).resolves.toMatchObject({ status: "CLOSED" });
    await expect(active.completion).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    process.stdout.write("B07_L2 active-closed\n");

    const page = await daemon.runtime.queryEvents(session.id, session.generation, 0, 100);
    expect(page.events.length).toBeLessThanOrEqual(6);
    expect(page.retention).toMatchObject({ gap: true, source: "memory" });
    expect(daemon.runtime.retentionSnapshot().application).toMatchObject({
      completionPromises: 0,
      dispatchStates: 0,
      executionWaiters: 0,
      startedPromises: 0,
    });
  }, 20_000);
});
