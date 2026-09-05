import { describe, expect, it } from "vitest";

import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  XtermScreenProjection,
} from "./index.js";

describe("XtermScreenProjection", () => {
  it("answers split cursor queries at parse-time coordinates, never on snapshot replay", async () => {
    const screen = createScreen();
    const replies: unknown[] = [];
    try {
      screen.write("\x1b[3;7H\x1b[", 1, (reply) => replies.push(reply));
      screen.write("6n\x1b[8;12H\x1b[6n\x1b[c\x1b]52;c;?\x07", 2, (reply) => replies.push(reply));
      await screen.snapshot();
      expect(replies).toEqual([
        { kind: "cursor_position", data: "\x1b[3;7R", sourceScreenVersion: 2 },
        { kind: "cursor_position", data: "\x1b[8;12R", sourceScreenVersion: 2 },
      ]);
      await screen.snapshot();
      await screen.diff(1);
      expect(replies).toHaveLength(2);
    } finally {
      screen.dispose();
    }
  });
  it("projects cursor movement, erase, wrapping, and wide Unicode at canonical geometry", async () => {
    const screen = createScreen();
    try {
      screen.write("first\r\nsecond", 1);
      screen.write("\x1b[2;1H\x1b[2K界🙂", 2);
      screen.write(`\x1b[3;1H${"x".repeat(CANONICAL_TERMINAL_COLUMNS + 3)}`, 3);

      const snapshot = await screen.snapshot();
      expect(snapshot).toMatchObject({
        buffer: "normal",
        columns: CANONICAL_TERMINAL_COLUMNS,
        cursor: { column: 3, row: 3 },
        geometryVersion: 1,
        rows: CANONICAL_TERMINAL_ROWS,
        screenVersion: 3,
      });
      expect(snapshot.lines[0]).toBe("first");
      expect(snapshot.lines[1]).toBe("界🙂");
      expect(snapshot.lines[2]).toBe("x".repeat(CANONICAL_TERMINAL_COLUMNS));
      expect(snapshot.lines[3]).toBe("xxx");
      expect(snapshot.lines).toHaveLength(CANONICAL_TERMINAL_ROWS);
    } finally {
      screen.dispose();
    }
  });

  it("returns the active alternate screen and restores the normal viewport", async () => {
    const screen = createScreen();
    try {
      screen.write("normal", 1);
      screen.write("\x1b[?1049h\x1b[2J\x1b[Halternate", 2);
      const alternate = await screen.snapshot();
      expect(alternate.buffer).toBe("alternate");
      expect(alternate.lines).toContain("alternate");
      expect(alternate.screenVersion).toBe(2);

      screen.write("\x1b[?1049l", 3);
      const normal = await screen.snapshot();
      expect(normal.buffer).toBe("normal");
      expect(normal.lines).toContain("normal");
      expect(normal.screenVersion).toBe(3);
    } finally {
      screen.dispose();
    }
  });

  it("serializes reads behind complete parser writes", async () => {
    const screen = createScreen();
    try {
      screen.write("\x1b[", 1);
      screen.write("2Jsettled", 2);
      const first = screen.snapshot();
      screen.write(" later", 3);
      const second = screen.snapshot();

      expect((await first).lines[0]).toBe("settled");
      expect((await first).screenVersion).toBe(2);
      expect((await second).lines[0]).toBe("settled later");
      expect((await second).screenVersion).toBe(3);
    } finally {
      screen.dispose();
    }
  });

  it("searches the active viewport with terminal-cell columns and bounded matches", async () => {
    const screen = createScreen();
    try {
      screen.write("A界Needle needle", 1);
      const result = await screen.search({
        caseSensitive: false,
        maxMatches: 1,
        query: "NEEDLE",
      });

      expect(result.truncated).toBe(true);
      expect(result.snapshot.screenVersion).toBe(1);
      expect(result.matches).toEqual([{ endColumn: 9, row: 0, startColumn: 3, text: "Needle" }]);

      screen.write("\u001B[2J\u001B[Hfoo\u001B[10Gbar", 2);
      await expect(
        screen.search({ caseSensitive: true, maxMatches: 5, query: "foobar" }),
      ).resolves.toMatchObject({ matches: [] });
      await expect(
        screen.search({ caseSensitive: true, maxMatches: 5, query: "foo      bar" }),
      ).resolves.toMatchObject({
        matches: [{ endColumn: 12, row: 0, startColumn: 0, text: "foo      bar" }],
      });
    } finally {
      screen.dispose();
    }
  });

  it("waits reactively for a parsed version, times out, and supports cancellation", async () => {
    const screen = createScreen();
    try {
      const changed = screen.waitForVersion(0, 500);
      setTimeout(() => screen.write("later", 1), 10);
      expect(await changed).toMatchObject({ screenVersion: 1 });
      await expect(screen.waitForVersion(1, 20)).resolves.toBeUndefined();

      const abortController = new AbortController();
      const aborted = screen.waitForVersion(1, 500, abortController.signal);
      abortController.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      screen.dispose();
    }
  });

  it("reads bounded terminal-cell regions without leaking clipped wide glyphs", async () => {
    const screen = createScreen();
    try {
      screen.write("A界B\r\nsecond", 1);

      await expect(
        screen.region({ columnCount: 3, rowCount: 2, startColumn: 1, startRow: 0 }),
      ).resolves.toMatchObject({
        columnCount: 3,
        frame: { screenVersion: 1 },
        lines: ["界B", "eco"],
        rowCount: 2,
        startColumn: 1,
        startRow: 0,
      });
      await expect(
        screen.region({ columnCount: 2, rowCount: 1, startColumn: 2, startRow: 0 }),
      ).resolves.toMatchObject({ lines: [" B"] });
      await expect(
        screen.region({ columnCount: 2, rowCount: 1, startColumn: 0, startRow: 0 }),
      ).resolves.toMatchObject({ lines: ["A"] });
    } finally {
      screen.dispose();
    }
  });

  it("returns retained row diffs and an explicit full resync outside bounded history", async () => {
    const screen = new XtermScreenProjection(
      { sessionGeneration: 1, sessionId: "screen-test" },
      { historyEntries: 3 },
    );
    try {
      screen.write("alpha\r\nbeta", 1);
      screen.write("\u001B[2;1Hgamma", 2);

      await expect(screen.diff(1)).resolves.toMatchObject({
        afterVersion: 1,
        changedRows: [{ row: 1, text: "gamma" }],
        frame: {
          buffer: "normal",
          cursor: { column: 5, row: 1 },
          screenVersion: 2,
        },
        resyncRequired: false,
      });
      await expect(screen.diff(2)).resolves.toMatchObject({
        afterVersion: 2,
        changedRows: [],
        resyncRequired: false,
      });

      screen.write("\u001B[1;1Hnew", 3);
      screen.write("!", 4);
      await expect(screen.diff(1)).resolves.toMatchObject({
        afterVersion: 1,
        reason: "history_unavailable",
        resyncRequired: true,
        snapshot: { screenVersion: 4 },
      });
      await expect(screen.diff(5)).resolves.toMatchObject({
        afterVersion: 5,
        reason: "future_version",
        resyncRequired: true,
        snapshot: { screenVersion: 4 },
      });
    } finally {
      screen.dispose();
    }
  });

  it("serializes canonical resize, reflows content, and forces cross-geometry resync", async () => {
    const screen = createScreen();
    try {
      screen.write(`before-${"x".repeat(90)}`, 1);
      const waiting = screen.waitForVersion(1, 500);
      const resized = await screen.resize(80, 24, 2);

      expect(resized).toMatchObject({
        columns: 80,
        geometryVersion: 2,
        rows: 24,
        screenVersion: 2,
      });
      expect(resized.lines[0]).toBe(`before-${"x".repeat(73)}`);
      expect(resized.lines[1]).toBe("x".repeat(17));
      await expect(waiting).resolves.toMatchObject({
        columns: 80,
        geometryVersion: 2,
        rows: 24,
        screenVersion: 2,
      });
      await expect(screen.diff(1)).resolves.toMatchObject({
        afterVersion: 1,
        reason: "geometry_changed",
        resyncRequired: true,
        snapshot: {
          columns: 80,
          geometryVersion: 2,
          rows: 24,
          screenVersion: 2,
        },
      });
      await expect(
        screen.region({ columnCount: 1, rowCount: 1, startColumn: 80, startRow: 0 }),
      ).rejects.toThrow("outside the active viewport");
    } finally {
      screen.dispose();
    }
  });

  it("maps styled material cells into stable palette/RGB and SGR metadata", async () => {
    const screen = createScreen();
    try {
      screen.write("\u001B[1;2;3;4;5;7;9;53;38;5;196;48;2;1;2;3mA界 \u001B[8mX\u001B[0mZ", 1);

      const result = await screen.cells({
        columnCount: 6,
        rowCount: 1,
        startColumn: 0,
        startRow: 0,
      });
      const styled = {
        background: { blue: 3, green: 2, mode: "rgb", red: 1 },
        blink: true,
        bold: true,
        dim: true,
        foreground: { index: 196, mode: "palette" },
        inverse: true,
        italic: true,
        overline: true,
        strikethrough: true,
        underline: true,
      };
      expect(result).toMatchObject({
        columnCount: 6,
        frame: { screenVersion: 1 },
        rowCount: 1,
        startColumn: 0,
        startRow: 0,
      });
      expect(result.cells).toEqual([
        { column: 0, row: 0, style: styled, text: "A", width: 1 },
        { column: 1, row: 0, style: styled, text: "界", width: 2 },
        { column: 3, row: 0, style: styled, text: " ", width: 1 },
        {
          column: 4,
          row: 0,
          style: { ...styled, invisible: true },
          text: "",
          width: 1,
        },
        { column: 5, row: 0, style: {}, text: "Z", width: 1 },
      ]);

      expect((await screen.snapshot()).lines[0]).toBe("A界  Z");
      await expect(
        screen.region({ columnCount: 6, rowCount: 1, startColumn: 0, startRow: 0 }),
      ).resolves.toMatchObject({ lines: ["A界  Z"] });
      await expect(screen.diff(0)).resolves.toMatchObject({
        changedRows: [{ row: 0, text: "A界  Z" }],
        resyncRequired: false,
      });
      await expect(
        screen.search({ caseSensitive: true, maxMatches: 5, query: "X" }),
      ).resolves.toMatchObject({ matches: [] });

      await expect(
        screen.cells({ columnCount: 4, rowCount: 1, startColumn: 2, startRow: 0 }),
      ).resolves.toMatchObject({
        cells: [
          { column: 3, text: " ", width: 1 },
          { column: 4, style: { invisible: true }, text: "", width: 1 },
          { column: 5, style: {}, text: "Z", width: 1 },
        ],
      });
    } finally {
      screen.dispose();
    }
  });
});

function createScreen(): XtermScreenProjection {
  return new XtermScreenProjection({ sessionGeneration: 1, sessionId: "screen-test" });
}
