import type { LineInputPrecondition } from "@iterminal/domain";
import * as z from "zod/v4";

export const RUNTIME_PROTOCOL_VERSION = "1";
export const UNKNOWN_RUNTIME_BUILD_ID = "unknown";

export const RUNTIME_FEATURES = Object.freeze([
  "action.execute.v1",
  "action.input.v1",
  "runtime.capabilities.v1",
  "runtime.owner-capabilities.v1",
] as const);

export const runtimeFeatureSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);

export type RuntimeFeature = z.output<typeof runtimeFeatureSchema>;

export interface RuntimeCapabilities {
  readonly buildId: string;
  readonly features: readonly RuntimeFeature[];
  readonly protocolVersion: string;
}

export const sessionIdTransportSchema = z.string().min(1).max(256);
export const sessionGenerationTransportSchema = z.number().int().positive();
export const executionIdTransportSchema = z.string().min(1).max(256);
export const idempotencyKeyTransportSchema = z.string().min(1).max(256);

export const lineInputPreconditionTransportSchema: z.ZodType<LineInputPrecondition> =
  z.strictObject({
    expectedInputVersion: z.number().int().nonnegative(),
    expectedInteractionVersion: z.number().int().positive(),
  });

export const executeTransportRequestSchema = z.strictObject({
  approvalId: z.string().min(1).max(256).optional(),
  command: z.string().max(256 * 1024),
  generation: sessionGenerationTransportSchema,
  idempotencyKey: idempotencyKeyTransportSchema,
  sessionId: sessionIdTransportSchema,
});

export const inputTransportRequestSchema = z.strictObject({
  data: z.string().max(64 * 1024),
  expectedScreenVersion: z.number().int().nonnegative().optional(),
  generation: sessionGenerationTransportSchema,
  idempotencyKey: idempotencyKeyTransportSchema,
  lineInput: lineInputPreconditionTransportSchema.optional(),
  sessionId: sessionIdTransportSchema,
  targetExecutionId: executionIdTransportSchema,
});

export const runtimeCapabilitiesRequestSchema = z.strictObject({
  sessionId: sessionIdTransportSchema.optional(),
});

const canonicalRuntimeFeaturesSchema = z
  .array(runtimeFeatureSchema)
  .max(128)
  .refine(
    (features) => features.every((feature, index) => index === 0 || features[index - 1]! < feature),
    "Runtime features must be sorted and duplicate-free",
  );

export const runtimeCapabilitiesSchema: z.ZodType<RuntimeCapabilities> = z.strictObject({
  buildId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  features: canonicalRuntimeFeaturesSchema,
  protocolVersion: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
});

export type ExecuteTransportRequest = z.output<typeof executeTransportRequestSchema>;
export type InputTransportRequest = z.output<typeof inputTransportRequestSchema>;
export type RuntimeCapabilitiesRequest = z.output<typeof runtimeCapabilitiesRequestSchema>;

export function defineRuntimeCapabilities(input: {
  readonly buildId?: string;
  readonly features: readonly RuntimeFeature[];
  readonly protocolVersion?: string;
}): RuntimeCapabilities {
  return runtimeCapabilitiesSchema.parse({
    buildId: input.buildId ?? UNKNOWN_RUNTIME_BUILD_ID,
    features: [...input.features].sort(),
    protocolVersion: input.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
  });
}
