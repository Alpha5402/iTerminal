import { describe, expect, it } from "vitest";
import { XtermScreenProjection } from "../../../packages/terminal-screen/src/index.js";
import { encodeScreen, safeScreenText } from "./terminal-renderer.js";

describe("canonical Console renderer", () => {
  it("round-trips colors, styled blanks, wide cells and hidden text at maximum geometry", async () => {
    const source = new XtermScreenProjection({ sessionId: "screen", sessionGeneration: 1 });
    const rendered = new XtermScreenProjection({ sessionId: "screen", sessionGeneration: 1 });
    try {
      await source.resize(240, 100, 1);
      await rendered.resize(240, 100, 1);
      source.write(
        "\u001b[31;1mERROR\u001b[0m 中文🐳é\r\n\u001b[48;2;21;43;65m   \u001b[7m选中\u001b[0m\u001b[8mhidden\u001b[0m",
        2,
      );
      const frame = await source.consoleFrame();
      rendered.write(encodeScreen(frame, true), 2);
      const actual = await rendered.consoleFrame();
      expect(actual.lines).toEqual(frame.lines);
      expect(actual.cursor).toEqual(frame.cursor);
      const visible = (cells: typeof frame.cells) => cells.filter((cell) => !cell.style.invisible);
      expect(visible(actual.cells)).toEqual(visible(frame.cells));
      expect(frame.cells.every((cell) => !cell.text.includes("hidden"))).toBe(true);
    } finally {
      source.dispose();
      rendered.dispose();
    }
  });

  it("strips program-controlled escape bytes instead of executing OSC clipboard commands", () => {
    const attack = "\u001b]52;c;YXR0YWNr\u0007\u009b2J";
    expect(safeScreenText(attack)).toBe("]52;c;YXR0YWNr2J");
    const encoded = encodeScreen(
      { columns: 80, rows: 24, cursor: { row: 0, column: 0 }, lines: [attack] },
      false,
    );
    expect(encoded).not.toContain("\u001b]52");
    expect(encoded).not.toContain("\u009b");
  });
});
