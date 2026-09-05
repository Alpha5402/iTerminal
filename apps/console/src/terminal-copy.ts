import type { Terminal } from "@xterm/xterm";

export interface CopySnapshot {
  readonly columns: number;
  readonly rows: number;
  readonly lines: readonly string[];
  readonly wrappedRows?: readonly boolean[];
}

/** Copy only the rendered viewport. Unknown metadata must not trigger newline guessing. */
export function terminalSelectionText(
  terminal: Pick<Terminal, "buffer" | "cols" | "rows" | "getSelectionPosition">,
  snapshot: CopySnapshot,
): string | undefined {
  const selection = terminal.getSelectionPosition();
  if (
    selection === undefined ||
    snapshot.wrappedRows?.length !== snapshot.rows ||
    snapshot.lines.length !== snapshot.rows ||
    snapshot.columns !== terminal.cols ||
    snapshot.rows !== terminal.rows
  )
    return undefined;
  const buffer = terminal.buffer.active;
  const start = selection.start.y - buffer.baseY;
  const end = selection.end.y - buffer.baseY;
  if (start < 0 || end >= snapshot.rows || end < start) return undefined;
  let result = "";
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (line === undefined) return undefined;
    const from = row === start ? selection.start.x : 0;
    const to = row === end ? selection.end.x : snapshot.columns;
    const prefixLength = line.translateToString(false, 0, from).length;
    // The canonical text excludes unoccupied padding, but includes real soft-boundary spaces.
    const selected = line
      .translateToString(false, from, to)
      .slice(0, Math.max(0, (snapshot.lines[row]?.length ?? 0) - prefixLength));
    if (row > start && snapshot.wrappedRows[row] !== true) result += "\n";
    result += selected;
  }
  return result;
}
