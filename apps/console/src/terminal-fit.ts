export interface TerminalGeometry {
  readonly columns: number;
  readonly rows: number;
}

export interface GeometryBounds {
  readonly minColumns: number;
  readonly maxColumns: number;
  readonly minRows: number;
  readonly maxRows: number;
}

export function fittedGeometry(
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  bounds: GeometryBounds,
): TerminalGeometry | undefined {
  if (![width, height, cellWidth, cellHeight].every((value) => Number.isFinite(value) && value > 0))
    return undefined;
  return {
    columns: Math.max(
      bounds.minColumns,
      Math.min(bounds.maxColumns, Math.floor(width / cellWidth)),
    ),
    rows: Math.max(bounds.minRows, Math.min(bounds.maxRows, Math.floor(height / cellHeight))),
  };
}

export interface FitObservation {
  readonly scope: string;
  readonly version: number;
  readonly current: TerminalGeometry;
  readonly desired: TerminalGeometry;
}

/** Schedules intent, not snapshots. A successful write waits for canonical observation. */
export class ActiveWindowFit {
  private active = false;
  private disposed = false;
  private locked = false;
  private pending = false;
  private sending = false;
  private waiting: FitObservation | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly read: () => FitObservation | undefined,
    private readonly eligible: () => boolean,
    private readonly send: (request: FitObservation) => Promise<void>,
    private readonly failure: (reason: unknown) => "uncertain" | "rejected",
  ) {}

  activate(): void {
    if (this.disposed || this.locked || !this.eligible()) return;
    this.active = true;
    this.layoutChanged();
  }

  suspend(): void {
    this.active = false;
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  layoutChanged(): void {
    if (!this.active || this.disposed || this.locked || !this.eligible()) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 180);
  }

  observe(): void {
    if (this.disposed) return;
    const observation = this.read();
    if (
      this.waiting !== undefined &&
      observation?.scope === this.waiting.scope &&
      observation.version > this.waiting.version
    ) {
      this.waiting = undefined;
    }
    if (this.pending && !this.sending && this.waiting === undefined && this.timer === undefined)
      this.layoutChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.suspend();
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (!this.active || this.disposed || this.locked || !this.eligible()) return;
    if (this.sending || this.waiting !== undefined) return;
    const request = this.read();
    if (request === undefined) return;
    this.pending = false;
    if (
      request.current.columns === request.desired.columns &&
      request.current.rows === request.desired.rows
    )
      return;
    this.sending = true;
    this.waiting = request;
    try {
      await this.send(request);
    } catch (reason) {
      this.waiting = undefined;
      this.suspend();
      if (!this.disposed) this.locked = this.failure(reason) === "uncertain";
    } finally {
      this.sending = false;
      this.observe();
    }
  }
}
