import headless from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { terminalSelectionText } from "../../../apps/console/src/terminal-copy.js";
import { XtermScreenProjection } from "./index.js";

const { Terminal } = headless;

async function rendered(text: string) {
  const projection = new XtermScreenProjection({ sessionId: "copy-test", sessionGeneration: 1 });
  await projection.resize(40, 12, 1);
  projection.write(text, 2);
  const snapshot = await projection.snapshot();
  const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(snapshot.lines.join("\r\n"), resolve));
  return {
    snapshot,
    terminal,
    dispose: () => {
      projection.dispose();
      terminal.dispose();
    },
  };
}

describe("canonical viewport copy", () => {
  it.each([
    `cd "/Users/example/Documents/Minecraft-Console-Client/MinecraftClient/bin/Release/net10.0/osx-arm64/publish"\r\nenv EXAMPLE=1 ./MinecraftClient MinecraftClient.ini`,
    `${"x".repeat(39)} B\r\n\r\nnext`,
    `${"x".repeat(39)}界🙂e\u0301\r\nnext`,
    `printf 'literal\\n'; echo ${"x".repeat(70)}\r\necho done`,
  ])("copies soft wraps without changing real newlines or content: %s", async (text) => {
    const view = await rendered(text);
    try {
      expect(view.snapshot.wrappedRows).toContain(true);
      expect(
        terminalSelectionText(
          {
            buffer: view.terminal.buffer,
            cols: 40,
            rows: 12,
            getSelectionPosition: () => ({
              start: { x: 0, y: 0 },
              end: { x: view.snapshot.cursor.column, y: view.snapshot.cursor.row },
            }),
          },
          view.snapshot,
        ),
      ).toBe(text.replaceAll("\r\n", "\n"));
    } finally {
      view.dispose();
    }
  });

  it("uses terminal cells for partial CJK selections and does not guess legacy metadata", async () => {
    const view = await rendered(`界 % ${"a".repeat(60)}`);
    const selected = {
      buffer: view.terminal.buffer,
      cols: 40,
      rows: 12,
      getSelectionPosition: () => ({ start: { x: 5, y: 0 }, end: { x: 10, y: 1 } }),
    };
    try {
      expect(terminalSelectionText(selected, view.snapshot)).toBe("a".repeat(45));
      const { wrappedRows: _wraps, ...legacy } = view.snapshot;
      expect(_wraps).toContain(true);
      expect(terminalSelectionText(selected, legacy)).toBeUndefined();
      expect(terminalSelectionText({ ...selected, cols: 80 }, view.snapshot)).toBeUndefined();
      expect(
        terminalSelectionText(
          { ...selected, getSelectionPosition: () => undefined },
          view.snapshot,
        ),
      ).toBeUndefined();
      expect(
        terminalSelectionText(
          {
            ...selected,
            getSelectionPosition: () => ({ start: { x: 0, y: -1 }, end: { x: 1, y: 0 } }),
          },
          view.snapshot,
        ),
      ).toBeUndefined();
    } finally {
      view.dispose();
    }
  });

  it("includes wrap-only row changes in diffs and clones metadata", async () => {
    const screen = new XtermScreenProjection({ sessionId: "wrap-diff", sessionGeneration: 1 });
    try {
      await screen.resize(40, 12, 1);
      screen.write(`${"x".repeat(40)}y`, 2);
      const soft = await screen.snapshot();
      expect(soft.wrappedRows?.[1]).toBe(true);
      (soft.wrappedRows as boolean[])[1] = false;
      expect((await screen.snapshot()).wrappedRows?.[1]).toBe(true);
      screen.write(`\x1b[2J\x1b[H${"x".repeat(40)}\r\ny`, 3);
      await expect(screen.diff(2)).resolves.toMatchObject({
        resyncRequired: false,
        changedRows: [{ row: 1, text: "y", wrapped: false }],
      });
      screen.write("\x1b[?1049h\x1b[2J\x1b[Halternate", 4);
      expect((await screen.snapshot()).wrappedRows).not.toContain(true);
      screen.write("\x1b[?1049l", 5);
      expect((await screen.snapshot()).lines[1]).toBe("y");
    } finally {
      screen.dispose();
    }
  });
});
