import { RuntimeError } from "@iterminal/domain";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import { guardPostgresPool } from "./postgres-pool.js";

export type PostgresConnectionTarget = string | readonly string[];

export interface PostgresEndpointPool {
  readonly pool: Pool;
  endpointCount(): number;
  endpointIndex(): number;
}

interface PrimaryProbeRow extends QueryResultRow {
  readonly in_recovery: boolean;
  readonly read_only: string;
}

class PostgresEndpointRejectedError extends Error {
  public constructor() {
    super("PostgreSQL endpoint is not a writable primary");
    this.name = "PostgresEndpointRejectedError";
  }
}

class PostgresEndpointUnavailableError extends Error {
  public constructor() {
    super("PostgreSQL endpoint is unavailable or not a writable primary");
    this.name = "PostgresEndpointUnavailableError";
  }
}

export function normalizePostgresEndpoints(target: PostgresConnectionTarget): readonly string[] {
  const endpoints = (typeof target === "string" ? [target] : [...target]).map((endpoint) =>
    endpoint.trim(),
  );
  if (endpoints.length === 0 || endpoints.some((endpoint) => endpoint === "")) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "PostgreSQL endpoints must be a non-empty list of non-empty connection URLs",
    );
  }
  return endpoints;
}

export function configuredPostgresConnectionTarget(input: {
  readonly url?: string;
  readonly urls?: string;
}): PostgresConnectionTarget | undefined {
  if (input.url !== undefined && input.urls !== undefined) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "ITERM_DATABASE_URL and ITERM_DATABASE_URLS cannot be configured together",
    );
  }
  if (input.urls === undefined) {
    return input.url === undefined ? undefined : normalizePostgresEndpoints(input.url)[0];
  }
  return normalizePostgresEndpoints(input.urls.split(",").map((endpoint) => endpoint.trim()));
}

export function createPostgresEndpointPool(
  target: PostgresConnectionTarget,
  config: Omit<PoolConfig, "connectionString" | "verify">,
): PostgresEndpointPool {
  const endpoints = normalizePostgresEndpoints(target);
  let activeIndex = 0;
  const pools = endpoints.map((connectionString) =>
    guardPostgresPool(
      new Pool({
        ...config,
        connectionString,
        verify: (client, done) => {
          void client
            .query<PrimaryProbeRow>(
              `SELECT pg_is_in_recovery() AS in_recovery,
                      current_setting('transaction_read_only') AS read_only`,
            )
            .then((result) => {
              const row = result.rows[0];
              done(
                row !== undefined && row.in_recovery === false && row.read_only === "off"
                  ? undefined
                  : new PostgresEndpointRejectedError(),
              );
            })
            .catch((error: unknown) => done(asError(error)));
        },
      }),
    ),
  );

  const advance = (failedIndex: number): void => {
    if (activeIndex === failedIndex) activeIndex = (failedIndex + 1) % pools.length;
  };

  const connect = async (): Promise<PoolClient> => {
    const endpointIndex = activeIndex;
    try {
      const pool = requiredPool(pools, endpointIndex);
      return monitorClient(await pool.connect(), endpointIndex, advance);
    } catch (error) {
      if (isPostgresEndpointFailure(error)) {
        advance(endpointIndex);
        throw endpointUnavailable(error);
      }
      throw error;
    }
  };

  const query = async <Row extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: unknown,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> => {
    const client = await connect();
    try {
      return await client.query<Row>(
        queryTextOrConfig as string,
        values === undefined ? undefined : [...values],
      );
    } finally {
      client.release();
    }
  };

  const facade = {
    connect,
    end: async (): Promise<void> => {
      await Promise.all(pools.map((pool) => pool.end()));
    },
    query,
  } as unknown as Pool;

  return {
    pool: facade,
    endpointCount: () => endpoints.length,
    endpointIndex: () => activeIndex,
  };
}

export function isPostgresEndpointFailure(error: unknown): boolean {
  if (
    error instanceof PostgresEndpointRejectedError ||
    error instanceof PostgresEndpointUnavailableError
  ) {
    return true;
  }
  if (isErrorWithCode(error)) {
    if (error.code.startsWith("08")) return true;
    if (POSTGRES_ENDPOINT_FAILURE_CODES.has(error.code)) return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return POSTGRES_ENDPOINT_FAILURE_MESSAGES.some((pattern) => message.includes(pattern));
}

const POSTGRES_ENDPOINT_FAILURE_CODES = new Set([
  "25006",
  "25007",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const POSTGRES_ENDPOINT_FAILURE_MESSAGES = [
  "connection ended unexpectedly",
  "connection terminated unexpectedly",
  "connection terminated due to connection timeout",
  "query read timeout",
  "server closed the connection unexpectedly",
  "timeout exceeded when trying to connect",
];

function monitorClient(
  client: PoolClient,
  endpointIndex: number,
  advance: (failedIndex: number) => void,
): PoolClient {
  let poisoned = false;
  return new Proxy(client, {
    get: (target, property) => {
      if (property === "query") {
        return (...args: readonly unknown[]): unknown => {
          const queryMethod = Reflect.get(target, "query", target) as (
            ...queryArguments: readonly unknown[]
          ) => unknown;
          const result: unknown = Reflect.apply(queryMethod, target, args);
          if (!isPromiseLike(result)) return result;
          return result.catch((error: unknown) => {
            if (isPostgresEndpointFailure(error)) {
              poisoned = true;
              advance(endpointIndex);
              throw endpointUnavailable(error);
            }
            throw error;
          });
        };
      }
      if (property === "release") {
        return (destroy?: boolean): void => target.release(destroy ?? poisoned);
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: readonly unknown[]): unknown =>
        Reflect.apply(value, target, args) as unknown;
    },
  });
}

function requiredPool(pools: readonly Pool[], index: number): Pool {
  const pool = pools[index];
  if (pool === undefined) throw new Error("PostgreSQL endpoint index is out of range");
  return pool;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isErrorWithCode(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function endpointUnavailable(error: unknown): PostgresEndpointUnavailableError {
  return error instanceof PostgresEndpointUnavailableError
    ? error
    : new PostgresEndpointUnavailableError();
}
