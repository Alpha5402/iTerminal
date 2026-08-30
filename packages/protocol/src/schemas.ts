const actorProperties = {
  capabilities: {
    items: {
      enum: [
        "approval.decide",
        "approval.request",
        "interaction.guard.manage",
        "interaction.policy.manage",
        "secret.input",
        "session.execute",
        "session.fork",
        "terminal.control",
        "terminal.input",
        "terminal.resize",
      ],
    },
    minItems: 1,
    type: "array",
    uniqueItems: true,
  },
  client: { minLength: 1, type: "string" },
  id: { minLength: 1, type: "string" },
  principal: { minLength: 1, type: "string" },
  type: { enum: ["human", "agent", "scheduler", "system"] },
} as const;

export const executeRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: {
      additionalProperties: false,
      properties: actorProperties,
      required: ["id", "type", "principal", "client", "capabilities"],
      type: "object",
    },
    command: { type: "string" },
    idempotencyKey: { minLength: 1, type: "string" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
  },
  required: ["sessionId", "sessionGeneration", "actor", "command", "idempotencyKey"],
  type: "object",
} as const;

export const inputRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: executeRequestSchema.properties.actor,
    data: { type: "string" },
    expectedScreenVersion: { minimum: 0, type: "integer" },
    idempotencyKey: { minLength: 1, type: "string" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
    targetExecutionId: { minLength: 1, type: "string" },
  },
  required: [
    "sessionId",
    "sessionGeneration",
    "actor",
    "targetExecutionId",
    "data",
    "idempotencyKey",
  ],
  type: "object",
} as const;

export const beginSecretInputRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: executeRequestSchema.properties.actor,
    data: { maxLength: 64 * 1024, minLength: 1, type: "string" },
    expectedScreenVersion: { minimum: 0, type: "integer" },
    idempotencyKey: { minLength: 1, type: "string" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
    targetExecutionId: { minLength: 1, type: "string" },
  },
  required: [
    "sessionId",
    "sessionGeneration",
    "actor",
    "targetExecutionId",
    "data",
    "idempotencyKey",
  ],
  type: "object",
} as const;

export const finishSensitiveInputRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: executeRequestSchema.properties.actor,
    expectedVersion: { minimum: 1, type: "integer" },
    idempotencyKey: { minLength: 1, type: "string" },
    outcome: { enum: ["completed", "cancelled"] },
    sensitiveInputId: { minLength: 1, type: "string" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
  },
  required: [
    "sessionId",
    "sessionGeneration",
    "actor",
    "sensitiveInputId",
    "expectedVersion",
    "outcome",
    "idempotencyKey",
  ],
  type: "object",
} as const;

export const controlRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: executeRequestSchema.properties.actor,
    delivery: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            control: { enum: ["CTRL_C", "CTRL_D", "CTRL_Z", "ESC"] },
            mode: { const: "TTY_CONTROL" },
          },
          required: ["mode", "control"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            mode: { const: "PROCESS_SIGNAL" },
            signal: { enum: ["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGCONT"] },
          },
          required: ["mode", "signal"],
          type: "object",
        },
      ],
    },
    idempotencyKey: { minLength: 1, type: "string" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
    targetExecutionId: { minLength: 1, type: "string" },
  },
  required: [
    "sessionId",
    "sessionGeneration",
    "actor",
    "targetExecutionId",
    "delivery",
    "idempotencyKey",
  ],
  type: "object",
} as const;

export const resizeRequestSchema = {
  additionalProperties: false,
  properties: {
    actor: executeRequestSchema.properties.actor,
    columns: { maximum: 240, minimum: 40, type: "integer" },
    expectedGeometryVersion: { minimum: 1, type: "integer" },
    idempotencyKey: { minLength: 1, type: "string" },
    rows: { maximum: 100, minimum: 12, type: "integer" },
    sessionGeneration: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
  },
  required: [
    "sessionId",
    "sessionGeneration",
    "actor",
    "columns",
    "rows",
    "expectedGeometryVersion",
    "idempotencyKey",
  ],
  type: "object",
} as const;
