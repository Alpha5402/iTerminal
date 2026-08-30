import { describe, expect, it } from "vitest";

import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  XtermScreenProjection,
} from "./index.js";

describe("XtermScreenProjection", () => {
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
});

function createScreen(): XtermScreenProjection {
  return new XtermScreenProjection({ sessionGeneration: 1, sessionId: "screen-test" });
}
