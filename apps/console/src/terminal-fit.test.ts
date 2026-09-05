import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveWindowFit, fittedGeometry, type FitObservation } from "./terminal-fit.js";

const bounds = { minColumns: 40, maxColumns: 240, minRows: 12, maxRows: 100 };

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let state: FitObservation = {
    scope: "session:1",
    version: 1,
    current: { columns: 120, rows: 40 },
    desired: { columns: 100, rows: 60 },
  };
  let eligible = true;
  const send = vi.fn<(request: FitObservation) => Promise<void>>().mockResolvedValue();
  const failure = vi.fn<() => "uncertain" | "rejected">().mockReturnValue("rejected");
  const fit = new ActiveWindowFit(
    () => state,
    () => eligible,
    send,
    failure,
  );
  return {
    fit,
    send,
    failure,
    set: (next: Partial<FitObservation>) => {
      state = { ...state, ...next };
    },
    hide: () => {
      eligible = false;
    },
    tick: () => vi.advanceTimersByTimeAsync(200),
  };
}

describe("active Human window terminal fit", () => {
  it("floors real cell metrics, clamps Runtime bounds, and rejects unmeasured layouts", () => {
    expect(fittedGeometry(980, 1030, 8.1, 15.5, bounds)).toEqual({ columns: 120, rows: 66 });
    expect(fittedGeometry(1, 1, 8, 16, bounds)).toEqual({ columns: 40, rows: 12 });
    expect(fittedGeometry(10000, 10000, 8, 16, bounds)).toEqual({ columns: 240, rows: 100 });
    expect(fittedGeometry(0, 100, 8, 16, bounds)).toBeUndefined();
    expect(fittedGeometry(100, 100, NaN, 16, bounds)).toBeUndefined();
  });

  it("never fits passive observations and debounces explicit activity to the latest layout", async () => {
    const f = fixture();
    f.fit.layoutChanged();
    f.fit.observe();
    await f.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.fit.activate();
    f.set({ desired: { columns: 90, rows: 50 } });
    f.fit.layoutChanged();
    await f.tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ desired: { columns: 90, rows: 50 }, version: 1 }),
    );
    f.set({ version: 2, current: { columns: 90, rows: 50 } });
    f.fit.observe();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("waits for HTTP and canonical acknowledgement before sending later layout intent", async () => {
    const f = fixture();
    let resolve!: () => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    f.fit.activate();
    await f.tick();
    f.set({ desired: { columns: 80, rows: 45 } });
    f.fit.layoutChanged();
    await f.tick();
    resolve();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.set({ version: 2, current: { columns: 100, rows: 60 } });
    f.fit.observe();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0]).toMatchObject({
      version: 2,
      desired: { columns: 80, rows: 45 },
    });
  });

  it("drops hidden, switched, and disposed pending work; equal geometry is a no-op", async () => {
    const f = fixture();
    f.set({ desired: { columns: 120, rows: 40 } });
    f.fit.activate();
    await f.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.set({ desired: { columns: 90, rows: 50 } });
    f.fit.layoutChanged();
    f.hide();
    await f.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.fit.suspend();
    f.fit.dispose();
    f.fit.observe();
    await f.tick();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not retry rejection from snapshots or layout, requiring a fresh interaction", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("GEOMETRY_CHANGED"));
    f.fit.activate();
    await f.tick();
    f.set({ version: 2 });
    f.fit.observe();
    f.fit.layoutChanged();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.fit.activate();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("locks uncertain delivery even on new keyboard activity", async () => {
    const f = fixture();
    f.failure.mockReturnValue("uncertain");
    f.send.mockRejectedValueOnce(new Error("DELIVERY_UNKNOWN"));
    f.fit.activate();
    await f.tick();
    f.fit.activate();
    f.fit.layoutChanged();
    f.fit.observe();
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.failure).toHaveBeenCalledTimes(1);
    f.fit.dispose();
  });

  it("does not follow an old Session request or surface its late error after disposal", async () => {
    const f = fixture();
    let reject!: (reason: Error) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    f.fit.activate();
    await f.tick();
    f.fit.layoutChanged();
    f.fit.dispose();
    f.set({ scope: "another-session:1" });
    reject(new Error("response lost"));
    await f.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.failure).not.toHaveBeenCalled();
  });
});
