import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  AcquireInteractionGuardRequest,
  ActionLookupRequest,
  ActionLookupResult,
  ArtifactReadRequest,
  ArtifactReadResult,
  ExecutionObservationRequest,
  ExecutionObservationResult,
  ExecutionOutputReadRequest,
  ExecutionOutputReadResult,
  ExecutionWaitRequest,
  ExecutionWaitResult,
  ControlRequest,
  BeginSecretInputRequest,
  CreateSessionRequest,
  DecideApprovalRequest,
  ExecuteRequest,
  GetApprovalRequest,
  InputRequest,
  FinishSensitiveInputRequest,
  GetSensitiveInputRequest,
  HistoryLookupRequest,
  HistoryLookupResult,
  ForkSessionRequest,
  ListApprovalsRequest,
  RequestExecuteApprovalRequest,
  ReleaseInteractionGuardRequest,
  RenewInteractionGuardRequest,
  ResizeRequest,
  ScreenCellsRequest,
  ScreenDiffRequest,
  ScreenRegionRequest,
  ScreenSearchRequest,
  ScreenWaitRequest,
  SetInputPolicyRequest,
} from "@iterminal/application";
import type { RuntimeService } from "@iterminal/application";
import type {
  Actor,
  Approval,
  ControlAction,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  InteractionState,
  ResizeAction,
  SecretInputAction,
  SensitiveInput,
  Session,
  SessionForkResult,
  ShellCheckpointView,
  TerminalScreenCellsResult,
  TerminalConsoleFrame,
  ConsoleObservation,
  TerminalHistoryPage,
  SessionDiscoveryPage,
  SessionDiscoveryRequest,
  PendingApprovalsRequest,
  PendingApprovalsPage,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSearchResult,
  TerminalScreenSnapshot,
  TerminalScreenWaitResult,
  TerminalStateObservation,
} from "@iterminal/domain";
import {
  ACTOR_CAPABILITIES,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  RuntimeError,
  isCanonicalActorCapabilities,
} from "@iterminal/domain";
import { operationalErrorMessage } from "@iterminal/observability";
import {
  actionLookupResultSchema,
  actionLookupTransportRequestSchema,
  artifactReadResultSchema,
  artifactReadTransportRequestSchema,
  executionObserveResultSchema,
  executionObserveTransportRequestSchema,
  executionOutputReadResultSchema,
  executionOutputReadTransportRequestSchema,
  executionWaitV2ResultSchema,
  executionWaitV2TransportRequestSchema,
  eventPageTransportSchema,
  historyLookupResultSchema,
  historyLookupTransportRequestSchema,
  defineRuntimeCapabilities,
  executeTransportRequestSchema,
  inputTransportRequestSchema,
  runtimeCapabilitiesRequestSchema,
  runtimeCapabilitiesSchema,
  type RuntimeCapabilities,
  type RuntimeCapabilitiesRequest,
} from "@iterminal/protocol";
import * as z from "zod/v4";

import {
  authorizeRuntimeRpcGrant,
  currentRuntimeRpcGrantToken,
  runtimeRpcGrantToken,
  runWithVerifiedRuntimeRpcGrant,
  verifyRuntimeRpcGrant,
  type RuntimeRpcAuthentication,
  type VerifiedRuntimeRpcGrant,
} from "./auth.js";

export {
  DEFAULT_RUNTIME_RPC_AUDIENCE,
  authorizeRuntimeRpcGrant,
  parseRuntimeRpcSecret,
  parseDeclaredRuntimeRpcGrantClaims,
  runtimeRpcAuthenticationFromEnvironment,
  runtimeRpcAuthorizationFromEnvironment,
  signRuntimeRpcGrant,
  verifyRuntimeRpcGrant,
  type RuntimeRpcActorGrant,
  type RuntimeRpcAuthentication,
  type RuntimeRpcEnvironment,
  type RuntimeRpcGrantClaims,
  type VerifiedRuntimeRpcGrant,
} from "./auth.js";

export { readPrivateRuntimeRpcCredentialFile } from "./credential-file.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RPC_CONNECTIONS = 256;
const DEFAULT_RPC_REQUEST_READ_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WAIT_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const WAIT_V2_TRANSPORT_SETTLEMENT_MS = 5_000;
const runtimeErrorCodes = new Set<RuntimeError["code"]>([
  "SESSION_NOT_FOUND",
  "SESSION_NOT_READY",
  "SESSION_BROKEN",
  "SESSION_GENERATION_CHANGED",
  "PTY_BUSY",
  "EXECUTION_CHANGED",
  "SCREEN_CHANGED",
  "INPUT_CONTEXT_CHANGED",
  "INPUT_CONTEXT_UNSAFE",
  "GEOMETRY_CHANGED",
  "CHECKPOINT_NOT_FOUND",
  "CHECKPOINT_CHANGED",
  "CHECKPOINT_STALE",
  "CHECKPOINT_INVALID",
  "INPUT_GUARDED",
  "INTERACTION_GUARD_CHANGED",
  "POLICY_DENIED",
  "ACTOR_IDENTITY_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "DELIVERY_UNKNOWN",
  "BACKPRESSURE",
  "RATE_LIMITED",
  "OWNER_CONFLICT",
  "OWNER_LEASE_LOST",
  "OWNER_ROUTE_UNAVAILABLE",
  "SESSION_LEASE_LOST",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_CHANGED",
  "APPROVAL_REQUIRED",
  "SENSITIVE_INPUT_ACTIVE",
  "SENSITIVE_INPUT_CHANGED",
  "RUNTIME_UNAVAILABLE",
  "RESYNC_REQUIRED",
  "INVALID_REQUEST",
  "EXECUTION_NOT_FOUND",
]);

export function defaultRuntimeSocketPath(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : tmpdir();
  const user = typeof process.getuid === "function" ? process.getuid().toString() : "local";
  return join(base, `iterminal-${user}.sock`);
}

const actorSchema = z.strictObject({
  capabilities: z
    .array(z.enum(ACTOR_CAPABILITIES))
    .min(1)
    .max(ACTOR_CAPABILITIES.length)
    .refine(isCanonicalActorCapabilities, "Actor capabilities must be canonical"),
  client: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
  principal: z.string().min(1).max(256),
  type: z.enum(["human", "agent", "scheduler", "system"]),
});

const sessionIdentitySchema = z.strictObject({
  generation: z.number().int().positive(),
  sessionId: z.string().min(1).max(256),
});

const screenRectangleSchema = sessionIdentitySchema.extend({
  columnCount: z.number().int().min(1).max(MAX_TERMINAL_COLUMNS),
  rowCount: z.number().int().min(1).max(MAX_TERMINAL_ROWS),
  startColumn: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_COLUMNS - 1),
  startRow: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_ROWS - 1),
});

const operationSchemas = {
  "action.lookup": actionLookupTransportRequestSchema.extend({ actor: actorSchema }),
  "approval.decide": sessionIdentitySchema.extend({
    actor: actorSchema,
    approvalId: z.string().min(1).max(256),
    decision: z.enum(["approve", "deny"]),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(256),
    reason: z.string().min(1).max(512),
  }),
  "approval.get": sessionIdentitySchema.extend({
    actor: actorSchema,
    approvalId: z.string().min(1).max(256),
  }),
  "approval.list": sessionIdentitySchema.extend({
    actor: actorSchema,
    status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED", "CONSUMED"]).optional(),
  }),
  "approval.request": sessionIdentitySchema.extend({
    actionIdempotencyKey: z.string().min(1).max(256),
    actor: actorSchema,
    command: z
      .string()
      .min(1)
      .max(256 * 1024),
    reason: z.string().min(1).max(512),
    requestIdempotencyKey: z.string().min(1).max(256),
    ttlMilliseconds: z
      .number()
      .int()
      .min(30_000)
      .max(30 * 60 * 1_000)
      .optional(),
  }),
  "artifact.read": artifactReadTransportRequestSchema,
  "control.send": sessionIdentitySchema.extend({
    actor: actorSchema,
    bypassGuard: z.boolean().default(false),
    delivery: z.discriminatedUnion("mode", [
      z.strictObject({
        control: z.enum(["CTRL_C", "CTRL_D", "CTRL_Z", "ESC"]),
        mode: z.literal("TTY_CONTROL"),
      }),
      z.strictObject({
        mode: z.literal("PROCESS_SIGNAL"),
        signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGCONT"]),
      }),
    ]),
    idempotencyKey: z.string().min(1).max(256),
    targetExecutionId: z.string().min(1).max(256),
  }),
  "events.query": sessionIdentitySchema.extend({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  "execution.get": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "execution.observe": executionObserveTransportRequestSchema,
  "execution.output.read": executionOutputReadTransportRequestSchema,
  "execution.dispatch": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "execution.start": executeTransportRequestSchema.extend({
    actor: actorSchema,
  }),
  "execution.wait": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "execution.wait.v2": executionWaitV2TransportRequestSchema,
  "history.lookup": historyLookupTransportRequestSchema.extend({ actor: actorSchema }),
  "input.send": inputTransportRequestSchema.extend({
    actor: actorSchema,
  }),
  "secret.input.begin": sessionIdentitySchema.extend({
    actor: actorSchema,
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
    expectedScreenVersion: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(256),
    targetExecutionId: z.string().min(1).max(256),
  }),
  "secret.input.finish": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(256),
    outcome: z.enum(["completed", "cancelled"]),
    sensitiveInputId: z.string().min(1).max(256),
  }),
  "secret.input.get": sessionIdentitySchema.extend({ actor: actorSchema }),
  "interaction.get": sessionIdentitySchema,
  "interaction.guard.acquire": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(1).max(256),
    ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
  }),
  "interaction.guard.release": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    guardId: z.string().min(1).max(256),
  }),
  "interaction.guard.renew": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    guardId: z.string().min(1).max(256),
    ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
  }),
  "interaction.policy.set": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    mode: z.enum(["common", "human_guarded", "human_only", "agent_only"]),
  }),
  "terminal.resize": sessionIdentitySchema.extend({
    actor: actorSchema,
    columns: z.number().int().min(40).max(MAX_TERMINAL_COLUMNS),
    expectedGeometryVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(256),
    rows: z.number().int().min(12).max(MAX_TERMINAL_ROWS),
  }),
  "terminal.state.get": sessionIdentitySchema,
  "screen.cells": screenRectangleSchema,
  "screen.frame": sessionIdentitySchema,
  "console.observe": sessionIdentitySchema.extend({
    afterScreenVersion: z.number().int().nonnegative().optional(),
  }),
  "screen.history": sessionIdentitySchema.extend({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  "screen.diff": sessionIdentitySchema.extend({
    afterVersion: z.number().int().nonnegative(),
  }),
  "screen.get": sessionIdentitySchema,
  "screen.region": screenRectangleSchema,
  "screen.search": sessionIdentitySchema.extend({
    caseSensitive: z.boolean().default(false),
    maxMatches: z.number().int().min(1).max(100).default(20),
    query: z.string().min(1).max(1_024),
  }),
  "screen.wait": sessionIdentitySchema.extend({
    condition: z.discriminatedUnion("type", [
      z.strictObject({
        caseSensitive: z.boolean().default(false),
        text: z.string().min(1).max(1_024),
        type: z.literal("text"),
      }),
      z.strictObject({
        afterVersion: z.number().int().nonnegative(),
        type: z.literal("version"),
      }),
      z.strictObject({
        stableMilliseconds: z.number().int().min(50).max(30_000),
        type: z.literal("stable"),
      }),
      z.strictObject({
        executionId: z.string().min(1).max(256),
        type: z.literal("execution_exit"),
      }),
    ]),
    timeoutMilliseconds: z.number().int().min(1).max(300_000).default(30_000),
  }),
  "session.close": sessionIdentitySchema,
  "session.checkpoint.get": sessionIdentitySchema,
  "session.create": z.strictObject({
    idempotencyKey: z.string().min(1).max(256),
    shell: z.enum(["bash", "zsh"]),
    workspaceRoot: z.string().min(1).max(4096),
  }),
  "session.fork": sessionIdentitySchema.extend({
    actor: actorSchema,
    allowStale: z.boolean(),
    expectedCheckpointVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(256),
  }),
  "session.get": z.strictObject({ sessionId: z.string().min(1).max(256) }),
  "session.list": z.strictObject({}),
  "approval.pending.list": z.strictObject({
    actor: actorSchema,
    sessionId: z.string().min(1).max(256).optional(),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  "session.list.v2": z.strictObject({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  "runtime.capabilities": runtimeCapabilitiesRequestSchema,
} as const;

export type RuntimeOperation = keyof typeof operationSchemas;
export const RUNTIME_RPC_OPERATIONS = Object.freeze(
  (Object.keys(operationSchemas) as RuntimeOperation[]).sort(),
);
const runtimeRpcOperationSet = new Set(RUNTIME_RPC_OPERATIONS);

export interface StartedExecutionView {
  readonly action: ExecuteAction;
  readonly execution: Execution;
}

export interface RuntimeGateway {
  lookupAction(request: ActionLookupRequest): Promise<ActionLookupResult>;
  lookupHistory?(request: HistoryLookupRequest): Promise<HistoryLookupResult>;
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactReadResult>;
  observeExecution?(
    request: ExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionObservationResult>;
  readExecutionOutput(request: ExecutionOutputReadRequest): Promise<ExecutionOutputReadResult>;
  getRuntimeCapabilities?(request?: RuntimeCapabilitiesRequest): Promise<RuntimeCapabilities>;
  requestExecuteApproval(request: RequestExecuteApprovalRequest): Promise<Approval>;
  getApproval(request: GetApprovalRequest): Promise<Approval>;
  listApprovals(request: ListApprovalsRequest): Promise<readonly Approval[]>;
  decideApproval(request: DecideApprovalRequest): Promise<Approval>;
  createSession(request: CreateSessionRequest): Promise<Session>;
  getSessionCheckpoint(sessionId: string, generation: number): Promise<ShellCheckpointView>;
  forkSession(request: ForkSessionRequest): Promise<SessionForkResult>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<Session>;
  listPendingApprovals?(
    request: PendingApprovalsRequest,
    signal?: AbortSignal,
  ): Promise<PendingApprovalsPage>;
  listSessionsV2?(request?: SessionDiscoveryRequest): Promise<SessionDiscoveryPage>;
  listSessions(): Promise<readonly Session[]>;
  getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot>;
  getTerminalState(sessionId: string, generation: number): Promise<TerminalStateObservation>;
  getScreenHistory?(request: {
    sessionId: string;
    generation: number;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<TerminalHistoryPage>;
  observeConsole?(request: {
    sessionId: string;
    generation: number;
    afterScreenVersion?: number | undefined;
  }): Promise<ConsoleObservation>;
  getConsoleFrame?(sessionId: string, generation: number): Promise<TerminalConsoleFrame>;
  getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult>;
  getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult>;
  getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult>;
  searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult>;
  waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult>;
  startExecute(request: ExecuteRequest): Promise<StartedExecutionView>;
  dispatchExecution(executionId: string): Promise<StartedExecutionView>;
  getExecution(executionId: string): Promise<Execution>;
  waitExecution(executionId: string): Promise<Execution>;
  waitExecutionV2?(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult>;
  sendInput(request: InputRequest): Promise<InputAction>;
  beginSecretInput(request: BeginSecretInputRequest): Promise<SecretInputAction>;
  getSensitiveInput(request: GetSensitiveInputRequest): Promise<SensitiveInput | undefined>;
  finishSensitiveInput(request: FinishSensitiveInputRequest): Promise<SensitiveInput>;
  sendControl(request: ControlRequest): Promise<ControlAction>;
  resizeTerminal(request: ResizeRequest): Promise<ResizeAction>;
  getInteractionState(sessionId: string, generation: number): Promise<InteractionState>;
  setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState>;
  acquireInteractionGuard(request: AcquireInteractionGuardRequest): Promise<InteractionState>;
  renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState>;
  releaseInteractionGuard(request: ReleaseInteractionGuardRequest): Promise<InteractionState>;
  queryEvents(
    sessionId: string,
    generation: number,
    after?: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<EventPage>;
  closeSession(sessionId: string, generation: number): Promise<Session>;
}

export class LocalRuntimeGateway implements RuntimeGateway {
  readonly #capabilities: RuntimeCapabilities;

  public constructor(
    private readonly runtime: RuntimeService,
    options: Readonly<{
      readonly artifactRead?: boolean;
      readonly buildId?: string;
      readonly executionOutputRead?: boolean;
      readonly durableHistory?: boolean;
    }> = {},
  ) {
    this.#capabilities = defineRuntimeCapabilities({
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      features: [
        "action.execute.v1",
        "action.input.v1",
        "action.lookup.v1",
        "approval.pending.list.v1",
        "console.observe.v1",
        ...(options.artifactRead === true ? (["artifact.read.v1"] as const) : []),
        ...(options.executionOutputRead === true ? (["execution.observe.v1"] as const) : []),
        ...(options.executionOutputRead === true ? (["execution.output.read.v1"] as const) : []),
        "execution.wait.v2",
        ...(options.durableHistory === true ? (["history.lookup.v1"] as const) : []),
        "runtime.capabilities.v1",
        "screen.frame.v1",
        "screen.history.v1",
        "session.list.v2",
      ],
    });
  }

  public lookupAction(request: ActionLookupRequest): Promise<ActionLookupResult> {
    return this.runtime.lookupAction(request);
  }

  public lookupHistory(request: HistoryLookupRequest): Promise<HistoryLookupResult> {
    return this.runtime.lookupHistory(request);
  }

  public readArtifact(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    return this.runtime.readArtifact(request);
  }

  public observeExecution(
    request: ExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionObservationResult> {
    return this.runtime.observeExecution(request, signal);
  }

  public readExecutionOutput(
    request: ExecutionOutputReadRequest,
  ): Promise<ExecutionOutputReadResult> {
    return this.runtime.readExecutionOutput(request);
  }

  public getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  public requestExecuteApproval(request: RequestExecuteApprovalRequest): Promise<Approval> {
    return this.runtime.requestExecuteApproval(request);
  }

  public getApproval(request: GetApprovalRequest): Promise<Approval> {
    return this.runtime.getApproval(request);
  }

  public listApprovals(request: ListApprovalsRequest): Promise<readonly Approval[]> {
    return this.runtime.listApprovals(request);
  }

  public decideApproval(request: DecideApprovalRequest): Promise<Approval> {
    return this.runtime.decideApproval(request);
  }

  public createSession(request: CreateSessionRequest): Promise<Session> {
    return this.runtime.createSession(request);
  }

  public getSessionCheckpoint(sessionId: string, generation: number): Promise<ShellCheckpointView> {
    return Promise.resolve(this.runtime.getSessionCheckpoint(sessionId, generation));
  }

  public forkSession(request: ForkSessionRequest): Promise<SessionForkResult> {
    return this.runtime.forkSession(request);
  }

  public getSession(sessionId: string): Promise<Session> {
    return Promise.resolve(this.runtime.getSession(sessionId));
  }

  public listPendingApprovals(request: PendingApprovalsRequest): Promise<PendingApprovalsPage> {
    return Promise.resolve(this.runtime.listPendingApprovals(request));
  }

  public listSessionsV2(request: SessionDiscoveryRequest = {}): Promise<SessionDiscoveryPage> {
    return Promise.resolve(this.runtime.listSessionsV2(request));
  }

  public listSessions(): Promise<readonly Session[]> {
    return Promise.resolve(this.runtime.listSessions());
  }

  public getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    return this.runtime.getScreen(sessionId, generation);
  }

  public getTerminalState(
    sessionId: string,
    generation: number,
  ): Promise<TerminalStateObservation> {
    return this.runtime.getTerminalState(sessionId, generation);
  }

  public getScreenHistory(request: {
    sessionId: string;
    generation: number;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<TerminalHistoryPage> {
    return this.runtime.getScreenHistory(request);
  }

  public observeConsole(request: {
    sessionId: string;
    generation: number;
    afterScreenVersion?: number | undefined;
  }): Promise<ConsoleObservation> {
    return this.runtime.observeConsole(request);
  }

  public getConsoleFrame(sessionId: string, generation: number): Promise<TerminalConsoleFrame> {
    return this.runtime.getConsoleFrame(sessionId, generation);
  }

  public getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    return this.runtime.getScreenCells(request);
  }

  public getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    return this.runtime.getScreenDiff(request);
  }

  public getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    return this.runtime.getScreenRegion(request);
  }

  public searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    return this.runtime.searchScreen(request);
  }

  public waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult> {
    return this.runtime.waitForScreen(request, signal);
  }

  public async startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    const started = await this.runtime.startExecute(request);
    return Promise.resolve({ action: started.action, execution: started.execution });
  }

  public async dispatchExecution(executionId: string): Promise<StartedExecutionView> {
    const started = await this.runtime.dispatchExecution(executionId);
    return { action: started.action, execution: started.execution };
  }

  public getExecution(executionId: string): Promise<Execution> {
    return Promise.resolve(this.runtime.getExecution(executionId));
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.runtime.waitExecution(executionId);
  }

  public waitExecutionV2(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult> {
    return this.runtime.waitExecutionV2(request, signal);
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.runtime.sendInput(request);
  }

  public beginSecretInput(request: BeginSecretInputRequest): Promise<SecretInputAction> {
    return this.runtime.beginSecretInput(request);
  }

  public getSensitiveInput(request: GetSensitiveInputRequest): Promise<SensitiveInput | undefined> {
    return Promise.resolve(this.runtime.getSensitiveInput(request));
  }

  public finishSensitiveInput(request: FinishSensitiveInputRequest): Promise<SensitiveInput> {
    return this.runtime.finishSensitiveInput(request);
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.runtime.sendControl(request);
  }

  public resizeTerminal(request: ResizeRequest): Promise<ResizeAction> {
    return this.runtime.resizeTerminal(request);
  }

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.runtime.getInteractionState(sessionId, generation);
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.runtime.setInputPolicy(request);
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.runtime.acquireInteractionGuard(request);
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.runtime.renewInteractionGuard(request);
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.runtime.releaseInteractionGuard(request);
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
  ): Promise<EventPage> {
    return this.runtime.queryEvents(sessionId, generation, after, limit);
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.runtime.closeSession(sessionId, generation);
  }
}

interface RpcRequest {
  readonly authorization?: string;
  readonly id: string;
  readonly operation: RuntimeOperation;
  readonly input: unknown;
}

type RpcResponse =
  | Readonly<{ id: string; ok: true; result: unknown }>
  | Readonly<{
      id: string;
      ok: false;
      error: Readonly<{
        code: string;
        details: Readonly<Record<string, unknown>>;
        message: string;
        retryable: boolean;
      }>;
    }>;

export interface RuntimeRpcServerHandle {
  readonly socketPath: string;
  close(): Promise<void>;
  drain?(timeoutMilliseconds: number): Promise<boolean>;
}

export interface RuntimeRpcResourceLimits {
  readonly maxConnections: number;
  readonly requestReadTimeoutMilliseconds: number;
}

export async function startRuntimeRpcServer(options: {
  readonly authentication?: RuntimeRpcAuthentication;
  readonly socketPath: string;
  readonly gateway: RuntimeGateway;
  readonly isReady?: () => boolean;
  readonly resourceLimits?: Partial<RuntimeRpcResourceLimits>;
}): Promise<RuntimeRpcServerHandle> {
  const limits = runtimeRpcResourceLimits(options.resourceLimits);
  await prepareSocketPath(options.socketPath);
  const activeSockets = new Set<Socket>();
  const activeResponses = new Set<Promise<void>>();
  const server = createServer((socket) => {
    if (activeSockets.size >= limits.maxConnections) {
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    handleSocket(
      socket,
      options.gateway,
      options.isReady,
      options.authentication,
      activeResponses,
      limits.requestReadTimeoutMilliseconds,
    );
  });
  const previousUmask = process.umask(0o177);
  try {
    await listen(server, options.socketPath);
  } finally {
    process.umask(previousUmask);
  }
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await closeServer(server, activeSockets, activeResponses).catch(() => undefined);
    await unlink(options.socketPath).catch(() => undefined);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  let drainPromise: Promise<boolean> | undefined;
  const removeSocketPath = async (): Promise<void> => {
    await unlink(options.socketPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    });
  };
  return {
    socketPath: options.socketPath,
    close: () => {
      closePromise ??= (async () => {
        if (drainPromise !== undefined) {
          await drainPromise;
          return;
        }
        await closeServer(server, activeSockets, activeResponses);
        await removeSocketPath();
      })();
      return closePromise;
    },
    drain: (timeoutMilliseconds) => {
      if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
        return Promise.reject(
          new RuntimeError("INVALID_REQUEST", "RPC drain timeout must be a positive integer", {
            timeoutMilliseconds,
          }),
        );
      }
      drainPromise ??= (async () => {
        if (closePromise !== undefined) {
          await closePromise;
          return false;
        }
        const drained = await drainServer(
          server,
          activeSockets,
          activeResponses,
          timeoutMilliseconds,
        );
        await removeSocketPath();
        return drained;
      })();
      return drainPromise;
    },
  };
}

export class UnixRuntimeClient implements RuntimeGateway {
  readonly #authorization: string | undefined;
  readonly #authorizationProvider: (() => Promise<string>) | undefined;
  readonly #socketPath: string;

  public constructor(
    socketPath: string,
    options: Readonly<{
      readonly authorization?: string;
      readonly authorizationProvider?: () => Promise<string>;
    }> = {},
  ) {
    if (options.authorization !== undefined && options.authorizationProvider !== undefined) {
      throw new RuntimeError("INVALID_REQUEST", "Choose one Runtime RPC credential source");
    }
    if (options.authorization !== undefined && options.authorization.length === 0) {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC authorization cannot be empty");
    }
    this.#authorization = options.authorization;
    this.#authorizationProvider = options.authorizationProvider;
    this.#socketPath = socketPath;
  }

  public async lookupAction(request: ActionLookupRequest): Promise<ActionLookupResult> {
    return actionLookupResultSchema.parse(
      await this.#request("action.lookup", {
        actor: request.actor,
        generation: request.generation,
        idempotencyKey: request.idempotencyKey,
        sessionId: request.sessionId,
      }),
    );
  }

  public async lookupHistory(request: HistoryLookupRequest): Promise<HistoryLookupResult> {
    return historyLookupResultSchema.parse(
      await this.#request("history.lookup", {
        actor: request.actor,
        generation: request.generation,
        sessionId: request.sessionId,
        target: request.target,
      }),
    );
  }

  public async readArtifact(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    return artifactReadResultSchema.parse(
      await this.#request("artifact.read", {
        artifactId: request.artifactId,
        generation: request.generation,
        ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        offsetBytes: request.offsetBytes,
        sessionId: request.sessionId,
      }),
    );
  }

  public async readExecutionOutput(
    request: ExecutionOutputReadRequest,
  ): Promise<ExecutionOutputReadResult> {
    const { nextCursor, ...result } = executionOutputReadResultSchema.parse(
      await this.#request("execution.output.read", {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        executionId: request.executionId,
        generation: request.generation,
        ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        sessionId: request.sessionId,
      }),
    );
    return {
      ...result,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  public async observeExecution(
    request: ExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionObservationResult> {
    const parsed = executionObserveTransportRequestSchema.parse(request);
    return executionObserveResultSchema.parse(
      await this.#request(
        "execution.observe",
        parsed,
        parsed.waitMs + WAIT_V2_TRANSPORT_SETTLEMENT_MS,
        signal,
      ),
    );
  }

  public requestExecuteApproval(request: RequestExecuteApprovalRequest): Promise<Approval> {
    return this.#request("approval.request", {
      actionIdempotencyKey: request.actionIdempotencyKey,
      actor: request.actor,
      command: request.command,
      generation: request.sessionGeneration,
      reason: request.reason,
      requestIdempotencyKey: request.requestIdempotencyKey,
      sessionId: request.sessionId,
      ...(request.ttlMilliseconds === undefined
        ? {}
        : { ttlMilliseconds: request.ttlMilliseconds }),
    });
  }

  public async getRuntimeCapabilities(
    request: RuntimeCapabilitiesRequest = {},
  ): Promise<RuntimeCapabilities> {
    return runtimeCapabilitiesSchema.parse(await this.#request("runtime.capabilities", request));
  }

  public getApproval(request: GetApprovalRequest): Promise<Approval> {
    return this.#request("approval.get", {
      actor: request.actor,
      approvalId: request.approvalId,
      generation: request.sessionGeneration,
      sessionId: request.sessionId,
    });
  }

  public listApprovals(request: ListApprovalsRequest): Promise<readonly Approval[]> {
    return this.#request("approval.list", {
      actor: request.actor,
      generation: request.sessionGeneration,
      sessionId: request.sessionId,
      ...(request.status === undefined ? {} : { status: request.status }),
    });
  }

  public decideApproval(request: DecideApprovalRequest): Promise<Approval> {
    return this.#request("approval.decide", {
      actor: request.actor,
      approvalId: request.approvalId,
      decision: request.decision,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      sessionId: request.sessionId,
    });
  }

  public createSession(request: CreateSessionRequest): Promise<Session> {
    const idempotencyKey = request.idempotencyKey ?? `session_create_${randomUUID()}`;
    return this.#request("session.create", {
      idempotencyKey,
      shell: request.shell,
      workspaceRoot: request.workspaceRoot,
    });
  }

  public getSessionCheckpoint(sessionId: string, generation: number): Promise<ShellCheckpointView> {
    return this.#request("session.checkpoint.get", { generation, sessionId });
  }

  public forkSession(request: ForkSessionRequest): Promise<SessionForkResult> {
    return this.#request("session.fork", {
      actor: request.actor,
      allowStale: request.allowStale,
      expectedCheckpointVersion: request.expectedCheckpointVersion,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
    });
  }

  public getSession(sessionId: string, signal?: AbortSignal): Promise<Session> {
    return this.#request("session.get", { sessionId }, DEFAULT_REQUEST_TIMEOUT_MS, signal);
  }

  public listPendingApprovals(
    request: PendingApprovalsRequest,
    signal?: AbortSignal,
  ): Promise<PendingApprovalsPage> {
    return this.#request("approval.pending.list", request, DEFAULT_REQUEST_TIMEOUT_MS, signal);
  }

  public listSessionsV2(request: SessionDiscoveryRequest = {}): Promise<SessionDiscoveryPage> {
    return this.#request("session.list.v2", request);
  }

  public listSessions(): Promise<readonly Session[]> {
    return this.#request("session.list", {});
  }

  public getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    return this.#request("screen.get", { generation, sessionId });
  }

  public getTerminalState(
    sessionId: string,
    generation: number,
  ): Promise<TerminalStateObservation> {
    return this.#request("terminal.state.get", { generation, sessionId });
  }

  public getScreenHistory(request: {
    sessionId: string;
    generation: number;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<TerminalHistoryPage> {
    return this.#request("screen.history", request);
  }

  public observeConsole(request: {
    sessionId: string;
    generation: number;
    afterScreenVersion?: number | undefined;
  }): Promise<ConsoleObservation> {
    return this.#request("console.observe", request);
  }

  public getConsoleFrame(sessionId: string, generation: number): Promise<TerminalConsoleFrame> {
    return this.#request("screen.frame", { generation, sessionId });
  }

  public getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    return this.#request("screen.cells", request);
  }

  public getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    return this.#request("screen.diff", request);
  }

  public getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    return this.#request("screen.region", request);
  }

  public searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    return this.#request("screen.search", request);
  }

  public waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult> {
    return this.#request("screen.wait", request, WAIT_REQUEST_TIMEOUT_MS, signal);
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    return this.#request("execution.start", {
      actor: request.actor,
      command: request.command,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
    });
  }

  public dispatchExecution(executionId: string): Promise<StartedExecutionView> {
    return this.#request("execution.dispatch", { executionId });
  }

  public getExecution(executionId: string): Promise<Execution> {
    return this.#request("execution.get", { executionId });
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.#request("execution.wait", { executionId }, WAIT_REQUEST_TIMEOUT_MS);
  }

  public async waitExecutionV2(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult> {
    const parsed = executionWaitV2TransportRequestSchema.parse(request);
    return executionWaitV2ResultSchema.parse(
      await this.#request(
        "execution.wait.v2",
        parsed,
        parsed.waitMs + WAIT_V2_TRANSPORT_SETTLEMENT_MS,
        signal,
      ),
    );
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#request("input.send", {
      actor: request.actor,
      data: request.data,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
      ...(request.lineInput === undefined ? {} : { lineInput: request.lineInput }),
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    });
  }

  public beginSecretInput(request: BeginSecretInputRequest): Promise<SecretInputAction> {
    return this.#request("secret.input.begin", {
      actor: request.actor,
      data: request.data,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    });
  }

  public getSensitiveInput(request: GetSensitiveInputRequest): Promise<SensitiveInput | undefined> {
    return this.#request("secret.input.get", {
      actor: request.actor,
      generation: request.sessionGeneration,
      sessionId: request.sessionId,
    });
  }

  public finishSensitiveInput(request: FinishSensitiveInputRequest): Promise<SensitiveInput> {
    return this.#request("secret.input.finish", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      outcome: request.outcome,
      sensitiveInputId: request.sensitiveInputId,
      sessionId: request.sessionId,
    });
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.#request("control.send", {
      actor: request.actor,
      bypassGuard: request.bypassGuard ?? false,
      delivery: request.delivery,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
    });
  }

  public resizeTerminal(request: ResizeRequest): Promise<ResizeAction> {
    return this.#request("terminal.resize", {
      actor: request.actor,
      columns: request.columns,
      expectedGeometryVersion: request.expectedGeometryVersion,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      rows: request.rows,
      sessionId: request.sessionId,
    });
  }

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.#request("interaction.get", { generation, sessionId });
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.#request("interaction.policy.set", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      mode: request.mode,
      sessionId: request.sessionId,
    });
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#request("interaction.guard.acquire", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      reason: request.reason,
      sessionId: request.sessionId,
      ...(request.ttlMilliseconds === undefined
        ? {}
        : { ttlMilliseconds: request.ttlMilliseconds }),
    });
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.#request("interaction.guard.renew", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      guardId: request.guardId,
      sessionId: request.sessionId,
      ...(request.ttlMilliseconds === undefined
        ? {}
        : { ttlMilliseconds: request.ttlMilliseconds }),
    });
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#request("interaction.guard.release", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      guardId: request.guardId,
      sessionId: request.sessionId,
    });
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<EventPage> {
    return this.#request(
      "events.query",
      { after, generation, limit, sessionId },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    ).then((result) => eventPageTransportSchema.parse(result) as EventPage);
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.#request("session.close", { generation, sessionId });
  }

  async #request<T>(
    operation: RuntimeOperation,
    input: unknown,
    timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = `rpc_${randomUUID()}`;
    const authorization =
      this.#authorizationProvider === undefined
        ? (this.#authorization ?? currentRuntimeRpcGrantToken())
        : await this.#authorizationProvider();
    if (this.#authorizationProvider !== undefined && !authorization) {
      throw new RuntimeError("POLICY_DENIED", "Runtime RPC credential source returned no grant");
    }
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        fail(new Error("Runtime RPC request timed out"));
      }, timeoutMilliseconds);
      const onAbort = (): void => {
        socket.destroy();
        fail(signal?.reason ?? new Error("Runtime RPC request aborted"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(connectionError(operation, id, error));
      };
      socket.setEncoding("utf8");
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            ...(authorization === undefined ? {} : { authorization }),
            id,
            input,
            operation,
          })}\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
          fail(new Error("Runtime RPC response exceeded the size limit"));
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0 || settled) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
          if (response.id !== id) throw new Error("Runtime RPC response ID mismatch");
          settled = true;
          cleanup();
          socket.end();
          if (response.ok) {
            resolve(response.result as T);
          } else {
            reject(runtimeErrorFromResponse(response.error, authorization));
          }
        } catch (error) {
          fail(error);
          socket.destroy();
        }
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error("Runtime RPC connection closed before a response"));
      });
    });
  }
}

function handleSocket(
  socket: Socket,
  gateway: RuntimeGateway,
  isReady: (() => boolean) | undefined,
  authentication: RuntimeRpcAuthentication | undefined,
  activeResponses: Set<Promise<void>>,
  requestReadTimeoutMilliseconds: number,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  const requestTimer = setTimeout(() => socket.destroy(), requestReadTimeoutMilliseconds);
  requestTimer.unref();
  socket.once("close", () => clearTimeout(requestTimer));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    clearTimeout(requestTimer);
    const line = buffer.slice(0, newline);
    buffer = "";
    socket.pause();
    const response = respond(socket, line, gateway, isReady, authentication);
    activeResponses.add(response);
    void response.then(
      () => activeResponses.delete(response),
      () => activeResponses.delete(response),
    );
  });
}

function runtimeRpcResourceLimits(
  configured: Partial<RuntimeRpcResourceLimits> | undefined,
): RuntimeRpcResourceLimits {
  const limits = {
    maxConnections: configured?.maxConnections ?? DEFAULT_MAX_RPC_CONNECTIONS,
    requestReadTimeoutMilliseconds:
      configured?.requestReadTimeoutMilliseconds ?? DEFAULT_RPC_REQUEST_READ_TIMEOUT_MS,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

async function respond(
  socket: Socket,
  line: string,
  gateway: RuntimeGateway,
  isReady: (() => boolean) | undefined,
  authentication: RuntimeRpcAuthentication | undefined,
): Promise<void> {
  let id = "unassigned";
  let grant: VerifiedRuntimeRpcGrant | undefined;
  const abortController = new AbortController();
  const onSocketClose = (): void => abortController.abort();
  socket.once("close", onSocketClose);
  try {
    const candidate: unknown = JSON.parse(line);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC request must be an object");
    }
    const parsed = candidate as Partial<RpcRequest>;
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.id !== "string" || parsed.id.length === 0 || parsed.id.length > 256) {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC request ID is invalid");
    }
    if (
      typeof parsed.operation !== "string" ||
      !Object.hasOwn(operationSchemas, parsed.operation)
    ) {
      throw new RuntimeError("INVALID_REQUEST", "Unsupported Runtime RPC operation");
    }
    const operation = parsed.operation;
    grant =
      authentication === undefined
        ? undefined
        : verifyRuntimeRpcGrant(
            typeof parsed.authorization === "string" ? parsed.authorization : "",
            authentication,
            runtimeRpcOperationSet,
          );
    if (parsed.authorization !== undefined && typeof parsed.authorization !== "string") {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC authorization is invalid");
    }
    if (isReady !== undefined && !isReady()) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Runtime daemon is still initializing",
        {},
        true,
      );
    }
    const input = operationSchemas[operation].parse(parsed.input);
    if (grant !== undefined) authorizeRuntimeRpcGrant(grant, operation, inputActor(input));
    const invoke = () => dispatch(gateway, operation, input, abortController.signal);
    const result =
      grant === undefined ? await invoke() : await runWithVerifiedRuntimeRpcGrant(grant, invoke);
    writeResponse(socket, { id, ok: true, result });
  } catch (error) {
    const runtimeError = credentialSafeRuntimeError(normalizeError(error), grant);
    writeResponse(socket, {
      error: {
        code: runtimeError.code,
        details: runtimeError.details,
        message: runtimeError.message,
        retryable: runtimeError.retryable,
      },
      id,
      ok: false,
    });
  } finally {
    socket.off("close", onSocketClose);
  }
}

function inputActor(input: unknown): Actor | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const actor = (input as Readonly<{ actor?: unknown }>).actor;
  return actor === undefined ? undefined : (actor as Actor);
}

async function dispatch(
  gateway: RuntimeGateway,
  operation: RuntimeOperation,
  input: z.output<(typeof operationSchemas)[RuntimeOperation]>,
  signal: AbortSignal,
): Promise<unknown> {
  switch (operation) {
    case "action.lookup": {
      const request = operationSchemas[operation].parse(input);
      return actionLookupResultSchema.parse(
        await gateway.lookupAction({
          actor: request.actor,
          generation: request.generation,
          idempotencyKey: request.idempotencyKey,
          sessionId: request.sessionId,
        }),
      );
    }
    case "artifact.read": {
      const request = operationSchemas[operation].parse(input);
      return artifactReadResultSchema.parse(
        await gateway.readArtifact({
          artifactId: request.artifactId,
          generation: request.generation,
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
          offsetBytes: request.offsetBytes,
          sessionId: request.sessionId,
        }),
      );
    }
    case "execution.output.read": {
      const request = operationSchemas[operation].parse(input);
      return executionOutputReadResultSchema.parse(
        await gateway.readExecutionOutput({
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          executionId: request.executionId,
          generation: request.generation,
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
          sessionId: request.sessionId,
        }),
      );
    }
    case "execution.observe": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.observeExecution === undefined) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Compact Execution observation is not supported by this service",
        );
      }
      return executionObserveResultSchema.parse(
        await gateway.observeExecution(
          {
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            executionId: request.executionId,
            generation: request.generation,
            ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
            sessionId: request.sessionId,
            waitMs: request.waitMs,
          },
          signal,
        ),
      );
    }
    case "runtime.capabilities": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.getRuntimeCapabilities === undefined) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Runtime capability negotiation is not supported by this service",
        );
      }
      return runtimeCapabilitiesSchema.parse(await gateway.getRuntimeCapabilities(request));
    }
    case "approval.request": {
      const request = operationSchemas[operation].parse(input);
      return gateway.requestExecuteApproval({
        actionIdempotencyKey: request.actionIdempotencyKey,
        actor: request.actor,
        command: request.command,
        reason: request.reason,
        requestIdempotencyKey: request.requestIdempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.ttlMilliseconds === undefined
          ? {}
          : { ttlMilliseconds: request.ttlMilliseconds }),
      });
    }
    case "approval.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getApproval({
        actor: request.actor,
        approvalId: request.approvalId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "approval.list": {
      const request = operationSchemas[operation].parse(input);
      return gateway.listApprovals({
        actor: request.actor,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.status === undefined ? {} : { status: request.status }),
      });
    }
    case "approval.decide": {
      const request = operationSchemas[operation].parse(input);
      return gateway.decideApproval({
        actor: request.actor,
        approvalId: request.approvalId,
        decision: request.decision,
        expectedVersion: request.expectedVersion,
        idempotencyKey: request.idempotencyKey,
        reason: request.reason,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "session.create": {
      const request = operationSchemas[operation].parse(input);
      return gateway.createSession({
        idempotencyKey: request.idempotencyKey,
        shell: request.shell,
        workspaceRoot: request.workspaceRoot,
      });
    }
    case "session.checkpoint.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getSessionCheckpoint(request.sessionId, request.generation);
    }
    case "session.fork": {
      const request = operationSchemas[operation].parse(input);
      return gateway.forkSession({
        actor: request.actor,
        allowStale: request.allowStale,
        expectedCheckpointVersion: request.expectedCheckpointVersion,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "session.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getSession(request.sessionId, signal);
    }
    case "approval.pending.list": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.listPendingApprovals === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Pending Approval inbox is unavailable");
      return gateway.listPendingApprovals(request, signal);
    }
    case "session.list.v2": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.listSessionsV2 === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Session discovery v2 is unavailable");
      return gateway.listSessionsV2(request);
    }
    case "session.list":
      return gateway.listSessions();
    case "session.close": {
      const request = operationSchemas[operation].parse(input);
      return gateway.closeSession(request.sessionId, request.generation);
    }
    case "execution.start": {
      const request = operationSchemas[operation].parse(input);
      return gateway.startExecute({
        actor: request.actor,
        command: request.command,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
      });
    }
    case "execution.dispatch": {
      const request = operationSchemas[operation].parse(input);
      return gateway.dispatchExecution(request.executionId);
    }
    case "execution.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getExecution(request.executionId);
    }
    case "execution.wait": {
      const request = operationSchemas[operation].parse(input);
      return gateway.waitExecution(request.executionId);
    }
    case "execution.wait.v2": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.waitExecutionV2 === undefined) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Bounded Execution wait is not supported by this service",
        );
      }
      return executionWaitV2ResultSchema.parse(await gateway.waitExecutionV2(request, signal));
    }
    case "history.lookup": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.lookupHistory === undefined) {
        throw new RuntimeError("INVALID_REQUEST", "Durable history lookup is not supported");
      }
      return historyLookupResultSchema.parse(await gateway.lookupHistory(request));
    }
    case "input.send": {
      const request = operationSchemas[operation].parse(input);
      return gateway.sendInput({
        actor: request.actor,
        data: request.data,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
        ...(request.lineInput === undefined ? {} : { lineInput: request.lineInput }),
        ...(request.expectedScreenVersion === undefined
          ? {}
          : { expectedScreenVersion: request.expectedScreenVersion }),
      });
    }
    case "secret.input.begin": {
      const request = operationSchemas[operation].parse(input);
      return gateway.beginSecretInput({
        actor: request.actor,
        data: request.data,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
        ...(request.expectedScreenVersion === undefined
          ? {}
          : { expectedScreenVersion: request.expectedScreenVersion }),
      });
    }
    case "secret.input.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getSensitiveInput({
        actor: request.actor,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "secret.input.finish": {
      const request = operationSchemas[operation].parse(input);
      return gateway.finishSensitiveInput({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        idempotencyKey: request.idempotencyKey,
        outcome: request.outcome,
        sensitiveInputId: request.sensitiveInputId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "control.send": {
      const request = operationSchemas[operation].parse(input);
      return gateway.sendControl({
        actor: request.actor,
        bypassGuard: request.bypassGuard,
        delivery: request.delivery,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
      });
    }
    case "terminal.resize": {
      const request = operationSchemas[operation].parse(input);
      return gateway.resizeTerminal({
        actor: request.actor,
        columns: request.columns,
        expectedGeometryVersion: request.expectedGeometryVersion,
        idempotencyKey: request.idempotencyKey,
        rows: request.rows,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "interaction.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getInteractionState(request.sessionId, request.generation);
    }
    case "interaction.policy.set": {
      const request = operationSchemas[operation].parse(input);
      return gateway.setInputPolicy({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        mode: request.mode,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "interaction.guard.acquire": {
      const request = operationSchemas[operation].parse(input);
      return gateway.acquireInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        reason: request.reason,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.ttlMilliseconds === undefined
          ? {}
          : { ttlMilliseconds: request.ttlMilliseconds }),
      });
    }
    case "interaction.guard.renew": {
      const request = operationSchemas[operation].parse(input);
      return gateway.renewInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        guardId: request.guardId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.ttlMilliseconds === undefined
          ? {}
          : { ttlMilliseconds: request.ttlMilliseconds }),
      });
    }
    case "interaction.guard.release": {
      const request = operationSchemas[operation].parse(input);
      return gateway.releaseInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        guardId: request.guardId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "events.query": {
      const request = operationSchemas[operation].parse(input);
      return eventPageTransportSchema.parse(
        await gateway.queryEvents(
          request.sessionId,
          request.generation,
          request.after,
          request.limit,
          signal,
        ),
      );
    }
    case "screen.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreen(request.sessionId, request.generation);
    }
    case "terminal.state.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getTerminalState(request.sessionId, request.generation);
    }
    case "screen.history": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.getScreenHistory === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Screen history is unavailable");
      return gateway.getScreenHistory(request);
    }
    case "console.observe": {
      const request = operationSchemas[operation].parse(input);
      if (!gateway.observeConsole)
        throw new RuntimeError("INVALID_REQUEST", "Console observation is unavailable");
      return gateway.observeConsole(request);
    }
    case "screen.frame": {
      const request = operationSchemas[operation].parse(input);
      if (gateway.getConsoleFrame === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Canonical Console cells are unavailable");
      return gateway.getConsoleFrame(request.sessionId, request.generation);
    }
    case "screen.cells": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenCells(request);
    }
    case "screen.diff": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenDiff(request);
    }
    case "screen.region": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenRegion(request);
    }
    case "screen.search": {
      const request = operationSchemas[operation].parse(input);
      return gateway.searchScreen({
        caseSensitive: request.caseSensitive,
        generation: request.generation,
        maxMatches: request.maxMatches,
        query: request.query,
        sessionId: request.sessionId,
      });
    }
    case "screen.wait": {
      const request = operationSchemas[operation].parse(input);
      return gateway.waitForScreen(
        {
          condition: request.condition,
          generation: request.generation,
          sessionId: request.sessionId,
          timeoutMilliseconds: request.timeoutMilliseconds,
        },
        signal,
      );
    }
  }
}

function writeResponse(socket: Socket, response: RpcResponse): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const status = await lstat(socketPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (status === undefined) return;
  if (!status.isSocket()) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime socket path exists and is not a socket", {
      socketPath,
    });
  }
  const live = await canConnect(socketPath);
  if (live) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime daemon is already listening", {
      socketPath,
    });
  }
  await unlink(socketPath);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(
  server: Server,
  activeSockets: ReadonlySet<Socket>,
  activeResponses: ReadonlySet<Promise<void>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    for (const socket of activeSockets) socket.destroy();
  });
  await Promise.allSettled([...activeResponses]);
}

async function drainServer(
  server: Server,
  activeSockets: ReadonlySet<Socket>,
  activeResponses: ReadonlySet<Promise<void>>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  const drained = await Promise.race([
    serverClosed.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMilliseconds);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!drained) {
    for (const socket of activeSockets) socket.destroy();
    await serverClosed;
  }
  await Promise.allSettled([...activeResponses]);
  return drained;
}

function normalizeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof z.ZodError) {
    return new RuntimeError("INVALID_REQUEST", "Runtime RPC request input is invalid");
  }
  return internalRuntimeRpcError();
}

function connectionError(
  operation: RuntimeOperation,
  requestId: string,
  error: unknown,
): RuntimeError {
  const details = {
    operation,
    requestId,
    reason: operationalErrorMessage(error, "Runtime RPC transport failed"),
  };
  if (isMutating(operation)) {
    return new RuntimeError(
      "DELIVERY_UNKNOWN",
      "Runtime RPC delivery or result is uncertain; inspect by idempotency key before retrying",
      details,
    );
  }
  return new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime daemon is unavailable", details, true);
}

function runtimeErrorFromResponse(
  error: Extract<RpcResponse, { readonly ok: false }>["error"],
  authorization: string | undefined,
): RuntimeError {
  const runtimeError = new RuntimeError(
    runtimeErrorCode(error.code),
    error.message,
    error.details,
    error.retryable,
  );
  return containsCredential(runtimeError, authorization) ? internalRuntimeRpcError() : runtimeError;
}

function credentialSafeRuntimeError(
  error: RuntimeError,
  grant: VerifiedRuntimeRpcGrant | undefined,
): RuntimeError {
  if (grant === undefined) return error;
  return containsCredential(error, runtimeRpcGrantToken(grant)) ? internalRuntimeRpcError() : error;
}

function containsCredential(error: RuntimeError, credential: string | undefined): boolean {
  if (credential === undefined) return false;
  try {
    return JSON.stringify({ details: error.details, message: error.message }).includes(credential);
  } catch {
    return true;
  }
}

function internalRuntimeRpcError(): RuntimeError {
  return new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime RPC request failed", {}, true);
}

function isMutating(operation: RuntimeOperation): boolean {
  return (
    operation === "session.create" ||
    operation === "session.fork" ||
    operation === "session.close" ||
    operation === "execution.dispatch" ||
    operation === "execution.start" ||
    operation === "input.send" ||
    operation === "control.send" ||
    operation === "terminal.resize" ||
    operation === "interaction.policy.set" ||
    operation === "interaction.guard.acquire" ||
    operation === "interaction.guard.renew" ||
    operation === "interaction.guard.release"
  );
}

export function runtimeOwnerIdForSocket(socketPath: string): string {
  return `owner_local_${createHash("sha256").update(socketPath).digest("hex").slice(0, 24)}`;
}

function runtimeErrorCode(code: string): RuntimeError["code"] {
  return runtimeErrorCodes.has(code as RuntimeError["code"])
    ? (code as RuntimeError["code"])
    : "RUNTIME_UNAVAILABLE";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
