import type { ActionLookupResult } from "@iterminal/protocol";

export type SubmissionIntentStatus = "idle" | "submitting" | "uncertain" | "accepted" | "rejected";

export type SubmissionPayload =
  | Readonly<{
      body: Readonly<{
        command: string;
        generation: number;
        idempotencyKey: string;
      }>;
      kind: "execute";
    }>
  | Readonly<{
      body: Readonly<{
        data: string;
        generation: number;
        idempotencyKey: string;
        lineInput: Readonly<{
          expectedInputVersion: number;
          expectedInteractionVersion: number;
        }>;
        targetExecutionId: string;
      }>;
      kind: "input";
    }>;

export interface SubmissionIntentIdentity {
  readonly draftRevision: number;
  readonly executionId?: string;
  readonly idempotencyKey: string;
  readonly payload: SubmissionPayload;
  readonly sessionId: string;
  readonly generation: number;
}

export interface SubmissionDraftIdentity {
  readonly draftRevision: number;
  readonly executionId?: string;
  readonly generation: number;
  readonly sessionId: string;
}

export interface SubmissionAcceptedFact {
  readonly actionId: string;
  readonly actionStatus: string;
  readonly executionId?: string;
  readonly executionStatus?: string;
}

interface SubmissionResolutionIdentity {
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly sessionId: string;
}

export type SubmissionIntentState =
  | Readonly<{ readonly status: "idle" }>
  | (SubmissionIntentIdentity & Readonly<{ readonly status: "submitting" }>)
  | (SubmissionIntentIdentity &
      Readonly<{
        readonly actionId?: string;
        readonly checking: boolean;
        readonly message: string;
        readonly status: "uncertain";
      }>)
  | (SubmissionIntentIdentity & SubmissionAcceptedFact & Readonly<{ readonly status: "accepted" }>)
  | (SubmissionIntentIdentity &
      Readonly<{
        readonly actionId?: string;
        readonly code: string;
        readonly message: string;
        readonly status: "rejected";
      }>);

export type SubmissionIntentEvent =
  | Readonly<{ readonly identity: SubmissionIntentIdentity; readonly type: "begin" }>
  | (SubmissionResolutionIdentity &
      Readonly<{
        readonly actionId: string;
        readonly actionStatus: string;
        readonly executionId?: string;
        readonly executionStatus?: string;
        readonly type: "accepted";
      }>)
  | (SubmissionResolutionIdentity &
      Readonly<{
        readonly actionId?: string;
        readonly message: string;
        readonly type: "uncertain";
      }>)
  | (SubmissionResolutionIdentity &
      Readonly<{
        readonly actionId?: string;
        readonly code: string;
        readonly message: string;
        readonly type: "rejected";
      }>)
  | (SubmissionResolutionIdentity & Readonly<{ readonly type: "lookup_started" }>)
  | (SubmissionResolutionIdentity &
      Readonly<{
        readonly result: ActionLookupResult;
        readonly type: "lookup_finished";
      }>)
  | (SubmissionResolutionIdentity &
      Readonly<{
        readonly message: string;
        readonly type: "lookup_failed";
      }>)
  | Readonly<{ readonly type: "dismiss" }>;

export const idleSubmissionIntent: SubmissionIntentState = { status: "idle" };

const DEFINITE_ADMISSION_REJECTIONS = new Set([
  "APPROVAL_REQUIRED",
  "BACKPRESSURE",
  "INPUT_CONTEXT_CHANGED",
  "INPUT_CONTEXT_UNSAFE",
  "INPUT_GUARDED",
  "INVALID_REQUEST",
  "POLICY_DENIED",
  "PTY_BUSY",
  "RATE_LIMITED",
  "SCREEN_CHANGED",
  "SENSITIVE_INPUT_ACTIVE",
  "SESSION_BROKEN",
  "SESSION_GENERATION_CHANGED",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_READY",
  "EXECUTION_CHANGED",
]);

export function submissionIntentReducer(
  state: SubmissionIntentState,
  event: SubmissionIntentEvent,
): SubmissionIntentState {
  if (event.type === "dismiss") {
    return isSubmissionIntentPending(state) ? state : idleSubmissionIntent;
  }
  if (event.type === "begin") {
    return isSubmissionIntentPending(state) ? state : { ...event.identity, status: "submitting" };
  }
  if (state.status === "idle" || !sameResolutionIdentity(state, event)) return state;

  switch (event.type) {
    case "accepted":
      if (state.status === "accepted" || state.status === "rejected") return state;
      return {
        ...identityOf(state),
        actionId: event.actionId,
        actionStatus: event.actionStatus,
        ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        ...(event.executionStatus === undefined ? {} : { executionStatus: event.executionStatus }),
        status: "accepted",
      };
    case "uncertain":
      if (state.status === "accepted" || state.status === "rejected") return state;
      return {
        ...identityOf(state),
        ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
        checking: false,
        message: event.message,
        status: "uncertain",
      };
    case "rejected":
      if (state.status === "accepted" || state.status === "rejected") return state;
      return {
        ...identityOf(state),
        ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
        code: event.code,
        message: event.message,
        status: "rejected",
      };
    case "lookup_started":
      return state.status === "uncertain" && !state.checking ? { ...state, checking: true } : state;
    case "lookup_finished": {
      if (state.status !== "uncertain" || !sameLookupIdentity(state, event.result)) return state;
      if (event.result.kind === "found") {
        return {
          ...identityOf(state),
          actionId: event.result.actionId,
          actionStatus: event.result.actionStatus,
          ...(event.result.executionId === undefined
            ? {}
            : { executionId: event.result.executionId }),
          ...(event.result.executionStatus === undefined
            ? {}
            : { executionStatus: event.result.executionStatus }),
          status: "accepted",
        };
      }
      return {
        ...identityOf(state),
        ...(state.actionId === undefined ? {} : { actionId: state.actionId }),
        checking: false,
        message: event.result.message,
        status: "uncertain",
      };
    }
    case "lookup_failed":
      return state.status === "uncertain"
        ? { ...state, checking: false, message: event.message }
        : state;
    default:
      return state;
  }
}

export function isSubmissionIntentPending(state: SubmissionIntentState): boolean {
  return state.status === "submitting" || state.status === "uncertain";
}

export function isDefiniteSubmissionRejectionCode(code: string): boolean {
  return DEFINITE_ADMISSION_REJECTIONS.has(code);
}

export function startSubmissionIntent(
  state: SubmissionIntentState,
  createIdentity: () => SubmissionIntentIdentity,
): SubmissionIntentState {
  return isSubmissionIntentPending(state)
    ? state
    : submissionIntentReducer(state, { identity: createIdentity(), type: "begin" });
}

export function submissionIntentMatchesDraft(
  intent: SubmissionIntentIdentity,
  draft: SubmissionDraftIdentity,
): boolean {
  return (
    intent.sessionId === draft.sessionId &&
    intent.generation === draft.generation &&
    intent.executionId === draft.executionId &&
    intent.draftRevision === draft.draftRevision
  );
}

export function submissionIntentCanSettleFailure(
  state: SubmissionIntentState,
  submittedIdentity: SubmissionIntentIdentity | undefined,
): submittedIdentity is SubmissionIntentIdentity {
  return (
    submittedIdentity !== undefined &&
    state.status === "submitting" &&
    state.sessionId === submittedIdentity.sessionId &&
    state.generation === submittedIdentity.generation &&
    state.idempotencyKey === submittedIdentity.idempotencyKey
  );
}

function identityOf(
  state: Exclude<SubmissionIntentState, { readonly status: "idle" }>,
): SubmissionIntentIdentity {
  return {
    draftRevision: state.draftRevision,
    ...(state.executionId === undefined ? {} : { executionId: state.executionId }),
    generation: state.generation,
    idempotencyKey: state.idempotencyKey,
    payload: state.payload,
    sessionId: state.sessionId,
  };
}

function sameLookupIdentity(state: SubmissionIntentIdentity, result: ActionLookupResult): boolean {
  return (
    result.sessionId === state.sessionId &&
    result.generation === state.generation &&
    result.idempotencyKey === state.idempotencyKey
  );
}

function sameResolutionIdentity(
  state: SubmissionIntentIdentity,
  event: SubmissionResolutionIdentity,
): boolean {
  return (
    state.sessionId === event.sessionId &&
    state.generation === event.generation &&
    state.idempotencyKey === event.idempotencyKey
  );
}
