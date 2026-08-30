import { describe, expect, it } from "vitest";

import {
  SupervisedPostgresMessagingRepository,
  type PostgresConnectionState,
} from "./supervised-postgres-messaging-repository.js";

describe("PostgreSQL credential-safe diagnostics", () => {
  it("does not expose endpoint credentials through recovery state", async () => {
    const sentinel = "ITERM_POSTGRES_CREDENTIAL_f793";
    const states: PostgresConnectionState[] = [];
    const repository = await SupervisedPostgresMessagingRepository.start(
      `postgresql://operator:${sentinel}@127.0.0.1:1/iterminal?token=${sentinel}`,
      {
        connectionTimeoutMilliseconds: 250,
        healthCheckMilliseconds: 10,
        initialDelayMilliseconds: 10,
        jitterRatio: 0,
        maxDelayMilliseconds: 10,
        onConnectionState: (state) => states.push(state),
        operationTimeoutMilliseconds: 250,
      },
    );
    try {
      expect(states.some((state) => state.state === "DISCONNECTED")).toBe(true);
      expect(JSON.stringify(states)).not.toContain(sentinel);
      expect(repository.connectionState().error).toContain("PostgreSQL connection unavailable");
    } finally {
      await repository.close();
    }
  });
});
