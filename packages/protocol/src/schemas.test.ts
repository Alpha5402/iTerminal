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
  executeTransportRequestSchema,
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
