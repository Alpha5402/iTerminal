import type { Pool } from "pg";

export function guardPostgresPool(pool: Pool): Pool {
  pool.on("error", () => {
    // pg emits idle-client failures outside query Promises. A listener prevents
    // process termination; the next real operation still rejects and drives the
    // Runtime/relay recovery policy.
  });
  return pool;
}
