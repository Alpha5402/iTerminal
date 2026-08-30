import type {
  ConsumerInbox,
  ExecutionReadyInspector,
  OutboxRepository,
} from "@iterminal/messaging";
import { RuntimeError } from "@iterminal/domain";
import { operationalErrorMessage } from "@iterminal/observability";

import {
  PostgresMessagingRepository,
  type PostgresMessagingRepositoryOptions,
} from "./postgres-messaging-repository.js";
import { isPostgresEndpointFailure, type PostgresConnectionTarget } from "./postgres-endpoints.js";

export interface PostgresConnectionState {
  readonly attempt: number;
  readonly endpointIndex?: number;
  readonly error?: string;
  readonly retryInMilliseconds?: number;
  readonly state: "CONNECTING" | "CONNECTED" | "DISCONNECTED";
}

export interface PostgresReconnectOptions {
  readonly healthCheckMilliseconds?: number;
  readonly initialDelayMilliseconds?: number;
  readonly jitterRatio?: number;
  readonly maxDelayMilliseconds?: number;
  readonly now?: () => number;
  readonly onConnectionState?: (state: PostgresConnectionState) => void;
  readonly random?: () => number;
}

export interface SupervisedPostgresMessagingOptions
  extends PostgresReconnectOptions, PostgresMessagingRepositoryOptions {}

export class SupervisedPostgresMessagingRepository
  implements OutboxRepository, ConsumerInbox, ExecutionReadyInspector
{
  readonly #abortController = new AbortController();
  readonly #firstAttempt = deferred<void>();
  readonly #options: NormalizedReconnectOptions;
  readonly #readyWaiters = new Set<Deferred<void>>();
  readonly #repository: PostgresMessagingRepository;
  readonly #runPromise: Promise<void>;
  readonly #unavailableWaiters = new Set<Deferred<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #fatalError: Error | undefined;
  #firstAttemptSettled = false;
  #state: PostgresConnectionState = { attempt: 0, state: "CONNECTING" };
  #wake = deferred<void>();

  private constructor(
    connectionString: PostgresConnectionTarget,
    options: SupervisedPostgresMessagingOptions,
  ) {
    this.#options = normalizeReconnectOptions(options);
    this.#repository = new PostgresMessagingRepository(connectionString, {
      ...(options.connectionTimeoutMilliseconds === undefined
        ? {}
        : { connectionTimeoutMilliseconds: options.connectionTimeoutMilliseconds }),
      ...(options.operationTimeoutMilliseconds === undefined
        ? {}
        : { operationTimeoutMilliseconds: options.operationTimeoutMilliseconds }),
    });
    this.#runPromise = this.#run();
    void this.#runPromise.catch(() => undefined);
  }

  public static async start(
    connectionString: PostgresConnectionTarget,
    options: SupervisedPostgresMessagingOptions = {},
  ): Promise<SupervisedPostgresMessagingRepository> {
    const repository = new SupervisedPostgresMessagingRepository(connectionString, options);
    try {
      await repository.#firstAttempt.promise;
      return repository;
    } catch (error) {
      await repository.close().catch(() => undefined);
      throw error;
    }
  }

  public connectionState(): PostgresConnectionState {
    return this.#state;
  }

  public waitUntilConnected(): Promise<void> {
    if (this.#state.state === "CONNECTED") return Promise.resolve();
    if (this.#fatalError !== undefined) return Promise.reject(this.#fatalError);
    if (this.#closed) return Promise.reject(new Error("PostgreSQL repository is closed"));
    const waiter = deferred<void>();
    this.#readyWaiters.add(waiter);
    return waiter.promise;
  }

  public waitUntilDisconnected(): Promise<void> {
    if (this.#state.state !== "CONNECTED" || this.#closed) return Promise.resolve();
    const waiter = deferred<void>();
    this.#unavailableWaiters.add(waiter);
    return waiter.promise;
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  public claimBatch(
    input: Parameters<OutboxRepository["claimBatch"]>[0],
  ): ReturnType<OutboxRepository["claimBatch"]> {
    return this.#call(() => this.#repository.claimBatch(input));
  }

  public markPublished(
    input: Parameters<OutboxRepository["markPublished"]>[0],
  ): ReturnType<OutboxRepository["markPublished"]> {
    return this.#call(() => this.#repository.markPublished(input));
  }

  public releaseFailed(
    input: Parameters<OutboxRepository["releaseFailed"]>[0],
  ): ReturnType<OutboxRepository["releaseFailed"]> {
    return this.#call(() => this.#repository.releaseFailed(input));
  }

  public acquire(
    input: Parameters<ConsumerInbox["acquire"]>[0],
  ): ReturnType<ConsumerInbox["acquire"]> {
    return this.#call(() => this.#repository.acquire(input));
  }

  public complete(
    input: Parameters<ConsumerInbox["complete"]>[0],
  ): ReturnType<ConsumerInbox["complete"]> {
    return this.#call(() => this.#repository.complete(input));
  }

  public release(
    input: Parameters<ConsumerInbox["release"]>[0],
  ): ReturnType<ConsumerInbox["release"]> {
    return this.#call(() => this.#repository.release(input));
  }

  public inspectExecutionReady(
    input: Parameters<ExecutionReadyInspector["inspectExecutionReady"]>[0],
  ): ReturnType<ExecutionReadyInspector["inspectExecutionReady"]> {
    return this.#call(() => this.#repository.inspectExecutionReady(input));
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state.state !== "CONNECTED") throw this.#unavailableError();
    try {
      return await operation();
    } catch (error) {
      if (isPostgresAvailabilityError(error)) {
        this.#disconnect(error);
        throw this.#unavailableError();
      }
      throw error;
    }
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    this.#wake.resolve();
    const closed = new Error("PostgreSQL repository is closed");
    for (const waiter of this.#readyWaiters) waiter.reject(closed);
    this.#readyWaiters.clear();
    for (const waiter of this.#unavailableWaiters) waiter.resolve();
    this.#unavailableWaiters.clear();
    await this.#runPromise.catch(() => undefined);
    await this.#repository.close();
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#abortController.signal.aborted) {
      if (this.#state.state === "CONNECTED") {
        const wake = this.#wake;
        await Promise.race([
          abortableDelay(this.#options.healthCheckMilliseconds, this.#abortController.signal),
          wake.promise,
        ]);
        this.#replaceWake(wake);
        if (this.#abortController.signal.aborted || this.#state.state !== "CONNECTED") continue;
        try {
          await this.#repository.healthCheck();
        } catch (error) {
          this.#disconnect(error);
        }
        continue;
      }

      attempt += 1;
      this.#updateState({
        attempt,
        endpointIndex: this.#repository.databaseEndpointIndex(),
        state: "CONNECTING",
      });
      try {
        await this.#repository.migrate();
        await this.#repository.healthCheck();
        attempt = 0;
        this.#updateState({
          attempt: 0,
          endpointIndex: this.#repository.databaseEndpointIndex(),
          state: "CONNECTED",
        });
        this.#settleFirstAttempt();
      } catch (error) {
        if (!isPostgresAvailabilityError(error)) {
          const failure = new Error(
            operationalErrorMessage(error, "PostgreSQL repository initialization failed"),
          );
          this.#fatalError = failure;
          this.#updateState({
            attempt,
            endpointIndex: this.#repository.databaseEndpointIndex(),
            error: failure.message,
            state: "DISCONNECTED",
          });
          this.#settleFirstAttempt(failure);
          for (const waiter of this.#readyWaiters) waiter.reject(failure);
          this.#readyWaiters.clear();
          return;
        }
        const retryInMilliseconds = reconnectDelay(attempt, this.#options);
        this.#updateState({
          attempt,
          endpointIndex: this.#repository.databaseEndpointIndex(),
          error: operationalErrorMessage(error, "PostgreSQL connection unavailable"),
          retryInMilliseconds,
          state: "DISCONNECTED",
        });
        this.#settleFirstAttempt();
        const wake = this.#wake;
        await Promise.race([
          abortableDelay(retryInMilliseconds, this.#abortController.signal),
          wake.promise,
        ]);
        this.#replaceWake(wake);
      }
    }
  }

  #disconnect(error: unknown): void {
    if (this.#closed || this.#state.state === "DISCONNECTED") return;
    this.#updateState({
      attempt: 1,
      endpointIndex: this.#repository.databaseEndpointIndex(),
      error: operationalErrorMessage(error, "PostgreSQL connection unavailable"),
      retryInMilliseconds: this.#options.initialDelayMilliseconds,
      state: "DISCONNECTED",
    });
    this.#wake.resolve();
  }

  #replaceWake(previous: Deferred<void>): void {
    if (this.#wake === previous) this.#wake = deferred<void>();
  }

  #settleFirstAttempt(error?: Error): void {
    if (this.#firstAttemptSettled) return;
    this.#firstAttemptSettled = true;
    if (error === undefined) this.#firstAttempt.resolve();
    else this.#firstAttempt.reject(error);
  }

  #unavailableError(): RuntimeError {
    return new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "PostgreSQL messaging repository is unavailable",
      {
        databaseState: this.#state.state,
        ...(this.#state.endpointIndex === undefined
          ? {}
          : { endpointIndex: this.#state.endpointIndex }),
        reason: this.#fatalError?.message ?? this.#state.error ?? "connection unavailable",
      },
      true,
    );
  }

  #updateState(state: PostgresConnectionState): void {
    this.#state = state;
    notifyConnectionState(this.#options, state);
    if (state.state === "CONNECTED") {
      for (const waiter of this.#readyWaiters) waiter.resolve();
      this.#readyWaiters.clear();
      return;
    }
    for (const waiter of this.#unavailableWaiters) waiter.resolve();
    this.#unavailableWaiters.clear();
  }
}

export function isPostgresAvailabilityError(error: unknown): boolean {
  if (error instanceof RuntimeError) return error.code === "RUNTIME_UNAVAILABLE";
  if (isPostgresEndpointFailure(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error) {
    const code = String(error.code);
    if (code.startsWith("08") || POSTGRES_AVAILABILITY_CODES.has(code)) return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return POSTGRES_AVAILABILITY_MESSAGES.some((pattern) => message.includes(pattern));
}

const POSTGRES_AVAILABILITY_CODES = new Set([
  "25006",
  "25007",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

const POSTGRES_AVAILABILITY_MESSAGES = [
  "client has already been closed",
  "connection ended unexpectedly",
  "connection is closed",
  "connection terminated unexpectedly",
  "connection terminated due to connection timeout",
  "query read timeout",
  "server closed the connection unexpectedly",
  "terminating connection due to administrator command",
  "timeout exceeded when trying to connect",
];

interface NormalizedReconnectOptions {
  readonly healthCheckMilliseconds: number;
  readonly initialDelayMilliseconds: number;
  readonly jitterRatio: number;
  readonly maxDelayMilliseconds: number;
  readonly now: () => number;
  readonly onConnectionState?: (state: PostgresConnectionState) => void;
  readonly random: () => number;
}

function normalizeReconnectOptions(options: PostgresReconnectOptions): NormalizedReconnectOptions {
  const initialDelayMilliseconds = options.initialDelayMilliseconds ?? 250;
  const maxDelayMilliseconds =
    options.maxDelayMilliseconds ?? Math.max(30_000, initialDelayMilliseconds);
  const healthCheckMilliseconds = options.healthCheckMilliseconds ?? 1_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isSafeInteger(initialDelayMilliseconds) || initialDelayMilliseconds < 1) {
    throw new Error("PostgreSQL reconnect initial delay must be a positive integer");
  }
  if (
    !Number.isSafeInteger(maxDelayMilliseconds) ||
    maxDelayMilliseconds < initialDelayMilliseconds
  ) {
    throw new Error(
      "PostgreSQL reconnect maximum delay must be an integer not below the initial delay",
    );
  }
  if (!Number.isSafeInteger(healthCheckMilliseconds) || healthCheckMilliseconds < 1) {
    throw new Error("PostgreSQL health-check interval must be a positive integer");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("PostgreSQL reconnect jitter ratio must be between zero and one");
  }
  return {
    healthCheckMilliseconds,
    initialDelayMilliseconds,
    jitterRatio,
    maxDelayMilliseconds,
    now: options.now ?? Date.now,
    ...(options.onConnectionState === undefined
      ? {}
      : { onConnectionState: options.onConnectionState }),
    random: options.random ?? Math.random,
  };
}

function reconnectDelay(attempt: number, options: NormalizedReconnectOptions): number {
  const exponential = Math.min(
    options.maxDelayMilliseconds,
    options.initialDelayMilliseconds * 2 ** Math.max(0, Math.min(attempt - 1, 20)),
  );
  const jitter = exponential * options.jitterRatio * (options.random() * 2 - 1);
  return Math.max(1, Math.round(exponential + jitter));
}

function notifyConnectionState(
  options: NormalizedReconnectOptions,
  state: PostgresConnectionState,
): void {
  try {
    options.onConnectionState?.(state);
  } catch {
    // Diagnostics must not change database recovery behavior.
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
