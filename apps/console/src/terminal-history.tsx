import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalHistoryPage } from "@iterminal/domain";
import { safeScreenText } from "./terminal-renderer.js";

export function TerminalHistory({
  sessionId,
  generation,
  onClose,
}: {
  sessionId: string;
  generation: number;
  onClose: () => void;
}): React.JSX.Element {
  const [page, setPage] = useState<TerminalHistoryPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const viewport = useRef<HTMLPreElement>(null);
  const previousHeight = useRef<number | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const query = new URLSearchParams({
      generation: String(generation),
      limit: "100",
      ...(cursor === undefined ? {} : { cursor }),
    });
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history?${query}`, {
      credentials: "same-origin",
      headers: { "x-iterminal-request": "console" },
      signal: abort.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          result?: TerminalHistoryPage;
          error?: { message: string };
        };
        if (!response.ok || !body.result)
          throw new Error(body.error?.message ?? "History unavailable");
        if (abort.signal.aborted) return;
        const result = body.result;
        if (result.sessionId !== sessionId || result.sessionGeneration !== generation)
          throw new Error("History generation changed");
        previousHeight.current = viewport.current?.scrollHeight;
        setPage((previous) => ({
          ...result,
          lines:
            previous && !result.gap && previous.epoch === result.epoch
              ? [...result.lines, ...previous.lines].slice(0, 5000)
              : result.lines,
        }));
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : "History unavailable");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [sessionId, generation, cursor]);
  useLayoutEffect(() => {
    if (viewport.current)
      viewport.current.scrollTop +=
        previousHeight.current === undefined
          ? viewport.current.scrollHeight
          : viewport.current.scrollHeight - previousHeight.current;
  }, [page]);
  const text =
    page?.lines
      .map(
        (line, index) => `${index === 0 || line.wrapped ? "" : "\n"}${safeScreenText(line.text)}`,
      )
      .join("") ?? "";
  return (
    <section
      className="terminal-history"
      aria-label="Terminal history"
      onClick={(event) => event.stopPropagation()}
    >
      <header>
        <strong>Browsing history</strong>
        <button type="button" onClick={onClose}>
          Back to live terminal
        </button>
      </header>
      <p>Normal buffer · generation {generation}. New output does not move this view.</p>
      {page?.gap && (
        <p role="status">Older history was evicted or reflowed. Showing the retained range.</p>
      )}
      {page && (
        <p>
          Retained from line {page.droppedBefore}; showing {page.lines.length} lines.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={loading || !page?.nextCursor}
        onClick={() => {
          if (page?.nextCursor) setCursor(page.nextCursor);
        }}
      >
        {loading ? "Loading…" : "Load older lines"}
      </button>
      <pre ref={viewport} tabIndex={0} aria-label="Retained terminal lines">
        {text || (loading ? "Loading…" : "No retained history")}
      </pre>
    </section>
  );
}
