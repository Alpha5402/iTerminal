import type { TerminalConsoleFrame } from "@iterminal/domain";
export interface ScreenDelta {
  readonly baseVersion: number;
  readonly frame: Omit<TerminalConsoleFrame, "cells" | "lines" | "wrappedRows">;
  readonly changedRows: readonly {
    readonly row: number;
    readonly text: string;
    readonly wrapped: boolean;
    readonly cells: TerminalConsoleFrame["cells"];
  }[];
}
export function screenDelta(
  before: TerminalConsoleFrame,
  next: TerminalConsoleFrame,
): ScreenDelta | undefined {
  if (
    before.sessionId !== next.sessionId ||
    before.sessionGeneration !== next.sessionGeneration ||
    before.geometryVersion !== next.geometryVersion ||
    before.buffer !== next.buffer ||
    before.columns !== next.columns ||
    before.rows !== next.rows
  )
    return undefined;
  const rows = (frame: TerminalConsoleFrame) => {
    const result: TerminalConsoleFrame["cells"][number][][] = Array.from(
      { length: frame.rows },
      () => [],
    );
    for (const cell of frame.cells) result[cell.row]?.push(cell);
    return result;
  };
  const prior = rows(before),
    current = rows(next);
  const changedRows: ScreenDelta["changedRows"][number][] = [];
  for (let row = 0; row < next.rows; row++) {
    if (
      before.lines[row] !== next.lines[row] ||
      before.wrappedRows?.[row] !== next.wrappedRows?.[row] ||
      JSON.stringify(prior[row]) !== JSON.stringify(current[row])
    )
      changedRows.push({
        row,
        text: next.lines[row] ?? "",
        wrapped: next.wrappedRows?.[row] ?? false,
        cells: current[row] ?? [],
      });
  }
  const { cells: _cells, lines: _lines, wrappedRows: _wraps, ...frame } = next;
  void _cells;
  void _lines;
  void _wraps;
  return { baseVersion: before.screenVersion, frame, changedRows };
}
export function applyScreenDelta(
  before: TerminalConsoleFrame,
  delta: ScreenDelta,
): TerminalConsoleFrame | undefined {
  if (
    before.screenVersion !== delta.baseVersion ||
    before.sessionId !== delta.frame.sessionId ||
    before.sessionGeneration !== delta.frame.sessionGeneration ||
    before.geometryVersion !== delta.frame.geometryVersion
  )
    return undefined;
  const lines = [...before.lines],
    wrappedRows = [...(before.wrappedRows ?? [])];
  const replaced = new Set(delta.changedRows.map((row) => row.row));
  const cells = before.cells.filter((cell) => !replaced.has(cell.row));
  for (const row of delta.changedRows) {
    lines[row.row] = row.text;
    wrappedRows[row.row] = row.wrapped;
    cells.push(...row.cells);
  }
  cells.sort((a, b) => a.row - b.row || a.column - b.column);
  return { ...delta.frame, lines, wrappedRows, cells };
}
