import { describe, expect, it } from "vitest";

import { operationalErrorCode, operationalErrorMessage } from "./index.js";

describe("credential-safe operational diagnostics", () => {
  it("never reads or returns dependency-controlled messages, causes, or thrown strings", () => {
    const sentinel = "ITERM_CREDENTIAL_SENTINEL_f793";
    const error = Object.assign(
      new Error(`connect postgresql://operator:${sentinel}@database/iterminal?token=${sentinel}`, {
        cause: new Error(sentinel),
      }),
      { code: "ECONNREFUSED" },
    );

    const summary = operationalErrorMessage(error, "PostgreSQL connection failed");

    expect(summary).toBe("PostgreSQL connection failed (ECONNREFUSED)");
    expect(summary).not.toContain(sentinel);
    expect(operationalErrorMessage(sentinel, "Operation failed")).toBe("Operation failed");
  });

  it("accepts only closed network/domain codes or PostgreSQL SQLSTATEs", () => {
    expect(operationalErrorCode({ code: "57P01" })).toBe("57P01");
    expect(operationalErrorCode({ code: "RUNTIME_UNAVAILABLE" })).toBe("RUNTIME_UNAVAILABLE");
    expect(operationalErrorCode({ code: "ITERM_CREDENTIAL_SENTINEL" })).toBeUndefined();
    expect(operationalErrorCode({ code: "secret value" })).toBeUndefined();
    expect(operationalErrorCode({ code: "x".repeat(65) })).toBeUndefined();
    expect(operationalErrorCode({ code: 500 })).toBeUndefined();
    const accessor = Object.defineProperty({}, "code", {
      get: () => {
        throw new Error("must not invoke diagnostic accessors");
      },
    });
    expect(operationalErrorCode(accessor)).toBeUndefined();
  });
});
