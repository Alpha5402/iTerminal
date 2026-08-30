import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const actor = {
  client: "resize-test",
  id: "agent-resize-test",
  principal: "resize-test",
  type: "agent" as const,
};
const human = {
  client: "resize-console",
  id: "human-resize-test",
  principal: "resize-human",
  type: "human" as const,
};

describe("M6.6 controlled terminal geometry", () => {
  let daemon: RuntimeDaemonHandle | undefined;
  let fixtureRoot = "";

  afterEach(async () => {
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
    fixtureRoot = "";
  });

  it("marks an attempted but unconfirmed resize UNKNOWN and breaks the generation", async () => {
    fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-resize-unknown-")));
    daemon = await startRuntimeDaemon({
      hooks: {
        afterResizeWrite: () => {
          throw new Error("injected post-resize crash boundary");
        },
      },
      socketPath: join(fixtureRoot, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: fixtureRoot });

    await expect(
      runtime.resizeTerminal({
        actor,
        columns: 96,
        expectedGeometryVersion: 1,
        idempotencyKey: "resize-unknown",
        rows: 30,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", retryable: false });
    expect(await runtime.getSession(session.id)).toMatchObject({ status: "BROKEN" });
    await expect(
      runtime.resizeTerminal({
        actor,
        columns: 96,
        expectedGeometryVersion: 1,
        idempotencyKey: "resize-unknown",
        rows: 30,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ status: "UNKNOWN", type: "resize" });
    const events = await runtime.queryEvents(session.id, session.generation, 0, 100);
    expect(events.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "action.accepted",
        "terminal.resize_write_attempted",
        "terminal.resize_unknown",
        "session.broken",
      ]),
    );
  });

  it("applies the Human Guard to resize and lets only its holder change geometry", async () => {
    fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-resize-guard-")));
    daemon = await startRuntimeDaemon({ socketPath: join(fixtureRoot, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: fixtureRoot });
    const started = await runtime.startExecute({
      actor: human,
      command: "sleep 30",
      idempotencyKey: "resize-guard-foreground",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const execution = await runtime.getExecution(started.execution.id);
      if (execution.status === "RUNNING") break;
      if (attempt === 199) throw new Error("Resize Guard fixture did not enter RUNNING");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    await runtime.acquireInteractionGuard({
      actor: human,
      expectedVersion: 1,
      reason: "human resize decision",
      sessionGeneration: session.generation,
      sessionId: session.id,
      ttlMilliseconds: 5_000,
    });

    await expect(
      runtime.resizeTerminal({
        actor,
        columns: 96,
        expectedGeometryVersion: 1,
        idempotencyKey: "resize-guarded-agent",
        rows: 30,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "INPUT_GUARDED", retryable: true });
    await expect(
      runtime.resizeTerminal({
        actor: human,
        columns: 96,
        expectedGeometryVersion: 1,
        idempotencyKey: "resize-guard-holder",
        rows: 30,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ status: "DELIVERED", type: "resize" });
    await expect(runtime.getScreen(session.id, session.generation)).resolves.toMatchObject({
      columns: 96,
      geometryVersion: 2,
      rows: 30,
    });
    const events = await runtime.queryEvents(session.id, session.generation, 0, 100);
    expect(events.events.filter((event) => event.type === "terminal.resized")).toHaveLength(1);
    await runtime.closeSession(session.id, session.generation);
  });
});
