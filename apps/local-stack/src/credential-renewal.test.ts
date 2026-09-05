import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLocalCredentials } from "./credentials.js";
import { startCredentialRenewal } from "./credential-renewal.js";

afterEach(() => vi.useRealTimers());

describe("credential renewal lifecycle", () => {
  it("renews repeatedly before expiry and releases its timer on close", async () => {
    vi.useFakeTimers({ now: 0 });
    const refresh = vi.fn(() => Promise.resolve(Date.now() + 10_000));
    const renewal = startCredentialRenewal({ expiresAt: 10_000, refresh });
    await vi.advanceTimersByTimeAsync(16_001);
    expect(refresh).toHaveBeenCalledTimes(2);
    await renewal.close();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off failures across expiry without overlapping refreshes", async () => {
    vi.useFakeTimers({ now: 0 });
    const onFailure = vi.fn();
    const refresh = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockImplementation(() => Promise.resolve(Date.now() + 10_000));
    const renewal = startCredentialRenewal({ expiresAt: 1_000, refresh, onFailure });
    await vi.advanceTimersByTimeAsync(3_800);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(2);
    await renewal.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an active refresh during close without scheduling another", async () => {
    vi.useFakeTimers({ now: 0 });
    let finish!: (expiry: number) => void;
    const refresh = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const renewal = startCredentialRenewal({ expiresAt: 1_000, refresh });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const closed = renewal.close();
    finish(20_000);
    await closed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rechecks wall clock jumps and exposes expiry without accepting stale refresh results", async () => {
    vi.useFakeTimers({ now: 0 });
    let clock = 0;
    const refresh = vi.fn(() => Promise.resolve(clock - 1));
    const renewal = startCredentialRenewal({ expiresAt: 86_400_000, refresh, now: () => clock });
    clock = 86_400_001;
    expect(renewal.status().phase).toBe("expired");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(renewal.status()).toMatchObject({ phase: "expired", failures: 1 });
    await renewal.close();
    expect(renewal.status().phase).toBe("stopped");
  });

  it("does not renew early after a backward wall clock jump", async () => {
    vi.useFakeTimers({ now: 0 });
    let clock = 0;
    const refresh = vi.fn(() => Promise.resolve(clock + 10_000));
    const renewal = startCredentialRenewal({ expiresAt: 10_000, refresh, now: () => clock });
    clock = -100_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).not.toHaveBeenCalled();
    await renewal.close();
  });
});

it("rejects invalid Agent names before creating private files", async () => {
  for (const agentName of ["", "../alpha", "/absolute", "a/b", "a b", "a".repeat(49)]) {
    await expect(
      prepareLocalCredentials({
        agentName,
        repositoryRoot: "/unused",
        runtimeSocketPath: "/unused/runtime.sock",
        stateRoot: "/unused",
      }),
    ).rejects.toThrow("Agent name");
  }
});
