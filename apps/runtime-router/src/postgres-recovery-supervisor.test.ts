import { describe, expect, it } from "vitest";

import {
  startRouterPostgresRecoverySupervisor,
  type RuntimeRouterDatabaseState,
} from "./postgres-recovery-supervisor.js";

describe("Runtime Router PostgreSQL recovery supervisor", () => {
  it("fails the gate closed until cold-start migration recovers", async () => {
    const states: RuntimeRouterDatabaseState[] = [];
    let migrations = 0;
    const supervisor = startRouterPostgresRecoverySupervisor({
      database: {
        healthCheck: () => Promise.resolve(),
        migrate: () => {
          migrations += 1;
          return migrations < 3
            ? Promise.reject(new Error("database unavailable"))
            : Promise.resolve();
        },
      },
      healthCheckMilliseconds: 1_000,
      initialDelayMilliseconds: 1,
      jitterRatio: 0,
      maxDelayMilliseconds: 1,
      updateState: (state) => states.push(state),
    });
    try {
      expect(captureFailure(() => supervisor.gate.assertReady("session.get"))).toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        details: {
          component: "runtime-router",
          operation: "session.get",
          phase: "route_resolution",
        },
      });
      await waitForState(() => supervisor.state(), "READY");
      expect(migrations).toBe(3);
      expect(states.map((state) => `${state.phase}:${state.attempt.toString()}`)).toEqual([
        "CONNECTING:1",
        "UNAVAILABLE:1",
        "CONNECTING:2",
        "UNAVAILABLE:2",
        "CONNECTING:3",
        "READY:0",
      ]);
      expect(() => supervisor.gate.assertReady("session.get")).not.toThrow();
    } finally {
      await supervisor.close();
    }
  });

  it("re-enters migration after a ready route query reports database loss", async () => {
    let migrations = 0;
    const supervisor = startRouterPostgresRecoverySupervisor({
      database: {
        healthCheck: () => Promise.resolve(),
        migrate: () => {
          migrations += 1;
          return Promise.resolve();
        },
      },
      healthCheckMilliseconds: 1,
      initialDelayMilliseconds: 1,
      jitterRatio: 0,
      maxDelayMilliseconds: 1,
    });
    try {
      await waitForState(() => supervisor.state(), "READY");
      supervisor.gate.reportUnavailable();
      expect(captureFailure(() => supervisor.gate.assertReady("session.create"))).toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      await waitUntil(() => migrations >= 2 && supervisor.state().phase === "READY");
      expect(() => supervisor.gate.assertReady("session.create")).not.toThrow();
    } finally {
      await supervisor.close();
    }
  });
});

async function waitForState(
  state: () => RuntimeRouterDatabaseState,
  phase: RuntimeRouterDatabaseState["phase"],
): Promise<void> {
  await waitUntil(() => state().phase === phase);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Router PostgreSQL supervisor state did not converge");
}

function captureFailure(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected Router database gate to reject the operation");
}
