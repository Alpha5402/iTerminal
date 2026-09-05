export interface CredentialRenewalStatus {
  readonly phase: "scheduled" | "refreshing" | "retrying" | "expired" | "stopped";
  readonly expiresAt: number;
  readonly failures: number;
}

/** Refresh credentials independently of Runtime/PTY lifetime. One refresh at a time. */
export function startCredentialRenewal(options: {
  expiresAt: number;
  refresh: () => Promise<number>;
  onFailure?: () => void;
  onStatus?: (status: CredentialRenewalStatus) => void;
  now?: () => number;
}): { close(): Promise<void>; status(): CredentialRenewalStatus } {
  const now = options.now ?? Date.now;
  let stopped = false;
  let refreshing = false;
  let expiry = options.expiresAt;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let nextAttempt = 0;
  let publishedPhase: CredentialRenewalStatus["phase"] | undefined;
  const status = (): CredentialRenewalStatus => ({
    phase: stopped
      ? "stopped"
      : now() >= expiry
        ? "expired"
        : refreshing
          ? "refreshing"
          : failures > 0
            ? "retrying"
            : "scheduled",
    expiresAt: expiry,
    failures,
  });
  const publish = () => {
    const current = status();
    if (publishedPhase !== current.phase) {
      publishedPhase = current.phase;
      options.onStatus?.(current);
    }
  };
  const setNextAttempt = () => {
    const remaining = expiry - now();
    const advance = Math.min(300_000, Math.max(100, remaining / 5));
    nextAttempt =
      now() +
      (failures > 0
        ? Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5))
        : Math.max(100, remaining - advance));
  };
  const schedule = () => {
    if (stopped) return;
    publish();
    // Recheck wall-clock expiry at least every 30 seconds, including clock jumps.
    timer = setTimeout(
      () => {
        if (stopped) return;
        if (now() < nextAttempt) {
          schedule();
          return;
        }
        refreshing = true;
        publish();
        pending = Promise.resolve()
          .then(options.refresh)
          .then((next) => {
            if (!Number.isFinite(next) || next <= now())
              throw new Error("Renewal did not extend credential validity");
            expiry = next;
            failures = 0;
          })
          .catch(() => {
            failures += 1;
            options.onFailure?.();
          })
          .finally(() => {
            refreshing = false;
            setNextAttempt();
            schedule();
          });
      },
      Math.min(30_000, Math.max(1, nextAttempt - now())),
    );
    timer.unref();
  };
  setNextAttempt();
  schedule();
  return {
    status,
    async close() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      publish();
    },
  };
}
