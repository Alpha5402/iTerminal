import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  approvedExecuteRequestFixture,
  invalidProtocolFixtures,
  lineInputRequestFixture,
  validExecuteRequestFixture,
  validInputRequestFixture,
} from "./fixtures.js";
import { executeRequestSchema, inputRequestSchema } from "./schemas.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  actionLookupResultSchema,
  actionLookupTransportRequestSchema,
  artifactReadResultSchema,
  artifactReadTransportRequestSchema,
  defineRuntimeCapabilities,
  executionObserveResultSchema,
  executionObserveTransportRequestSchema,
  executionOutputReadResultSchema,
  executionOutputReadTransportRequestSchema,
  executionWaitV2ResultSchema,
  executionWaitV2TransportRequestSchema,
  eventPageTransportSchema,
  executeTransportRequestSchema,
  historyLookupResultSchema,
  historyLookupTransportRequestSchema,
  inputTransportRequestSchema,
  runtimeCapabilitiesRequestSchema,
  runtimeCapabilitiesSchema,
} from "./transport.js";

type Validate = ((value: unknown) => boolean) & { errors?: readonly unknown[] | null };
const AjvConstructor = Ajv as unknown as {
  new (options: { allErrors: boolean }): {
    compile(schema: unknown): Validate;
    errorsText(errors?: unknown): string;
  };
};
const ajv = new AjvConstructor({ allErrors: true });
const validateExecute = ajv.compile(executeRequestSchema);
const validateInput = ajv.compile(inputRequestSchema);

describe("public Execute/Input request schemas", () => {
  it.each([
    ["Execute without approval", validateExecute, validExecuteRequestFixture],
    ["Execute with approval", validateExecute, approvedExecuteRequestFixture],
    ["Input without line precondition", validateInput, validInputRequestFixture],
    ["Input with line precondition", validateInput, lineInputRequestFixture],
  ])("accepts %s", (_label, validate, fixture) => {
    expect(validate(fixture), ajv.errorsText(validate.errors)).toBe(true);
  });

  it.each([
    ["unknown Execute field", validateExecute, invalidProtocolFixtures.unknownExecuteField],
    ["wrong approvalId type", validateExecute, invalidProtocolFixtures.invalidApprovalId],
    ["unknown Input field", validateInput, invalidProtocolFixtures.unknownInputField],
    ["invalid line input version", validateInput, invalidProtocolFixtures.invalidLineInputVersion],
    ["invalid generation", validateInput, invalidProtocolFixtures.invalidGeneration],
  ])("rejects %s", (_label, validate, fixture) => {
    expect(validate(fixture)).toBe(false);
  });

  it("keeps body actor as a shaped field, not an authorization source", () => {
    // Transport adapters replace actor with the authenticated context before calling Application.
    // This schema only validates the request shape and cannot grant capabilities by itself.
    expect(executeRequestSchema.properties.actor).toBeDefined();
    expect(executeRequestSchema.required).toContain("actor");
  });
});

describe("canonical transport schemas", () => {
  it("validates bounded memory Event retention metadata without changing Event objects", () => {
    const event = {
      id: "event-3",
      observedAt: "2026-09-05T00:00:00.000Z",
      payload: { unchanged: true },
      sequence: 3,
      sessionGeneration: 1,
      sessionId: "session-events",
      type: "fixture.event",
    };
    expect(
      eventPageTransportSchema.parse({
        events: [event],
        retention: { gap: true, minimumAvailableSequence: 3, source: "memory" },
        truncated: false,
      }),
    ).toEqual({
      events: [event],
      retention: { gap: true, minimumAvailableSequence: 3, source: "memory" },
      truncated: false,
    });
    expect(() =>
      eventPageTransportSchema.parse({
        events: [event],
        retention: { gap: true, minimumAvailableSequence: 0, source: "memory" },
        truncated: false,
      }),
    ).toThrow();
    expect(() =>
      eventPageTransportSchema.parse({ events: [event], nextAfter: 2, truncated: true }),
    ).toThrow();
    expect(() =>
      eventPageTransportSchema.parse({
        events: [{ ...event, unexpected: true }],
        truncated: false,
      }),
    ).toThrow();
    expect(() =>
      eventPageTransportSchema.parse({
        events: [event],
        retention: { gap: true, minimumAvailableSequence: 4, source: "memory" },
        truncated: false,
      }),
    ).toThrow();
    expect(() =>
      eventPageTransportSchema.parse({
        events: Array.from({ length: 65 }, (_, index) => ({
          ...event,
          id: `event-${index.toString()}`,
          payload: { data: "x".repeat(64 * 1024 - 32) },
          sequence: index + 1,
        })),
        truncated: false,
      }),
    ).toThrowError(/4 MiB/);
  });

  it("binds durable history facts to exact targets and terminal tombstones", () => {
    const request = historyLookupTransportRequestSchema.parse({
      generation: 2,
      sessionId: "session-history",
      target: { executionId: "execution-history", type: "execution" },
    });
    const fact = {
      acceptedAt: new Date(0).toISOString(),
      actionId: "action-history",
      actionStatus: "COMPLETED" as const,
      executionId: "execution-history",
      executionStatus: "COMPLETED" as const,
      targetType: "execution" as const,
    };
    expect(
      historyLookupResultSchema.parse({
        fact,
        generation: request.generation,
        kind: "compacted",
        retention: { expiredAt: new Date(1).toISOString(), state: "expired" },
        sessionId: request.sessionId,
        target: request.target,
      }),
    ).toMatchObject({ kind: "compacted", retention: { state: "expired" } });
    expect(() =>
      historyLookupResultSchema.parse({
        fact: { ...fact, executionId: "execution-other" },
        generation: request.generation,
        kind: "full",
        sessionId: request.sessionId,
        source: "durable",
        target: request.target,
      }),
    ).toThrow();
    expect(() =>
      historyLookupResultSchema.parse({
        fact: { ...fact, actionStatus: "RUNNING", executionStatus: "RUNNING" },
        generation: request.generation,
        kind: "compacted",
        retention: { expiredAt: new Date(1).toISOString(), state: "expired" },
        sessionId: request.sessionId,
        target: request.target,
      }),
    ).toThrow();
  });

  it("bounds Execution wait v2 and defines completed as terminal, not successful", () => {
    expect(executionWaitV2TransportRequestSchema.parse({ executionId: "execution-1" })).toEqual({
      executionId: "execution-1",
      waitMs: 10_000,
    });
    expect(
      executionWaitV2TransportRequestSchema.parse({ executionId: "execution-1", waitMs: 0 }),
    ).toEqual({ executionId: "execution-1", waitMs: 0 });
    expect(() =>
      executionWaitV2TransportRequestSchema.parse({ executionId: "execution-1", waitMs: 30_001 }),
    ).toThrow();

    for (const executionState of ["COMPLETED", "FAILED", "INTERRUPTED", "UNKNOWN"] as const) {
      expect(
        executionWaitV2ResultSchema.parse({
          completed: true,
          executionId: "execution-1",
          executionState,
        }),
      ).toMatchObject({ completed: true, executionState });
    }
    expect(() =>
      executionWaitV2ResultSchema.parse({
        completed: true,
        executionId: "execution-1",
        executionState: "RUNNING",
      }),
    ).toThrow();
    expect(() =>
      executionWaitV2ResultSchema.parse({
        completed: false,
        executionId: "execution-1",
        executionState: "FAILED",
      }),
    ).toThrow();
  });

  it("bounds Artifact byte-range requests and verifies response arithmetic", () => {
    expect(
      artifactReadTransportRequestSchema.parse({
        artifactId: "art-1",
        generation: 2,
        sessionId: "session-1",
      }),
    ).toEqual({
      artifactId: "art-1",
      generation: 2,
      offsetBytes: 0,
      sessionId: "session-1",
    });
    expect(() =>
      artifactReadTransportRequestSchema.parse({
        artifactId: "art-1",
        generation: 2,
        maxBytes: 64 * 1024 + 1,
        sessionId: "session-1",
      }),
    ).toThrow();
    expect(
      artifactReadResultSchema.parse({
        artifactId: "art-1",
        contentBase64: Buffer.from("hello", "utf8").toString("base64"),
        contentType: "application/octet-stream",
        eof: true,
        generation: 2,
        kind: "found",
        nextOffset: 5,
        offsetBytes: 0,
        returnedBytes: 5,
        sessionId: "session-1",
        totalBytes: 5,
      }),
    ).not.toHaveProperty("sha256");
    for (const invalid of [
      { contentBase64: "AAAA", returnedBytes: 1 },
      { nextOffset: 4 },
      { eof: false },
      { contentBase64: "not base64!" },
    ]) {
      expect(() =>
        artifactReadResultSchema.parse({
          artifactId: "art-1",
          contentBase64: Buffer.from("hello", "utf8").toString("base64"),
          contentType: "application/octet-stream",
          eof: true,
          generation: 2,
          kind: "found",
          nextOffset: 5,
          offsetBytes: 0,
          returnedBytes: 5,
          sessionId: "session-1",
          totalBytes: 5,
          ...invalid,
        }),
      ).toThrow();
    }
  });

  it("bounds Action lookup identity and projected results without payload fingerprints", () => {
    expect(
      actionLookupTransportRequestSchema.parse({
        generation: 2,
        idempotencyKey: "accepted-request",
        sessionId: "session-1",
      }),
    ).toEqual({ generation: 2, idempotencyKey: "accepted-request", sessionId: "session-1" });
    expect(() =>
      actionLookupTransportRequestSchema.parse({
        actor: { id: "untrusted" },
        generation: 2,
        idempotencyKey: "accepted-request",
        sessionId: "session-1",
      }),
    ).toThrow();
    expect(
      actionLookupResultSchema.parse({
        acceptedAt: new Date(0).toISOString(),
        actionId: "action-1",
        actionStatus: "UNKNOWN",
        actionType: "execute",
        executionId: "execution-1",
        executionStatus: "UNKNOWN",
        generation: 2,
        idempotencyKey: "accepted-request",
        kind: "found",
        sessionId: "session-1",
      }),
    ).not.toHaveProperty("requestHash");
    expect(() =>
      actionLookupResultSchema.parse({
        acceptedAt: new Date(0).toISOString(),
        actionId: "action-1",
        actionStatus: "COMPLETED",
        actionType: "execute",
        command: "secret command",
        generation: 2,
        idempotencyKey: "accepted-request",
        kind: "found",
        requestHash: "a".repeat(64),
        sessionId: "session-1",
      }),
    ).toThrow();
  });

  it("bounds durable Execution output requests, bytes, gaps, and total transport size", () => {
    expect(
      executionOutputReadTransportRequestSchema.parse({
        executionId: "execution-1",
        generation: 2,
        sessionId: "session-1",
      }),
    ).toEqual({ executionId: "execution-1", generation: 2, sessionId: "session-1" });
    expect(() =>
      executionOutputReadTransportRequestSchema.parse({
        executionId: "execution-1",
        generation: 2,
        maxBytes: 64 * 1024 + 1,
        sessionId: "session-1",
      }),
    ).toThrow();

    const bytes = Buffer.alloc(64 * 1024, 0xa5);
    const maximum = executionOutputReadResultSchema.parse({
      chunks: [{ byteLength: bytes.length, contentBase64: bytes.toString("base64") }],
      encoding: "base64",
      executionId: "execution-1",
      executionState: "RUNNING",
      gap: null,
      generation: 2,
      hasMore: false,
      nextCursor: "a".repeat(2_048),
      persistenceLag: "possible",
      retention: { minimumAvailableSequence: 1, source: "durable" },
      sessionId: "session-1",
      stream: "pty",
    });
    expect(new TextEncoder().encode(JSON.stringify(maximum)).byteLength).toBeLessThanOrEqual(
      96 * 1024,
    );

    for (const invalid of [
      {
        chunks: [{ byteLength: 1, contentBase64: Buffer.from("two").toString("base64") }],
      },
      {
        chunks: [
          { byteLength: 1, contentBase64: Buffer.from("a").toString("base64") },
          { byteLength: 1, contentBase64: Buffer.from("b").toString("base64") },
        ],
      },
      {
        gap: { eventSequence: 8, kind: "artifact_missing", resumeCursor: "resume" },
        hasMore: true,
      },
      { executionState: "RUNNING", persistenceLag: "none" },
      { executionState: "COMPLETED", persistenceLag: "possible" },
      {
        chunks: [{ byteLength: 1, contentBase64: Buffer.from("a").toString("base64") }],
        nextCursor: undefined,
      },
      {
        gap: { kind: "event_retention", minimumAvailableSequence: 9 },
        nextCursor: undefined,
      },
    ]) {
      expect(() =>
        executionOutputReadResultSchema.parse({
          chunks: [],
          encoding: "base64",
          executionId: "execution-1",
          executionState: "COMPLETED",
          gap: null,
          generation: 2,
          hasMore: false,
          persistenceLag: "none",
          retention: { minimumAvailableSequence: 1, source: "durable" },
          sessionId: "session-1",
          stream: "pty",
          ...invalid,
        }),
      ).toThrow();
    }
  });

  it("bounds compact Execution observation and derives its terminal hints", () => {
    expect(
      executionObserveTransportRequestSchema.parse({
        executionId: "execution-1",
        generation: 2,
        sessionId: "session-1",
      }),
    ).toEqual({
      executionId: "execution-1",
      generation: 2,
      sessionId: "session-1",
      waitMs: 10_000,
    });
    expect(() =>
      executionObserveTransportRequestSchema.parse({
        executionId: "execution-1",
        generation: 2,
        sessionId: "session-1",
        waitMs: 30_001,
      }),
    ).toThrow();

    const bytes = Buffer.alloc(64 * 1024, 0xa5);
    const maximum = executionObserveResultSchema.parse({
      gap: null,
      identity: { executionId: "execution-1", generation: 2, sessionId: "session-1" },
      nextActions: [],
      nextCursor: "a".repeat(2_048),
      output: {
        byteLength: bytes.length,
        contentBase64: bytes.toString("base64"),
        encoding: "base64",
        hasMore: false,
        retention: { minimumAvailableSequence: 1, source: "durable" },
        stream: "pty",
        textStatus: "omitted_for_budget",
      },
      state: {
        completed: true,
        executionState: "COMPLETED",
        persistenceLag: "none",
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(maximum)).byteLength).toBeLessThanOrEqual(
      96 * 1024,
    );

    const active = {
      gap: null,
      identity: { executionId: "execution-1", generation: 2, sessionId: "session-1" },
      nextActions: ["wait_for_completion"],
      nextCursor: null,
      output: {
        byteLength: 0,
        contentBase64: "",
        encoding: "base64",
        hasMore: false,
        retention: { minimumAvailableSequence: 1, source: "durable" },
        stream: "pty",
        text: "",
        textStatus: "complete",
      },
      state: {
        completed: false,
        executionState: "RUNNING",
        persistenceLag: "possible",
      },
    } as const;
    expect(executionObserveResultSchema.parse(active)).toEqual(active);
    for (const invalid of [
      { nextActions: [] },
      { state: { ...active.state, completed: true } },
      { state: { ...active.state, persistenceLag: "none" } },
      { output: { ...active.output, text: undefined, textStatus: "complete" } },
      { output: { ...active.output, text: "replacement", textStatus: "unaligned_utf8" } },
    ]) {
      expect(() =>
        executionObserveResultSchema.parse({
          ...active,
          ...invalid,
        }),
      ).toThrow();
    }
  });

  it("shares actor-free Execute and Input fields across adapters", () => {
    expect(
      executeTransportRequestSchema.parse({
        approvalId: "approval-1",
        command: "printf ready",
        generation: 3,
        idempotencyKey: "execute-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ generation: 3, sessionId: "session-1" });
    expect(
      inputTransportRequestSchema.parse({
        data: "yes\n",
        generation: 3,
        idempotencyKey: "input-1",
        lineInput: { expectedInputVersion: 1, expectedInteractionVersion: 2 },
        sessionId: "session-1",
        targetExecutionId: "execution-1",
      }),
    ).toMatchObject({ targetExecutionId: "execution-1" });
    expect(() =>
      executeTransportRequestSchema.parse({
        actor: { id: "untrusted" },
        command: "printf nope",
        generation: 3,
        idempotencyKey: "execute-2",
        sessionId: "session-1",
      }),
    ).toThrow();
  });

  it("accepts unscoped and exact-owner capability requests", () => {
    expect(runtimeCapabilitiesRequestSchema.parse({})).toEqual({});
    expect(runtimeCapabilitiesRequestSchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
    });
    expect(() => runtimeCapabilitiesRequestSchema.parse({ executionId: "execution-1" })).toThrow();
  });

  it("bounds capability responses and requires canonical features", () => {
    expect(
      defineRuntimeCapabilities({
        buildId: "daemon-2026.09.05+1",
        features: ["runtime.capabilities.v1", "action.execute.v1"],
      }),
    ).toEqual({
      buildId: "daemon-2026.09.05+1",
      features: ["action.execute.v1", "runtime.capabilities.v1"],
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
    });
    expect(() =>
      runtimeCapabilitiesSchema.parse({
        buildId: "/private/runtime/token",
        features: ["runtime.capabilities.v1"],
        protocolVersion: "1",
      }),
    ).toThrow();
    expect(() =>
      runtimeCapabilitiesSchema.parse({
        buildId: "daemon-1",
        features: ["runtime.capabilities.v1", "action.execute.v1"],
        protocolVersion: "1",
      }),
    ).toThrow();
    expect(
      runtimeCapabilitiesSchema.parse({
        buildId: "future-owner",
        features: ["action.lookup.v1", "runtime.capabilities.v1"],
        protocolVersion: "1",
      }).features,
    ).toEqual(["action.lookup.v1", "runtime.capabilities.v1"]);
    expect(() =>
      runtimeCapabilitiesSchema.parse({
        buildId: "daemon-1",
        features: ["runtime.capabilities.v1"],
        protocolVersion: "1",
        socketPath: "/tmp/runtime.sock",
      }),
    ).toThrow();
  });
});
