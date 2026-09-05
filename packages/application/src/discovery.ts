import type {
  Approval,
  PendingApprovalsRequest,
  PendingApprovalsPage,
  Session,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";

export function pendingCursor(sessionId: string, approvalId: string): string {
  return Buffer.from(JSON.stringify([sessionId, approvalId])).toString("base64url");
}
export function parsePendingCursor(
  cursor: string | undefined,
): readonly [string, string] | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256) ||
      cursor.length > 1024
    )
      throw new Error();
    return [value[0] as string, value[1] as string];
  } catch {
    throw new RuntimeError("INVALID_REQUEST", "Invalid pending Approval cursor");
  }
}

/** Pure bounded pending projection. Admission/identity and all mutations stay in RuntimeService. */
export function pendingApprovalsPage(
  approvals: Iterable<Approval>,
  request: PendingApprovalsRequest,
  sessionFor: (id: string) => Pick<Session, "generation" | "status"> | undefined,
  copy: (approval: Approval) => Approval,
  now: number,
): PendingApprovalsPage {
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RuntimeError("INVALID_REQUEST", "Invalid pending Approval limit");
  const after = parsePendingCursor(request.cursor);
  const matches = [...approvals]
    .filter((approval) => {
      const session = sessionFor(approval.sessionId);
      return (
        approval.status === "PENDING" &&
        Date.parse(approval.expiresAt) > now &&
        session?.generation === approval.sessionGeneration &&
        session.status !== "BROKEN" &&
        session.status !== "CLOSED" &&
        (request.sessionId === undefined || request.sessionId === approval.sessionId) &&
        (!after ||
          approval.sessionId > after[0] ||
          (approval.sessionId === after[0] && approval.id > after[1]))
      );
    })
    .sort((a, b) =>
      a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.id < b.id ? -1 : 1,
    )
    .slice(0, limit + 1);
  const items = matches.slice(0, limit).map(copy);
  const last = items.at(-1);
  return {
    items,
    nextCursor: matches.length > limit && last ? pendingCursor(last.sessionId, last.id) : null,
    partial: false,
    unavailableOwners: [],
  };
}
