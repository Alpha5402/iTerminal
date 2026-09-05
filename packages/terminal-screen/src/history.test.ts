import { expect, it } from "vitest";
import { XtermScreenProjection } from "./index.js";

it("pages canonical history across appends and explicitly invalidates reflow/eviction cursors", async () => {
  const screen = new XtermScreenProjection(
    { sessionId: "history", sessionGeneration: 1 },
    { scrollbackLines: 30 },
  );
  try {
    await screen.resize(40, 12, 1);
    screen.write(Array.from({ length: 30 }, (_, i) => `row-${i}\r\n`).join(""), 2);
    const first = await screen.history({ limit: 5 });
    expect(first.retainedLineLimit).toBe(30);
    expect(first.lines.map((row) => row.text)).toEqual([
      "row-14",
      "row-15",
      "row-16",
      "row-17",
      "row-18",
    ]);
    screen.write("row-30\r\nrow-31\r\n", 3);
    const second = await screen.history({ limit: 5, cursor: first.nextCursor! });
    expect(second.gap).toBe(false);
    expect(second.lines.map((row) => row.line)).toEqual([9, 10, 11, 12, 13]);
    screen.write("\u001b[?1049hFULL SCREEN\u001b[?1049l", 4);
    const normal = await screen.history({ limit: 5, cursor: first.nextCursor! });
    expect(normal.lines).toEqual(second.lines);
    screen.write(Array.from({ length: 100 }, (_, i) => `later-${i}\r\n`).join(""), 5);
    expect((await screen.history({ cursor: first.nextCursor! })).gap).toBe(true);
    await screen.resize(50, 12, 6);
    expect((await screen.history({ cursor: first.nextCursor! })).gap).toBe(true);
    await expect(screen.history({ limit: 501 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally {
    screen.dispose();
  }
});

it("shares same-version cell capture while returning independent frames and observing subsequent writes", async () => {
  const screen = new XtermScreenProjection({ sessionId: "frame-cache", sessionGeneration: 1 });
  try {
    screen.write("\u001b[31mred", 1);
    const [first, second] = await Promise.all([screen.consoleFrame(), screen.consoleFrame()]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // A consumer cannot mutate the cached frame used by a different observer.
    (first.cells[0]!.style as { bold: boolean }).bold = true;
    expect((await screen.consoleFrame()).cells[0]!.style.bold).not.toBe(true);
    screen.write("\u001b[32mgreen", 2);
    expect((await screen.consoleFrame()).screenVersion).toBe(2);
    expect((await screen.consoleFrame()).lines[0]).toContain("redgreen");
    expect(second.screenVersion).toBe(1);
  } finally {
    screen.dispose();
  }
});

it("pages every retained row once and preserves wide soft-wrap copy without invisible text", async () => {
  const screen = new XtermScreenProjection(
    { sessionId: "history-copy", sessionGeneration: 3 },
    { scrollbackLines: 30 },
  );
  try {
    await screen.resize(40, 12, 1);
    const content = "中文".repeat(15) + "🙂é";
    screen.write(
      content +
        "\r\n\u001b[8mSECRET\u001b[0mvisible\r\n" +
        Array.from({ length: 20 }, (_, i) => `tail-${i}\r\n`).join(""),
      2,
    );
    let page = await screen.history({ limit: 3 });
    let rows = [...page.lines];
    while (page.nextCursor) {
      page = await screen.history({ limit: 3, cursor: page.nextCursor });
      expect(page.gap).toBe(false);
      rows = [...page.lines, ...rows];
    }
    expect(new Set(rows.map((row) => row.line)).size).toBe(rows.length);
    expect(rows.map((row) => row.line)).toEqual(Array.from({ length: rows.length }, (_, i) => i));
    const copied = rows
      .map((row, i) => `${i === 0 || row.wrapped ? "" : "\n"}${row.text}`)
      .join("");
    expect(copied).toContain(content + "\n      visible");
    expect(copied).not.toContain("SECRET");
    const foreign = Buffer.from(JSON.stringify(["another-session", 3, page.epoch, 5])).toString(
      "base64url",
    );
    await expect(screen.history({ cursor: foreign })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  } finally {
    screen.dispose();
  }
});
