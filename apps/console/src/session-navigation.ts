import { useCallback, useEffect, useRef, useState } from "react";
import { api, normalizeClientError, type ApiErrorBody } from "./console-client.js";

export interface SessionDiscoveryPage<T> {
  sessions: readonly T[];
  partial: boolean;
  nextCursor: string | null;
}

/** One request chain owns polling and pagination; old/unmounted reads cannot publish. */
export function useSessionDiscovery<T extends { id: string; createdAt: string }>(
  onPage: (page: SessionDiscoveryPage<T>) => void,
  onError: (error: ApiErrorBody) => void,
  enabled: boolean,
) {
  const abort = useRef<AbortController | undefined>(undefined);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const pages = useRef(1);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    const work = async () => {
      const sessions = new Map<string, T>();
      let cursor: string | null = null;
      let partial = false;
      for (let index = 0; index < pages.current; index++) {
        const page: SessionDiscoveryPage<T> = await api(
          `/api/session-discovery${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { signal: controller.signal },
        );
        for (const session of page.sessions) sessions.set(session.id, session);
        partial ||= page.partial;
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      if (!controller.signal.aborted)
        onPage({
          sessions: [...sessions.values()].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          ),
          partial,
          nextCursor: cursor,
        });
    };
    pending.current = work().finally(() => {
      pending.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    });
    return pending.current;
  }, [onPage]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await refresh();
      } catch (reason) {
        if (!stopped) onError(normalizeClientError(reason));
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 3000);
      }
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.current?.abort();
    };
  }, [refresh, onError, enabled]);
  const loadMore = useCallback(async () => {
    if (pending.current) await pending.current;
    pages.current = Math.min(100, pages.current + 1);
    await refresh();
  }, [refresh]);
  return { refresh, loadMore, loading };
}
