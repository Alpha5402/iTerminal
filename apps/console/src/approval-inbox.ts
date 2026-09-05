import { useEffect, useState } from "react";
import type { Approval } from "@iterminal/domain";
import { api, normalizeClientError, type ApiErrorBody } from "./console-client.js";

interface InboxPage {
  items: readonly Approval[];
  partial: boolean;
  nextCursor: string | null;
}

/** One polling owner, bounded pages, and cancellation on revision/unmount. */
export function useApprovalInbox(
  revision: number | undefined,
  onError: (error: ApiErrorBody) => void,
  enabled: boolean,
) {
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState<InboxPage>({ items: [], partial: false, nextCursor: null });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      setLoading(true);
      try {
        const items = new Map<string, Approval>();
        let cursor: string | null = null;
        let partial = false;
        for (let index = 0; index < pageCount; index++) {
          const next: InboxPage = await api(
            `/api/approvals/pending${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            { signal: abort.signal },
          );
          for (const approval of next.items) items.set(approval.id, approval);
          partial ||= next.partial;
          cursor = next.nextCursor;
          if (!cursor) break;
        }
        if (!abort.signal.aborted)
          setPage({ items: [...items.values()], partial, nextCursor: cursor });
      } catch (reason) {
        if (!abort.signal.aborted) {
          setPage((previous) => ({ ...previous, partial: true }));
          onError(normalizeClientError(reason));
        }
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 3000);
        }
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [revision, pageCount, onError, enabled]);
  return {
    ...page,
    loading,
    canLoadMore: !!page.nextCursor && pageCount < 100,
    loadMore: () => setPageCount((count) => Math.min(100, count + 1)),
  };
}
