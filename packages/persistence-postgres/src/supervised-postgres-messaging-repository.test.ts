import { RuntimeError } from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import { isPostgresAvailabilityError } from "./supervised-postgres-messaging-repository.js";

describe("PostgreSQL availability classification", () => {
  it.each([
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("administrator shutdown"), { code: "57P01" }),
    Object.assign(new Error("transport failure"), { code: "08006" }),
    new Error("Connection terminated unexpectedly"),
    new RuntimeError("RUNTIME_UNAVAILABLE", "messaging repository unavailable"),
  ])("recognizes a reconnectable transport failure", (error) => {
    expect(isPostgresAvailabilityError(error)).toBe(true);
  });

  it.each([
    new Error("relation outbox does not exist"),
    Object.assign(new Error("statement timeout"), { code: "57014" }),
    new RuntimeError("DELIVERY_UNKNOWN", "claim is no longer current"),
  ])("does not hide a non-transport failure", (error) => {
    expect(isPostgresAvailabilityError(error)).toBe(false);
  });
});
