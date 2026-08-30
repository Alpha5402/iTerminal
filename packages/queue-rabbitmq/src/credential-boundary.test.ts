import { describe, expect, it } from "vitest";
import { OutboxRelay, type OutboxRepository } from "@iterminal/messaging";

import {
  SupervisedRabbitMqPublisher,
  runtimeQueueTopology,
  type RabbitMqConnectionState,
} from "./index.js";

describe("RabbitMQ credential-safe diagnostics", () => {
  it("does not expose endpoint credentials through state or durable publisher failures", async () => {
    const sentinel = "ITERM_RABBIT_CREDENTIAL_f793";
    const states: RabbitMqConnectionState[] = [];
    const publisher = new SupervisedRabbitMqPublisher(
      `amqp://operator:${sentinel}@127.0.0.1:1/%2f?token=${sentinel}`,
      runtimeQueueTopology("credential-boundary"),
      {
        initialDelayMilliseconds: 10,
        jitterRatio: 0,
        maxDelayMilliseconds: 10,
        onConnectionState: (state) => states.push(state),
      },
    );
    const message = {
      aggregateId: "session-credential-boundary",
      aggregateType: "session",
      attempt: 1,
      claimToken: "claim-credential-boundary",
      createdAt: "2026-08-31T00:00:00.000Z",
      eventType: "ExecutionReady",
      id: "outbox-credential-boundary",
      payload: { executionId: "execution-credential-boundary", generation: 1 },
    } as const;
    const retryErrors: string[] = [];
    const repository: OutboxRepository = {
      claimBatch: () => Promise.resolve([message]),
      markPublished: () => Promise.reject(new Error("unexpected publish success")),
      releaseFailed: (input) => {
        retryErrors.push(input.error);
        return Promise.resolve();
      },
    };
    const relay = new OutboxRelay("credential-boundary", repository, publisher);
    try {
      await expect(relay.publishBatch()).resolves.toEqual({ claimed: 1, failed: 1, published: 0 });
      expect(retryErrors).toHaveLength(1);
      expect(retryErrors[0]).toContain("RabbitMQ connection failed");
      expect(JSON.stringify({ retryErrors, states })).not.toContain(sentinel);
      expect(states.some((state) => state.state === "DISCONNECTED")).toBe(true);
    } finally {
      await publisher.close();
    }
  });
});
