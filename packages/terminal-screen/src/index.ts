import type {
  TerminalScreenProjection,
  TerminalScreenProjectionFactory,
} from "@iterminal/application";
import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  type TerminalScreenMatch,
  type TerminalScreenSearchResult,
  type TerminalScreenSnapshot,
} from "@iterminal/domain";
import { Terminal } from "@xterm/headless";

export { CANONICAL_TERMINAL_COLUMNS, CANONICAL_TERMINAL_ROWS } from "@iterminal/domain";
const DEFAULT_SCROLLBACK_LINES = 5_000;

interface VersionWaiter {
  readonly afterVersion: number;
  readonly reject: (error: Error) => void;
  readonly resolve: (snapshot: TerminalScreenSnapshot | undefined) => void;
}

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
  #failure: Error | undefined;
  #tail: Promise<void> = Promise.resolve();
  readonly #versionWaiters = new Set<VersionWaiter>();

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
    if (this.#failure !== undefined) throw this.#failure;
    if (!Number.isSafeInteger(screenVersion) || screenVersion <= this.#scheduledVersion) {
      throw new Error("Terminal screen versions must increase monotonically");
    }
    this.#scheduledVersion = screenVersion;
    this.#tail = this.#tail
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.#disposed) {
              resolve();
              return;
            }
            try {
              this.#terminal.write(data, () => {
                this.#appliedVersion = screenVersion;
                this.#notifyVersionWaiters();
                resolve();
              });
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }),
      )
      .catch((error: unknown) => {
        const failure = asError(error);
        this.#fail(failure);
        throw failure;
      });
    void this.#tail.catch(() => undefined);
  }

  public search(input: {
    readonly caseSensitive: boolean;
    readonly maxMatches: number;
    readonly query: string;
  }): Promise<TerminalScreenSearchResult> {
    if (input.query.length === 0) return Promise.reject(new Error("Screen query cannot be empty"));
    if (!Number.isSafeInteger(input.maxMatches) || input.maxMatches < 1) {
      return Promise.reject(new Error("Screen maxMatches must be a positive integer"));
    }
    return this.#read(() => this.#captureSearch(input));
  }

  public snapshot(): Promise<TerminalScreenSnapshot> {
    return this.#read(() => this.#capture());
  }

  public waitForVersion(
    afterVersion: number,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<TerminalScreenSnapshot | undefined> {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) {
      return Promise.reject(new Error("Screen afterVersion must be a non-negative integer"));
    }
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      return Promise.reject(new Error("Screen wait timeout must be a positive integer"));
    }
    if (signal?.aborted === true) return Promise.reject(abortError());
    const deadline = Date.now() + timeoutMilliseconds;
    let waiter: VersionWaiter | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let onAbort: (() => void) | undefined;
    const result = new Promise<TerminalScreenSnapshot | undefined>((resolve, reject) => {
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
        if (waiter !== undefined) this.#versionWaiters.delete(waiter);
      };
      const resolveWait = (snapshot: TerminalScreenSnapshot | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const rejectWait = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const registration = this.#tail.then(() => {
        this.#assertAvailable();
        if (signal?.aborted === true) {
          rejectWait(abortError());
          return;
        }
        if (this.#appliedVersion > afterVersion) {
          resolveWait(this.#capture());
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolveWait(undefined);
          return;
        }
        waiter = { afterVersion, reject: rejectWait, resolve: resolveWait };
        this.#versionWaiters.add(waiter);
        timer = setTimeout(() => resolveWait(undefined), remaining);
        if (signal !== undefined) {
          onAbort = () => rejectWait(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      this.#tail = registration;
      void registration.catch((error: unknown) => rejectWait(asError(error)));
    });
    return result;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const failure = new Error("Terminal screen is disposed");
    for (const waiter of [...this.#versionWaiters]) waiter.reject(failure);
    this.#terminal.dispose();
  }

  #read<T>(reader: () => T): Promise<T> {
    try {
      this.#assertAvailable();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const result = this.#tail.then(() => {
      this.#assertAvailable();
      return reader();
    });
    this.#tail = result.then(() => undefined);
    void this.#tail.catch((error: unknown) => this.#fail(asError(error)));
    return result;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("Terminal screen is disposed");
    if (this.#failure !== undefined) throw this.#failure;
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const waiter of [...this.#versionWaiters]) waiter.reject(this.#failure);
  }

  #notifyVersionWaiters(): void {
    let snapshot: TerminalScreenSnapshot | undefined;
    for (const waiter of [...this.#versionWaiters]) {
      if (this.#appliedVersion > waiter.afterVersion) {
        snapshot ??= this.#capture();
        waiter.resolve(snapshot);
      }
    }
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

  #captureSearch(input: {
    readonly caseSensitive: boolean;
    readonly maxMatches: number;
    readonly query: string;
  }): TerminalScreenSearchResult {
    const active = this.#terminal.buffer.active;
    const needle = normalizeSearchText(input.query, input.caseSensitive);
    const matches: TerminalScreenMatch[] = [];
    let truncated = false;
    for (let row = 0; row < this.#terminal.rows && !truncated; row += 1) {
      const line = active.getLine(active.viewportY + row);
      if (line === undefined) continue;
      const chunks: Array<{
        readonly chars: string;
        readonly endColumn: number;
        readonly normalizedEnd: number;
        readonly normalizedStart: number;
        readonly startColumn: number;
      }> = [];
      let searchable = "";
      for (let column = 0; column < this.#terminal.cols; column += 1) {
        const cell = line.getCell(column);
        const width = cell?.getWidth() ?? 1;
        if (width === 0) continue;
        const chars = cell?.getChars() || " ";
        const normalized = normalizeSearchText(chars, input.caseSensitive);
        const normalizedStart = searchable.length;
        searchable += normalized;
        chunks.push({
          chars,
          endColumn: column + width,
          normalizedEnd: searchable.length,
          normalizedStart,
          startColumn: column,
        });
      }
      let from = 0;
      for (;;) {
        const index = searchable.indexOf(needle, from);
        if (index < 0) break;
        const end = index + needle.length;
        const overlapping = chunks.filter(
          (chunk) => chunk.normalizedEnd > index && chunk.normalizedStart < end,
        );
        const first = overlapping[0];
        const last = overlapping.at(-1);
        if (first !== undefined && last !== undefined) {
          if (matches.length === input.maxMatches) {
            truncated = true;
            break;
          }
          matches.push({
            endColumn: last.endColumn,
            row,
            startColumn: first.startColumn,
            text: overlapping.map((chunk) => chunk.chars).join(""),
          });
        }
        from = index + Math.max(1, needle.length);
      }
    }
    return { matches, snapshot: this.#capture(), truncated };
  }
}

function normalizeSearchText(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("Screen wait aborted");
  error.name = "AbortError";
  return error;
}
