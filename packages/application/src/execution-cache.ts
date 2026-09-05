import type { Execution } from "@iterminal/domain";

interface TransientExecution {
  readonly started: { readonly promise: Promise<void> };
  readonly completion: { readonly promise: Promise<Execution> };
}
/** Promise/cache retention only. RuntimeService still owns the mutable dispatch state. */
export class ExecutionCache<T extends TransientExecution> {
  readonly #states = new Map<string, T>();
  readonly #started = new Map<string, Promise<void>>();
  readonly #completions = new Map<string, Promise<Execution>>();
  get(id: string): T | undefined {
    return this.#states.get(id);
  }
  started(id: string): Promise<void> | undefined {
    return this.#started.get(id);
  }
  completion(id: string): Promise<Execution> | undefined {
    return this.#completions.get(id);
  }
  get sizes() {
    return {
      states: this.#states.size,
      started: this.#started.size,
      completions: this.#completions.size,
    };
  }
  register(id: string, state: T): void {
    this.#states.set(id, state);
    this.#started.set(id, state.started.promise);
    this.#completions.set(id, state.completion.promise);
  }
  release(id: string, state: T): void {
    if (this.#states.get(id) === state) this.#states.delete(id);
    if (this.#started.get(id) === state.started.promise) this.#started.delete(id);
    if (this.#completions.get(id) === state.completion.promise) this.#completions.delete(id);
  }
}
