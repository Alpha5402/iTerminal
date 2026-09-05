import { describe, expect, it } from "vitest";

import {
  idleSubmissionIntent,
  isDefiniteSubmissionRejectionCode,
  isSubmissionIntentPending,
  startSubmissionIntent,
  submissionIntentCanSettleFailure,
  submissionIntentMatchesDraft,
  submissionIntentReducer,
  type SubmissionIntentIdentity,
  type SubmissionIntentState,
} from "./submission-intent.js";

const executeIntent: SubmissionIntentIdentity = {
  draftRevision: 3,
  generation: 2,
  idempotencyKey: "intent-key",
  payload: {
    body: { command: "echo once", generation: 2, idempotencyKey: "intent-key" },
    kind: "execute",
  },
  sessionId: "session-a",
};

describe("submission intent", () => {
  it("freezes one request identity and ignores repeated Enter while unresolved", () => {
    const submitting = begin(executeIntent);
    let generated = 0;
    const repeated = startSubmissionIntent(submitting, () => {
      generated += 1;
      return {
        ...executeIntent,
        idempotencyKey: "replacement-key",
        payload: {
          body: { command: "echo twice", generation: 2, idempotencyKey: "replacement-key" },
          kind: "execute",
        },
      };
    });
    expect(repeated).toBe(submitting);
    expect(generated).toBe(0);

    const uncertain = submissionIntentReducer(submitting, {
      generation: executeIntent.generation,
      idempotencyKey: executeIntent.idempotencyKey,
      message: "The response was lost.",
      sessionId: executeIntent.sessionId,
      type: "uncertain",
    });
    expect(isSubmissionIntentPending(uncertain)).toBe(true);
    expect(uncertain).toMatchObject(executeIntent);
    expect(uncertain.status).toBe("uncertain");
    expect(submissionIntentReducer(uncertain, { type: "dismiss" })).toBe(uncertain);
  });

  it("keeps not-found and unavailable lookups uncertain, then accepts the same found fact", () => {
    let state = uncertain(begin(executeIntent));
    state = submissionIntentReducer(state, {
      generation: 2,
      idempotencyKey: "intent-key",
      sessionId: "session-a",
      type: "lookup_started",
    });
    expect(state).toMatchObject({ checking: true, status: "uncertain" });
    expect(
      submissionIntentReducer(state, {
        generation: 2,
        idempotencyKey: "intent-key",
        sessionId: "session-a",
        type: "lookup_started",
      }),
    ).toBe(state);

    state = submissionIntentReducer(state, {
      generation: 2,
      idempotencyKey: "intent-key",
      result: {
        generation: 2,
        idempotencyKey: "intent-key",
        kind: "not_found",
        mayStillBeInFlight: true,
        message: "The request may still be in flight.",
        sessionId: "session-a",
      },
      sessionId: "session-a",
      type: "lookup_finished",
    });
    expect(state).toMatchObject({ checking: false, status: "uncertain" });

    state = submissionIntentReducer(state, {
      generation: 2,
      idempotencyKey: "intent-key",
      result: {
        generation: 2,
        idempotencyKey: "intent-key",
        kind: "unavailable",
        message: "Durable lookup is unavailable.",
        reason: "durability_unavailable",
        retryable: true,
        sessionId: "session-a",
      },
      sessionId: "session-a",
      type: "lookup_finished",
    });
    expect(state).toMatchObject({ status: "uncertain" });

    state = submissionIntentReducer(state, {
      generation: 2,
      idempotencyKey: "intent-key",
      result: {
        acceptedAt: "2026-09-05T00:00:00.000Z",
        actionId: "action-1",
        actionStatus: "UNKNOWN",
        actionType: "execute",
        executionId: "execution-1",
        executionStatus: "UNKNOWN",
        generation: 2,
        idempotencyKey: "intent-key",
        kind: "found",
        sessionId: "session-a",
      },
      sessionId: "session-a",
      type: "lookup_finished",
    });
    expect(state).toMatchObject({
      actionId: "action-1",
      actionStatus: "UNKNOWN",
      executionId: "execution-1",
      executionStatus: "UNKNOWN",
      status: "accepted",
    });
    expect(isSubmissionIntentPending(state)).toBe(false);
  });

  it("does not apply late or cross-session/generation responses", () => {
    const active = begin({ ...executeIntent, idempotencyKey: "new-key" });
    expect(
      submissionIntentReducer(active, {
        actionId: "old-action",
        actionStatus: "COMPLETED",
        generation: 2,
        idempotencyKey: "intent-key",
        sessionId: "session-a",
        type: "accepted",
      }),
    ).toBe(active);
    expect(
      submissionIntentReducer(active, {
        actionId: "crossed-action",
        actionStatus: "COMPLETED",
        generation: 3,
        idempotencyKey: "new-key",
        sessionId: "session-b",
        type: "accepted",
      }),
    ).toBe(active);

    const unresolved = uncertain(active);
    const crossed = submissionIntentReducer(unresolved, {
      generation: 2,
      idempotencyKey: "new-key",
      result: {
        acceptedAt: "2026-09-05T00:00:00.000Z",
        actionId: "wrong-action",
        actionStatus: "COMPLETED",
        actionType: "execute",
        generation: 3,
        idempotencyKey: "new-key",
        kind: "found",
        sessionId: "session-b",
      },
      sessionId: "session-a",
      type: "lookup_finished",
    });
    expect(crossed).toBe(unresolved);
    expect(
      submissionIntentMatchesDraft(executeIntent, {
        draftRevision: executeIntent.draftRevision + 1,
        generation: executeIntent.generation,
        sessionId: executeIntent.sessionId,
      }),
    ).toBe(false);
    expect(
      submissionIntentMatchesDraft(executeIntent, {
        draftRevision: executeIntent.draftRevision,
        generation: executeIntent.generation,
        sessionId: "session-b",
      }),
    ).toBe(false);
  });

  it("allows a fresh intent only after a definite rejection", () => {
    expect(isDefiniteSubmissionRejectionCode("INVALID_REQUEST")).toBe(true);
    expect(isDefiniteSubmissionRejectionCode("PTY_BUSY")).toBe(true);
    expect(isDefiniteSubmissionRejectionCode("IDEMPOTENCY_KEY_REUSED")).toBe(false);
    expect(isDefiniteSubmissionRejectionCode("DELIVERY_UNKNOWN")).toBe(false);
    expect(isDefiniteSubmissionRejectionCode("RUNTIME_UNAVAILABLE")).toBe(false);
    expect(isDefiniteSubmissionRejectionCode("CLIENT_ERROR")).toBe(false);
    const rejected = submissionIntentReducer(begin(executeIntent), {
      code: "INVALID_REQUEST",
      generation: 2,
      idempotencyKey: "intent-key",
      message: "Validation rejected the request before admission.",
      sessionId: "session-a",
      type: "rejected",
    });
    expect(rejected).toMatchObject({ code: "INVALID_REQUEST", status: "rejected" });

    const next = submissionIntentReducer(rejected, {
      identity: {
        ...executeIntent,
        draftRevision: 4,
        idempotencyKey: "corrected-key",
        payload: {
          body: { command: "echo corrected", generation: 2, idempotencyKey: "corrected-key" },
          kind: "execute",
        },
      },
      type: "begin",
    });
    expect(next).toMatchObject({
      draftRevision: 4,
      idempotencyKey: "corrected-key",
      status: "submitting",
    });
  });

  it("does not turn an older terminal intent uncertain when a preflight read fails", () => {
    const accepted = submissionIntentReducer(begin(executeIntent), {
      actionId: "action-accepted",
      actionStatus: "COMPLETED",
      generation: 2,
      idempotencyKey: "intent-key",
      sessionId: "session-a",
      type: "accepted",
    });
    expect(submissionIntentCanSettleFailure(accepted, undefined)).toBe(false);
    expect(submissionIntentCanSettleFailure(accepted, executeIntent)).toBe(false);
    expect(submissionIntentCanSettleFailure(begin(executeIntent), executeIntent)).toBe(true);
    expect(
      submissionIntentReducer(accepted, {
        generation: 2,
        idempotencyKey: "intent-key",
        message: "A late local error must not replace an accepted server fact.",
        sessionId: "session-a",
        type: "uncertain",
      }),
    ).toBe(accepted);
  });

  it("retains the exact foreground target and frozen line payload", () => {
    const state = begin({
      draftRevision: 8,
      executionId: "execution-target",
      generation: 4,
      idempotencyKey: "input-key",
      payload: {
        body: {
          data: "status\n",
          generation: 4,
          idempotencyKey: "input-key",
          lineInput: { expectedInputVersion: 9, expectedInteractionVersion: 12 },
          targetExecutionId: "execution-target",
        },
        kind: "input",
      },
      sessionId: "session-input",
    });
    expect(state).toMatchObject({
      executionId: "execution-target",
      payload: { body: { data: "status\n" }, kind: "input" },
    });
  });
});

function begin(identity: SubmissionIntentIdentity): SubmissionIntentState {
  return submissionIntentReducer(idleSubmissionIntent, { identity, type: "begin" });
}

function uncertain(state: SubmissionIntentState): SubmissionIntentState {
  if (state.status === "idle") throw new Error("Expected an active intent");
  return submissionIntentReducer(state, {
    generation: state.generation,
    idempotencyKey: state.idempotencyKey,
    message: "Response delivery is uncertain.",
    sessionId: state.sessionId,
    type: "uncertain",
  });
}
