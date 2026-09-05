import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { agentActor, createTestRuntime, humanActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it } from "vitest";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("M10.3 Agent Execute Approval", () => {
  it("binds one Human decision to one exact Agent Execute and preserves idempotent replay", async () => {
    let now = new Date("2026-08-31T01:00:00.000Z");
    const runtime = createTestRuntime({
      agentExecuteApproval: "required",
      now: () => new Date(now),
    });
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const execute = {
      actor: agentActor,
      command: "printf 'approval-exact\\n'",
      idempotencyKey: "approved-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    };
    try {
      await expect(runtime.startExecute(execute)).rejects.toMatchObject({
        code: "APPROVAL_REQUIRED",
      });
      const pending = await runtime.requestExecuteApproval({
        actionIdempotencyKey: execute.idempotencyKey,
        actor: agentActor,
        command: execute.command,
        reason: "Run the reviewed local command",
        requestIdempotencyKey: "request-approved-execute",
        sessionGeneration: session.generation,
        sessionId: session.id,
        ttlMilliseconds: 60_000,
      });
      expect(pending.status).toBe("PENDING");
      await expect(
        runtime.startExecute({ ...execute, approvalId: pending.id }),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { status: "PENDING" } });
      const approved = await runtime.decideApproval({
        actor: humanActor,
        approvalId: pending.id,
        decision: "approve",
        expectedVersion: pending.version,
        idempotencyKey: "human-approve-execute",
        reason: "Command and workspace reviewed",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(approved).toMatchObject({ status: "APPROVED", version: 2 });
      const decisionReplay = await runtime.decideApproval({
        actor: humanActor,
        approvalId: pending.id,
        decision: "approve",
        expectedVersion: pending.version,
        idempotencyKey: "human-approve-execute",
        reason: "Command and workspace reviewed",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(decisionReplay.status).toBe("APPROVED");
      await expect(
        runtime.startExecute({
          ...execute,
          approvalId: pending.id,
          command: "printf 'changed-command\\n'",
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

      const started = await runtime.startExecute({ ...execute, approvalId: pending.id });
      const completed = await started.completion;
      expect(completed.status).toBe("COMPLETED");
      expect(completed.output).toContain("approval-exact");
      const consumed = await runtime.getApproval({
        actor: agentActor,
        approvalId: pending.id,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(consumed).toMatchObject({
        consumedActionId: started.action.id,
        status: "CONSUMED",
        version: 3,
      });
      const replay = await runtime.startExecute({ ...execute, approvalId: pending.id });
      expect(replay.action.id).toBe(started.action.id);
      await expect(
        runtime.startExecute({
          ...execute,
          approvalId: pending.id,
          idempotencyKey: "second-action-cannot-consume",
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

      const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
      expect(events.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["approval.requested", "approval.approved", "approval.consumed"]),
      );
      expect(
        JSON.stringify(events.events.filter((event) => event.type.startsWith("approval."))),
      ).not.toContain("approval-exact");
      now = new Date("2026-08-31T01:02:00.000Z");
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);

  it("expires lazily, isolates Agent reads, and requires explicit Approval capabilities", async () => {
    let now = new Date("2026-08-31T02:00:00.000Z");
    const runtime = createTestRuntime({
      agentExecuteApproval: "required",
      now: () => new Date(now),
    });
    const workspace = createWorkspace();
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const otherAgent: Actor = {
      ...agentActor,
      id: "agent_other_approval",
      principal: "other-agent",
    };
    try {
      const pending = await runtime.requestExecuteApproval({
        actionIdempotencyKey: "expiring-execute",
        actor: agentActor,
        command: "printf expiry",
        reason: "Short review window",
        requestIdempotencyKey: "request-expiring-execute",
        sessionGeneration: session.generation,
        sessionId: session.id,
        ttlMilliseconds: 30_000,
      });
      await expect(
        runtime.getApproval({
          actor: otherAgent,
          approvalId: pending.id,
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      now = new Date("2026-08-31T02:00:30.000Z");
      const expired = await runtime.getApproval({
        actor: humanActor,
        approvalId: pending.id,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(expired).toMatchObject({ status: "EXPIRED", version: 2 });
      await expect(
        runtime.decideApproval({
          actor: humanActor,
          approvalId: pending.id,
          decision: "approve",
          expectedVersion: 2,
          idempotencyKey: "late-approval",
          reason: "Too late",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });

      const noRequestCapability: Actor = {
        capabilities: ACTOR_CAPABILITY_PROFILES.agent.filter(
          (capability) => capability !== "approval.request",
        ),
        client: "limited-agent",
        id: "agent_without_approval_request",
        principal: "limited-agent",
        type: "agent",
      };
      await expect(
        runtime.requestExecuteApproval({
          actionIdempotencyKey: "denied-request",
          actor: noRequestCapability,
          command: "true",
          reason: "No capability",
          requestIdempotencyKey: "denied-request",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const listed = await runtime.listApprovals({
        actor: humanActor,
        sessionGeneration: session.generation,
        sessionId: session.id,
        status: "EXPIRED",
      });
      expect(listed.map((approval) => approval.id)).toContain(pending.id);
      const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
      expect(events.events.filter((event) => event.type === "approval.expired")).toHaveLength(1);
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  }, 20_000);
});

function createWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iterminal-approval-")));
  mkdirSync(join(root, "nested"));
  workspaces.push(root);
  return root;
}

describe("global pending Approval observation", () => {
  it("pages without duplicates, enforces immutable Human identity and omits expiry without mutation", async () => {
    let now = new Date("2026-09-06T01:00:00Z");
    const runtime = createTestRuntime({ now: () => new Date(now) });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: createWorkspace() });
    try {
      for (let index = 0; index < 3; index++)
        await runtime.requestExecuteApproval({
          actor: agentActor,
          sessionId: session.id,
          sessionGeneration: session.generation,
          command: `echo ${index}`,
          actionIdempotencyKey: `pending-${index}`,
          requestIdempotencyKey: `request-pending-${index}`,
          reason: "pending-page fixture",
          ttlMilliseconds: 30_000,
        });
      const first = runtime.listPendingApprovals({ actor: humanActor, limit: 1 });
      const second = runtime.listPendingApprovals({
        actor: humanActor,
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(new Set([...first.items, ...second.items].map((approval) => approval.id)).size).toBe(
        3,
      );
      expect(second.nextCursor).toBeNull();
      expect(() => runtime.listPendingApprovals({ actor: agentActor })).toThrowError(
        expect.objectContaining({ code: "POLICY_DENIED" }),
      );
      expect(() =>
        runtime.listPendingApprovals({ actor: { ...humanActor, principal: "forged" } }),
      ).toThrowError(expect.objectContaining({ code: "ACTOR_IDENTITY_CONFLICT" }));
      const before = await runtime.queryEvents(session.id, session.generation);
      now = new Date(now.getTime() + 30_001);
      expect(runtime.listPendingApprovals({ actor: humanActor }).items).toEqual([]);
      expect(await runtime.queryEvents(session.id, session.generation)).toEqual(before);
    } finally {
      await runtime.closeSession(session.id, session.generation);
    }
  });
});
