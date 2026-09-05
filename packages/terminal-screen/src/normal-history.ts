import type { IMarker, Terminal } from "@xterm/headless";
import { RuntimeError, type TerminalHistoryPage } from "@iterminal/domain";

/** Public xterm markers track retained row offsets; no private parser/buffer API. */
export class NormalBufferHistory {
  #epoch = 1;
  #base = 0;
  #anchor: IMarker | undefined;
  #anchorLine = 0;
  constructor(private readonly terminal: Terminal) {
    this.afterWrite();
  }

  reset(): void {
    this.#epoch += 1;
    this.#base = 0;
    this.#anchor?.dispose();
    this.#anchor = undefined;
    this.afterWrite();
  }

  afterWrite(): void {
    if (this.#anchor !== undefined) {
      if (this.#anchor.isDisposed || this.#anchor.line > this.#anchorLine) {
        // A complete retention-window loss or buffer reflow has no trustworthy old row mapping.
        this.#epoch += 1;
        this.#base = 0;
      } else this.#base += this.#anchorLine - this.#anchor.line;
      if (this.terminal.buffer.active.type === "alternate" && !this.#anchor.isDisposed) {
        this.#anchorLine = this.#anchor.line;
        return;
      }
      this.#anchor.dispose();
      this.#anchor = undefined;
    }
    const buffer = this.terminal.buffer.normal;
    if (this.terminal.buffer.active.type === "normal") {
      this.#anchorLine = Math.max(0, buffer.baseY - 1);
      this.#anchor = this.terminal.registerMarker(this.#anchorLine - buffer.baseY - buffer.cursorY);
    }
  }

  page(
    input: { cursor?: string | undefined; limit?: number | undefined },
    identity: { sessionId: string; sessionGeneration: number; screenVersion: number },
  ): TerminalHistoryPage {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new RuntimeError("INVALID_REQUEST", "History limit must be between 1 and 500");
    const buffer = this.terminal.buffer.normal;
    const end = this.#base + buffer.baseY;
    let before = end;
    let gap = false;
    if (input.cursor !== undefined) {
      if (input.cursor.length > 512)
        throw new RuntimeError("INVALID_REQUEST", "Invalid history cursor");
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      } catch {
        throw new RuntimeError("INVALID_REQUEST", "Invalid history cursor");
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 4 ||
        cursor[0] !== identity.sessionId ||
        cursor[1] !== identity.sessionGeneration ||
        !Number.isSafeInteger(cursor[2]) ||
        !Number.isSafeInteger(cursor[3])
      )
        throw new RuntimeError("INVALID_REQUEST", "History cursor identity is invalid");
      if (cursor[2] !== this.#epoch || (cursor[3] as number) < this.#base) gap = true;
      else before = Math.min(end, cursor[3] as number);
    }
    const lines: TerminalHistoryPage["lines"][number][] = [];
    let bytes = 0;
    for (let line = before - 1; line >= this.#base && lines.length < limit; line--) {
      const row = buffer.getLine(line - this.#base);
      if (row === undefined) break;
      // Invisible cells are blank in both text and copy; no raw terminal escape sequences.
      let text = "";
      for (let column = 0; column < row.length; column++) {
        const cell = row.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.isInvisible() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
      }
      if (!buffer.getLine(line - this.#base + 1)?.isWrapped) text = text.trimEnd();
      const entry = { line, text, wrapped: row.isWrapped };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > 128 * 1024) break;
      bytes += size;
      lines.unshift(entry);
    }
    const firstLine = lines[0]?.line ?? before;
    return {
      ...identity,
      epoch: this.#epoch,
      droppedBefore: this.#base,
      newestLine: end,
      firstLine,
      gap,
      lines,
      retainedLineLimit: this.terminal.options.scrollback ?? 0,
      nextCursor:
        firstLine > this.#base
          ? Buffer.from(
              JSON.stringify([
                identity.sessionId,
                identity.sessionGeneration,
                this.#epoch,
                firstLine,
              ]),
            ).toString("base64url")
          : null,
    };
  }
}
