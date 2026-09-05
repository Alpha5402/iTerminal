import { RuntimeError, type Execution } from "@iterminal/domain";
import type { ExecutionWaitRequest, ExecutionWaitResult, ExecutionWaitScheduler } from "./ports.js";
import { DEFAULT_EXECUTION_WAIT_MILLISECONDS, MAX_EXECUTION_WAIT_MILLISECONDS } from "./ports.js";
interface ExecutionWaiter {
  readonly notify: () => void;
}
export const nativeExecutionWaitScheduler: ExecutionWaitScheduler = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
};
export class ExecutionWaiters {
  readonly #executionWaiters = new Map<string, Set<ExecutionWaiter>>();
  constructor(
    private readonly read: (id: string) => Execution,
    private readonly scheduler: ExecutionWaitScheduler,
  ) {}
  get size(): number {
    let size = 0;
    for (const waiters of this.#executionWaiters.values()) size += waiters.size;
    return size;
  }
  public async wait(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult> {
    const waitMs = validateExecutionWaitMilliseconds(request.waitMs);
    const execution = this.read(request.executionId);
    if (signal?.aborted === true) return Promise.reject(executionWaitAbortError());
    if (waitMs === 0 || isExecutionTerminal(execution.status)) {
      return Promise.resolve(executionWaitResult(execution));
    }

    return new Promise<ExecutionWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: unknown;
      let timerCreated = false;
      const waiters = this.#executionWaiters.get(execution.id) ?? new Set<ExecutionWaiter>();
      const cleanup = (): void => {
        if (timerCreated) this.scheduler.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#executionWaiters.delete(execution.id);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const finish = (): void => {
        if (settled) return;
        try {
          const current = this.read(execution.id);
          settled = true;
          cleanup();
          resolve(executionWaitResult(current));
        } catch (error) {
          fail(error);
        }
      };
      const onAbort = (): void => fail(executionWaitAbortError());
      const waiter: ExecutionWaiter = { notify: finish };

      waiters.add(waiter);
      this.#executionWaiters.set(execution.id, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      try {
        timer = this.scheduler.setTimeout(finish, waitMs);
        timerCreated = true;
        if (settled) this.scheduler.clearTimeout(timer);
      } catch (error) {
        fail(error);
        return;
      }

      // Settlement may race the initial snapshot and waiter registration.
      try {
        if (isExecutionTerminal(this.read(execution.id).status)) finish();
      } catch (error) {
        fail(error);
      }
    });
  }

  notify(executionId: string): void {
    const waiters = this.#executionWaiters.get(executionId);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) waiter.notify();
  }
}
function validateExecutionWaitMilliseconds(value: number | undefined): number {
  const waitMs = value ?? DEFAULT_EXECUTION_WAIT_MILLISECONDS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_EXECUTION_WAIT_MILLISECONDS) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Execution wait must be between 0 and ${MAX_EXECUTION_WAIT_MILLISECONDS.toString()} milliseconds`,
      { waitMs },
    );
  }
  return waitMs;
}

function executionWaitResult(execution: Execution): ExecutionWaitResult {
  return {
    completed: isExecutionTerminal(execution.status),
    executionId: execution.id,
    executionState: execution.status,
  };
}

export function executionWaitAbortError(): Error {
  const error = new Error("Execution wait aborted");
  error.name = "AbortError";
  return error;
}

function isExecutionTerminal(status: Execution["status"]): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "UNKNOWN"
  );
}
