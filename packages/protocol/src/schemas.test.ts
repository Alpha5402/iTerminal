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
