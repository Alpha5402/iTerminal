import React from "react";
export function Diagnostics({
  generation,
  screenVersion,
  columns,
  rows,
  geometryVersion,
  cursor,
  executionId,
}: {
  generation: number | undefined;
  screenVersion: number;
  columns: number;
  rows: number;
  geometryVersion: number;
  cursor: number;
  executionId: string | undefined;
}): React.JSX.Element {
  return (
    <details className="diagnostics">
      <summary>Diagnostics</summary>
      <span>generation {generation ?? "—"}</span>
      <span>screen v{screenVersion}</span>
      <span>
        geometry {columns}×{rows} v{geometryVersion}
      </span>
      <span>cursor {cursor}</span>
      {executionId !== undefined && <span>execution {executionId}</span>}
    </details>
  );
}
