import type { Terminal } from "@xterm/xterm";
import type {
  TerminalScreenCell,
  TerminalScreenCellStyle,
  TerminalScreenColor,
} from "@iterminal/domain";

export interface RenderableScreen {
  readonly columns: number;
  readonly rows: number;
  readonly cursor: { readonly column: number; readonly row: number };
  readonly lines: readonly string[];
  readonly cells?: readonly TerminalScreenCell[];
}

export function safeScreenText(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("");
}

/** Only locally generated cursor/SGR sequences; terminal program OSC is never replayed. */
export function encodeScreen(screen: RenderableScreen, showCursor: boolean): string {
  const parts = ["\u001b[?7l\u001b[0m\u001b[2J\u001b[H"];
  if (screen.cells === undefined) {
    for (const [row, line] of screen.lines.slice(0, screen.rows).entries())
      parts.push(`\u001b[${row + 1};1H${safeScreenText(line)}`);
  } else {
    for (const cell of screen.cells) {
      if (
        cell.width === 0 ||
        cell.row < 0 ||
        cell.row >= screen.rows ||
        cell.column < 0 ||
        cell.column >= screen.columns
      )
        continue;
      parts.push(
        `\u001b[${cell.row + 1};${cell.column + 1}H${sgr(cell.style)}${cell.style.invisible ? " ".repeat(cell.width) : safeScreenText(cell.text) || " ".repeat(cell.width)}`,
      );
    }
  }
  parts.push(
    `\u001b[0m\u001b[?7h\u001b[?25${showCursor ? "h" : "l"}\u001b[${screen.cursor.row + 1};${screen.cursor.column + 1}H`,
  );
  return parts.join("");
}

function sgr(style: TerminalScreenCellStyle): string {
  const codes = [0];
  for (const [key, code] of [
    ["bold", 1],
    ["dim", 2],
    ["italic", 3],
    ["underline", 4],
    ["blink", 5],
    ["inverse", 7],
    ["invisible", 8],
    ["strikethrough", 9],
    ["overline", 53],
  ] as const)
    if (style[key]) codes.push(code);
  const color = (value: TerminalScreenColor | undefined, prefix: number) => {
    if (value?.mode === "palette") codes.push(prefix, 5, value.index);
    if (value?.mode === "rgb") codes.push(prefix, 2, value.red, value.green, value.blue);
  };
  color(style.foreground, 38);
  color(style.background, 48);
  return `\u001b[${codes.join(";")}m`;
}

export function renderScreen(
  terminal: Terminal,
  screen: RenderableScreen,
  showCursor: boolean,
  onRendered: (text: string) => void,
): void {
  if (terminal.cols !== screen.columns || terminal.rows !== screen.rows)
    terminal.resize(screen.columns, screen.rows);
  terminal.write(encodeScreen(screen, showCursor), () => {
    const buffer = terminal.buffer.active;
    const lines = Array.from(
      { length: screen.rows },
      (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
    );
    onRendered(lines.join("\n"));
  });
}
