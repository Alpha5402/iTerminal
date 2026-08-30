import type {
  TerminalScreenProjection,
  TerminalScreenProjectionFactory,
} from "@iterminal/application";
import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  type TerminalScreenSnapshot,
} from "@iterminal/domain";
import { Terminal } from "@xterm/headless";

export { CANONICAL_TERMINAL_COLUMNS, CANONICAL_TERMINAL_ROWS } from "@iterminal/domain";
const DEFAULT_SCROLLBACK_LINES = 5_000;

export class XtermScreenProjectionFactory implements TerminalScreenProjectionFactory {
  public create(input: {
    readonly sessionGeneration: number;
    readonly sessionId: string;
  }): TerminalScreenProjection {
    return new XtermScreenProjection(input);
  }
}

export class XtermScreenProjection implements TerminalScreenProjection {
  readonly #terminal: Terminal;
  #appliedVersion = 0;
  #scheduledVersion = 0;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly identity: {
      readonly sessionGeneration: number;
      readonly sessionId: string;
    },
    options: { readonly scrollbackLines?: number } = {},
  ) {
    const scrollback = options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    if (!Number.isSafeInteger(scrollback) || scrollback < 0) {
      throw new Error("Terminal screen scrollback must be a non-negative integer");
    }
    this.#terminal = new Terminal({
      allowProposedApi: true,
      cols: CANONICAL_TERMINAL_COLUMNS,
      rows: CANONICAL_TERMINAL_ROWS,
      scrollback,
    });
  }

  public write(data: string, screenVersion: number): void {
    if (this.#disposed) return;
    if (!Number.isSafeInteger(screenVersion) || screenVersion <= this.#scheduledVersion) {
      throw new Error("Terminal screen versions must increase monotonically");
    }
    this.#scheduledVersion = screenVersion;
    this.#tail = this.#tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#disposed) {
            resolve();
            return;
          }
          try {
            this.#terminal.write(data, () => {
              this.#appliedVersion = screenVersion;
              resolve();
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    void this.#tail.catch(() => undefined);
  }

  public snapshot(): Promise<TerminalScreenSnapshot> {
    if (this.#disposed) return Promise.reject(new Error("Terminal screen is disposed"));
    const result = this.#tail.then(() => {
      if (this.#disposed) throw new Error("Terminal screen is disposed");
      return this.#capture();
    });
    this.#tail = result.then(() => undefined);
    void this.#tail.catch(() => undefined);
    return result;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminal.dispose();
  }

  #capture(): TerminalScreenSnapshot {
    const active = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = active.getLine(active.viewportY + row);
      lines.push(line?.translateToString(true) ?? "");
    }
    return {
      buffer: active === this.#terminal.buffer.alternate ? "alternate" : "normal",
      columns: this.#terminal.cols,
      cursor: { column: active.cursorX, row: active.cursorY },
      lines,
      rows: this.#terminal.rows,
      screenVersion: this.#appliedVersion,
      sessionGeneration: this.identity.sessionGeneration,
      sessionId: this.identity.sessionId,
    };
  }
}
