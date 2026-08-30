import { RuntimeError } from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import {
  configuredPostgresConnectionTarget,
  createPostgresEndpointPool,
  normalizePostgresEndpoints,
} from "./postgres-endpoints.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describe("PostgreSQL endpoint configuration", () => {
  it("keeps one URL backward compatible and parses an ordered URL list", () => {
    expect(normalizePostgresEndpoints("postgresql://one/database")).toEqual([
      "postgresql://one/database",
    ]);
    expect(
      configuredPostgresConnectionTarget({
        urls: " postgresql://one/database,postgresql://two/database ",
      }),
    ).toEqual(["postgresql://one/database", "postgresql://two/database"]);
  });

  it("rejects ambiguous or empty endpoint configuration", () => {
    expect(() =>
      configuredPostgresConnectionTarget({
        url: "postgresql://one/database",
        urls: "postgresql://two/database",
      }),
    ).toThrow(RuntimeError);
    expect(() =>
      configuredPostgresConnectionTarget({ urls: "postgresql://one/database," }),
    ).toThrow("PostgreSQL endpoints must be a non-empty list");
    expect(() => normalizePostgresEndpoints([])).toThrow(
      "PostgreSQL endpoints must be a non-empty list",
    );
    expect(() => configuredPostgresConnectionTarget({ url: "" })).toThrow(
      "PostgreSQL endpoints must be a non-empty list",
    );
  });
});

describeDatabase("PostgreSQL ordered endpoint pool", () => {
  it("advances only after a failed operation and does not replay that operation", async () => {
    const endpoints = createPostgresEndpointPool(
      ["postgresql://127.0.0.1:1/iterminal_test", databaseUrl ?? ""],
      {
        connectionTimeoutMillis: 100,
        max: 1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    );
    try {
      await expect(endpoints.pool.query("SELECT 1")).rejects.toBeInstanceOf(Error);
      expect(endpoints.endpointIndex()).toBe(1);
      await expect(
        endpoints.pool.query<{ value: number }>("SELECT 42 AS value"),
      ).resolves.toMatchObject({ rows: [{ value: 42 }] });
      expect(endpoints.endpointIndex()).toBe(1);
    } finally {
      await endpoints.pool.end();
    }
  });

  it("retires a statement-timeout connection before the next supervisor attempt", async () => {
    const endpoints = createPostgresEndpointPool([databaseUrl ?? "", databaseUrl ?? ""], {
      connectionTimeoutMillis: 500,
      max: 1,
      query_timeout: 25,
      statement_timeout: 25,
    });
    try {
      await expect(endpoints.pool.query("SELECT pg_sleep(0.1)")).rejects.toBeInstanceOf(Error);
      expect(endpoints.endpointIndex()).toBe(1);
      await expect(endpoints.pool.query("SELECT 1")).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await endpoints.pool.end();
    }
  });
});
