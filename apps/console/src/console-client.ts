export interface ApiErrorBody {
  readonly allowedNextActions: readonly string[];
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
}

export async function api<T = unknown>(
  path: string,
  options: {
    readonly body?: unknown;
    readonly method?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      "x-iterminal-request": "console",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = (await response.json()) as
    { readonly result: T } | { readonly error: ApiErrorBody };
  if (!response.ok || "error" in payload) {
    throw "error" in payload
      ? new ConsoleApiError(payload.error)
      : new Error(`HTTP ${response.status.toString()}`);
  }
  return payload.result;
}

export function normalizeClientError(reason: unknown): ApiErrorBody {
  if (reason instanceof ConsoleApiError) return reason.body;
  if (isApiError(reason)) return reason;
  return {
    allowedNextActions: ["refresh_session", "inspect_timeline"],
    code: "CLIENT_ERROR",
    details: {},
    message: reason instanceof Error ? reason.message : String(reason),
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

function isApiError(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "requestId" in value
  );
}

export class ConsoleApiError extends Error {
  public constructor(public readonly body: ApiErrorBody) {
    super(body.message);
  }
}
