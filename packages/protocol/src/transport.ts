import type { LineInputPrecondition } from "@iterminal/domain";
import * as z from "zod/v4";

export const RUNTIME_PROTOCOL_VERSION = "1";
export const UNKNOWN_RUNTIME_BUILD_ID = "unknown";

export const RUNTIME_FEATURES = Object.freeze([
  "action.execute.v1",
  "action.input.v1",
  "action.lookup.v1",
  "artifact.read.v1",
  "execution.observe.v1",
  "execution.output.read.v1",
  "execution.wait.v2",
  "history.lookup.v1",
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

export const actionLookupTransportRequestSchema = z.strictObject({
  generation: sessionGenerationTransportSchema,
  idempotencyKey: idempotencyKeyTransportSchema,
  sessionId: sessionIdTransportSchema,
});

const historyLookupTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ idempotencyKey: idempotencyKeyTransportSchema, type: z.literal("action") }),
  z.strictObject({ executionId: executionIdTransportSchema, type: z.literal("execution") }),
]);

export const historyLookupTransportRequestSchema = z.strictObject({
  generation: sessionGenerationTransportSchema,
  sessionId: sessionIdTransportSchema,
  target: historyLookupTargetSchema,
});

const actionStatusTransportSchema = z.enum([
  "ACCEPTED",
  "DISPATCHING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "UNKNOWN",
  "CANCELLED",
  "DELIVERED",
  "REJECTED",
]);

const historyActionFactSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  actionId: z.string().min(1).max(256),
  actionStatus: actionStatusTransportSchema,
  actionType: z.enum(["execute", "input", "secret_input", "control", "resize"]),
  executionId: executionIdTransportSchema.optional(),
  executionStatus: z
    .enum(["DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "UNKNOWN"])
    .optional(),
  targetType: z.literal("action"),
});

const historyExecutionFactSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  actionId: z.string().min(1).max(256),
  actionStatus: z.enum(["DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "UNKNOWN"]),
  executionId: executionIdTransportSchema,
  executionStatus: z.enum([
    "DISPATCHING",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
    "UNKNOWN",
  ]),
  exitCode: z.number().int().optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  targetType: z.literal("execution"),
});

const historyFactSchema = z.discriminatedUnion("targetType", [
  historyActionFactSchema,
  historyExecutionFactSchema,
]);

const historyLookupIdentitySchema = z.strictObject({
  generation: sessionGenerationTransportSchema,
  sessionId: sessionIdTransportSchema,
  target: historyLookupTargetSchema,
});

export const historyLookupResultSchema = z
  .discriminatedUnion("kind", [
    historyLookupIdentitySchema.extend({
      fact: historyFactSchema,
      kind: z.literal("full"),
      source: z.enum(["durable", "live"]),
    }),
    historyLookupIdentitySchema.extend({
      fact: historyFactSchema,
      kind: z.literal("compacted"),
      retention: z.strictObject({
        expiredAt: z.iso.datetime({ offset: true }),
        state: z.literal("expired"),
      }),
    }),
    historyLookupIdentitySchema.extend({
      kind: z.literal("not_found"),
      message: z.string().min(1).max(512),
    }),
    historyLookupIdentitySchema.extend({
      kind: z.literal("unavailable"),
      message: z.string().min(1).max(512),
      reason: z.enum(["durability_timeout", "durability_unavailable", "owner_route_unavailable"]),
      retryable: z.literal(true),
    }),
  ])
  .superRefine((result, context) => {
    if (result.kind !== "full" && result.kind !== "compacted") return;
    if (result.target.type !== result.fact.targetType) {
      context.addIssue({ code: "custom", message: "History target and fact types must match" });
      return;
    }
    if (
      result.target.type === "execution" &&
      result.fact.targetType === "execution" &&
      result.target.executionId !== result.fact.executionId
    ) {
      context.addIssue({ code: "custom", message: "History Execution identity must match" });
    }
    if (
      result.kind === "compacted" &&
      (result.fact.actionStatus === "ACCEPTED" ||
        result.fact.actionStatus === "DISPATCHING" ||
        result.fact.actionStatus === "RUNNING")
    ) {
      context.addIssue({ code: "custom", message: "Compacted history must be terminal" });
    }
  });

export const artifactReadTransportRequestSchema = z.strictObject({
  artifactId: z.string().min(1).max(256),
  generation: sessionGenerationTransportSchema,
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024)
    .optional(),
  offsetBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  sessionId: sessionIdTransportSchema,
});

const artifactReadIdentitySchema = z.strictObject({
  artifactId: z.string().min(1).max(256),
  generation: sessionGenerationTransportSchema,
  sessionId: sessionIdTransportSchema,
});

const artifactReadFoundSchema = artifactReadIdentitySchema
  .extend({
    contentBase64: z
      .string()
      .max(Math.ceil((64 * 1024) / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    contentType: z.string().min(1).max(256),
    eof: z.boolean(),
    kind: z.literal("found"),
    nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offsetBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    returnedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((result, context) => {
    const padding = result.contentBase64.endsWith("==")
      ? 2
      : result.contentBase64.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (result.contentBase64.length / 4) * 3 - padding;
    if (decodedBytes !== result.returnedBytes) {
      context.addIssue({
        code: "custom",
        message: "contentBase64 length must match returnedBytes",
      });
    }
    if (result.nextOffset !== result.offsetBytes + result.returnedBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset must follow the returned byte range",
      });
    }
    if (
      result.nextOffset > result.totalBytes ||
      result.eof !== (result.nextOffset === result.totalBytes)
    ) {
      context.addIssue({ code: "custom", message: "eof must match the known total byte range" });
    }
  });

export const artifactReadResultSchema = z.union([
  artifactReadFoundSchema,
  artifactReadIdentitySchema.extend({
    kind: z.literal("not_found"),
    message: z.string().min(1).max(512),
  }),
  artifactReadIdentitySchema.extend({
    expiredAt: z.iso.datetime({ offset: true }),
    kind: z.literal("expired"),
    message: z.string().min(1).max(512),
  }),
  artifactReadIdentitySchema.extend({
    kind: z.literal("unavailable"),
    message: z.string().min(1).max(512),
    reason: z.enum(["durability_unavailable", "owner_route_unavailable"]),
    retryable: z.literal(true),
  }),
]);

const executionStatusTransportSchema = z.enum([
  "DISPATCHING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "UNKNOWN",
]);

export const executionWaitV2TransportRequestSchema = z.strictObject({
  executionId: executionIdTransportSchema,
  waitMs: z.number().int().min(0).max(30_000).default(10_000),
});

export const executionWaitV2ResultSchema = z
  .strictObject({
    completed: z.boolean(),
    executionId: executionIdTransportSchema,
    executionState: executionStatusTransportSchema,
  })
  .superRefine((result, context) => {
    const terminal = result.executionState !== "DISPATCHING" && result.executionState !== "RUNNING";
    if (result.completed !== terminal) {
      context.addIssue({
        code: "custom",
        message: "completed must describe Execution terminality, not success",
      });
    }
  });

const executionOutputCursorSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/);

export const executionOutputReadTransportRequestSchema = z.strictObject({
  cursor: executionOutputCursorSchema.optional(),
  executionId: executionIdTransportSchema,
  generation: sessionGenerationTransportSchema,
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024)
    .optional(),
  sessionId: sessionIdTransportSchema,
});

const executionOutputChunkSchema = z
  .strictObject({
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil((64 * 1024) / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .superRefine((chunk, context) => {
    const padding = chunk.contentBase64.endsWith("==")
      ? 2
      : chunk.contentBase64.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (chunk.contentBase64.length / 4) * 3 - padding;
    if (decodedBytes !== chunk.byteLength) {
      context.addIssue({
        code: "custom",
        message: "Execution output contentBase64 length must match byteLength",
      });
    }
  });

const executionOutputGapSchema = z.union([
  z.strictObject({
    kind: z.literal("event_retention"),
    minimumAvailableSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    eventSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(["artifact_expired", "artifact_missing"]),
    resumeCursor: executionOutputCursorSchema,
  }),
]);

export const executionOutputReadResultSchema = z
  .strictObject({
    chunks: z.array(executionOutputChunkSchema).max(1),
    encoding: z.literal("base64"),
    executionId: executionIdTransportSchema,
    executionState: executionStatusTransportSchema,
    gap: executionOutputGapSchema.nullable(),
    generation: sessionGenerationTransportSchema,
    hasMore: z.boolean(),
    nextCursor: executionOutputCursorSchema.optional(),
    persistenceLag: z.enum(["none", "possible"]),
    retention: z.strictObject({
      minimumAvailableSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      source: z.literal("durable"),
    }),
    sessionId: sessionIdTransportSchema,
    stream: z.literal("pty"),
  })
  .superRefine((result, context) => {
    const active = result.executionState === "DISPATCHING" || result.executionState === "RUNNING";
    if (active !== (result.persistenceLag === "possible")) {
      context.addIssue({
        code: "custom",
        message: "Execution state and durable persistence lag must agree",
      });
    }
    if (result.gap?.kind !== undefined && result.gap.kind !== "event_retention" && result.hasMore) {
      context.addIssue({
        code: "custom",
        message: "An Artifact gap cannot be represented as continuous hasMore output",
      });
    }
    if (
      (result.chunks.length > 0 || result.hasMore || result.gap?.kind === "event_retention") &&
      result.nextCursor === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Continuous durable output requires a next cursor",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 96 * 1024) {
      context.addIssue({ code: "custom", message: "Execution output response exceeds 96 KiB" });
    }
  });

export const executionObserveTransportRequestSchema = executionOutputReadTransportRequestSchema
  .extend({
    waitMs: z.number().int().min(0).max(30_000).default(10_000),
  })
  .strict();

const executionObservationNextActionSchema = z.enum([
  "continue_output",
  "wait_for_completion",
  "acknowledge_output_gap",
  "lookup_original_action",
]);

const executionObservationOutputSchema = z
  .strictObject({
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024),
    contentBase64: z
      .string()
      .max(Math.ceil((64 * 1024) / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    encoding: z.literal("base64"),
    hasMore: z.boolean(),
    retention: z.strictObject({
      minimumAvailableSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      source: z.literal("durable"),
    }),
    stream: z.literal("pty"),
    text: z
      .string()
      .max(32 * 1024)
      .optional(),
    textStatus: z.enum(["complete", "unaligned_utf8", "omitted_for_budget"]),
  })
  .superRefine((output, context) => {
    const padding = output.contentBase64.endsWith("==")
      ? 2
      : output.contentBase64.endsWith("=")
        ? 1
        : 0;
    const decodedBytes =
      output.contentBase64.length === 0 ? 0 : (output.contentBase64.length / 4) * 3 - padding;
    if (decodedBytes !== output.byteLength) {
      context.addIssue({
        code: "custom",
        message: "Execution observation base64 length must match byteLength",
      });
    }
    if (output.textStatus === "complete" && output.text === undefined) {
      context.addIssue({ code: "custom", message: "Complete readable text must be present" });
    }
    if (output.textStatus !== "complete" && output.text !== undefined) {
      context.addIssue({ code: "custom", message: "Incomplete readable text must be omitted" });
    }
    if (output.textStatus === "complete" && output.byteLength > 8 * 1024) {
      context.addIssue({ code: "custom", message: "Readable text source exceeds its byte budget" });
    }
    if (output.text !== undefined && new TextEncoder().encode(output.text).byteLength > 32 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Readable text exceeds its encoded byte budget",
      });
    }
  });

export const executionObserveResultSchema = z
  .strictObject({
    gap: executionOutputGapSchema.nullable(),
    identity: z.strictObject({
      executionId: executionIdTransportSchema,
      generation: sessionGenerationTransportSchema,
      sessionId: sessionIdTransportSchema,
    }),
    nextActions: z.array(executionObservationNextActionSchema).max(3),
    nextCursor: executionOutputCursorSchema.nullable(),
    output: executionObservationOutputSchema,
    state: z.strictObject({
      completed: z.boolean(),
      executionState: executionStatusTransportSchema,
      persistenceLag: z.enum(["none", "possible"]),
    }),
  })
  .superRefine((result, context) => {
    const active =
      result.state.executionState === "DISPATCHING" || result.state.executionState === "RUNNING";
    if (result.state.completed === active) {
      context.addIssue({
        code: "custom",
        message: "completed must describe Execution terminality, not success",
      });
    }
    if (active !== (result.state.persistenceLag === "possible")) {
      context.addIssue({
        code: "custom",
        message: "Execution state and durable persistence lag must agree",
      });
    }
    if (result.gap?.kind !== undefined && result.gap.kind !== "event_retention") {
      if (result.output.hasMore) {
        context.addIssue({
          code: "custom",
          message: "An Artifact gap cannot be represented as continuous hasMore output",
        });
      }
    }
    if (
      (result.output.byteLength > 0 ||
        result.output.hasMore ||
        result.gap?.kind === "event_retention") &&
      result.nextCursor === null
    ) {
      context.addIssue({ code: "custom", message: "Observed output requires a next cursor" });
    }
    const expectedActions: z.output<typeof executionObservationNextActionSchema>[] = [];
    if (result.output.hasMore) expectedActions.push("continue_output");
    if (!result.state.completed) expectedActions.push("wait_for_completion");
    if (result.gap !== null) expectedActions.push("acknowledge_output_gap");
    if (result.state.executionState === "UNKNOWN") {
      expectedActions.push("lookup_original_action");
    }
    if (
      result.nextActions.length !== expectedActions.length ||
      result.nextActions.some((action, index) => action !== expectedActions[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "nextActions must be derived from the concrete observation",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 96 * 1024) {
      context.addIssue({ code: "custom", message: "Execution observation exceeds 96 KiB" });
    }
  });

const actionLookupIdentitySchema = z.strictObject({
  generation: sessionGenerationTransportSchema,
  idempotencyKey: idempotencyKeyTransportSchema,
  sessionId: sessionIdTransportSchema,
});

export const actionLookupResultSchema = z.discriminatedUnion("kind", [
  actionLookupIdentitySchema.extend({
    acceptedAt: z.iso.datetime({ offset: true }),
    actionId: z.string().min(1).max(256),
    actionStatus: z.enum([
      "ACCEPTED",
      "DISPATCHING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "INTERRUPTED",
      "UNKNOWN",
      "CANCELLED",
      "DELIVERED",
      "REJECTED",
    ]),
    actionType: z.enum(["execute", "input", "secret_input", "control", "resize"]),
    executionId: executionIdTransportSchema.optional(),
    executionStatus: z
      .enum(["DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "UNKNOWN"])
      .optional(),
    kind: z.literal("found"),
  }),
  actionLookupIdentitySchema.extend({
    kind: z.literal("not_found"),
    mayStillBeInFlight: z.literal(true),
    message: z.string().min(1).max(512),
  }),
  actionLookupIdentitySchema.extend({
    expiredAt: z.iso.datetime({ offset: true }),
    kind: z.literal("expired"),
    message: z.string().min(1).max(512),
  }),
  actionLookupIdentitySchema.extend({
    kind: z.literal("unavailable"),
    message: z.string().min(1).max(512),
    reason: z.enum(["durability_unavailable", "owner_route_unavailable"]),
    retryable: z.literal(true),
  }),
]);

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
export type ActionLookupTransportRequest = z.output<typeof actionLookupTransportRequestSchema>;
export type ActionLookupResult = z.output<typeof actionLookupResultSchema>;
export type HistoryLookupTransportRequest = z.output<typeof historyLookupTransportRequestSchema>;
export type HistoryLookupResult = z.output<typeof historyLookupResultSchema>;
export type ArtifactReadTransportRequest = z.output<typeof artifactReadTransportRequestSchema>;
export type ArtifactReadResult = z.output<typeof artifactReadResultSchema>;
export type ExecutionOutputReadTransportRequest = z.output<
  typeof executionOutputReadTransportRequestSchema
>;
export type ExecutionOutputReadResult = z.output<typeof executionOutputReadResultSchema>;
export type ExecutionObserveTransportRequest = z.output<
  typeof executionObserveTransportRequestSchema
>;
export type ExecutionObserveResult = z.output<typeof executionObserveResultSchema>;
export type ExecutionWaitV2TransportRequest = z.output<
  typeof executionWaitV2TransportRequestSchema
>;
export type ExecutionWaitV2Result = z.output<typeof executionWaitV2ResultSchema>;
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
