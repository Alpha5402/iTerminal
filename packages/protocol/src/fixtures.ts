/** Public request fixtures shared by protocol contract tests and adapters. */
export const protocolActorFixture = {
  id: "actor-a03",
  type: "agent",
  principal: "principal-a03",
  client: "client-a03",
  capabilities: ["session.execute", "terminal.input"],
} as const;

export const validExecuteRequestFixture = {
  sessionId: "session-a03",
  sessionGeneration: 1,
  actor: protocolActorFixture,
  command: "printf 'ok\\n'",
  idempotencyKey: "execute-a03",
} as const;

export const approvedExecuteRequestFixture = {
  ...validExecuteRequestFixture,
  approvalId: "approval-a03",
} as const;

export const validInputRequestFixture = {
  sessionId: "session-a03",
  sessionGeneration: 1,
  actor: protocolActorFixture,
  targetExecutionId: "execution-a03",
  data: "/status\n",
  idempotencyKey: "input-a03",
} as const;

export const lineInputRequestFixture = {
  ...validInputRequestFixture,
  lineInput: {
    expectedInputVersion: 0,
    expectedInteractionVersion: 1,
  },
} as const;

export const invalidProtocolFixtures = {
  unknownExecuteField: { ...validExecuteRequestFixture, unexpected: true },
  invalidApprovalId: { ...validExecuteRequestFixture, approvalId: 42 },
  unknownInputField: { ...validInputRequestFixture, unexpected: true },
  invalidLineInputVersion: {
    ...validInputRequestFixture,
    lineInput: { expectedInputVersion: -1, expectedInteractionVersion: 1 },
  },
  invalidGeneration: { ...validInputRequestFixture, sessionGeneration: 0 },
} as const;
