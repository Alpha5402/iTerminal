import type { Pool } from "pg";

export function guardPostgresPool(pool: Pool): Pool {
  pool.on("connect", (client) => {
    client.on("error", () => {
      // Checked-out pg clients can emit after a query timeout when the broken
      // transport is reset. Query Promises and the recovery supervisor still
      // observe failure; this listener prevents EventEmitter process exit.
    });
  });
  pool.on("error", () => {
    // pg emits idle-client failures outside query Promises. A listener prevents
    // process termination; the next real operation still rejects and drives the
    // Runtime/relay recovery policy.
  });
  return pool;
}
