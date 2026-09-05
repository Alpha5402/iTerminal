export interface TabSession {
  readonly id: string;
  readonly generation: number;
  readonly status: string;
}

export const DISMISSED_TABS_KEY = "iterminal.dismissed-session-tabs.v1";
const MAX_DISMISSED_TABS = 2_000;

export function sessionTabKey(session: TabSession): string {
  return JSON.stringify([session.id, session.generation]);
}

export function readDismissedTabs(storage: Pick<Storage, "getItem">): readonly string[] {
  try {
    const raw = storage.getItem(DISMISSED_TABS_KEY);
    if (raw === null || raw.length > 1_024 * 1_024) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((key): key is string => typeof key === "string" && key.length <= 512)
      .slice(-MAX_DISMISSED_TABS);
  } catch {
    return [];
  }
}

export function dismissSessionTab(
  dismissed: readonly string[],
  session: TabSession,
): readonly string[] {
  const key = sessionTabKey(session);
  return [...dismissed.filter((candidate) => candidate !== key), key].slice(-MAX_DISMISSED_TABS);
}

export function visibleSessionTabs<T extends TabSession>(
  sessions: readonly T[],
  dismissed: readonly string[],
): readonly T[] {
  const hidden = new Set(dismissed);
  return sessions.filter(
    (session) => session.status !== "CLOSED" && !hidden.has(sessionTabKey(session)),
  );
}

/** Keep the current tab, otherwise prefer its right-hand neighbor, then the left. */
export function selectedSessionTab(
  selectedId: string | undefined,
  previous: readonly TabSession[],
  next: readonly TabSession[],
): string | undefined {
  if (next.some((session) => session.id === selectedId)) return selectedId;
  const position = previous.findIndex((session) => session.id === selectedId);
  const remaining = new Set(next.map((session) => session.id));
  if (position >= 0) {
    const right = previous.slice(position + 1).find((session) => remaining.has(session.id));
    const left = previous.slice(0, position).findLast((session) => remaining.has(session.id));
    if (right !== undefined || left !== undefined) return right?.id ?? left?.id;
  }
  return next[0]?.id;
}
