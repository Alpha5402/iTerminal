import { createInterface } from "node:readline";

import { RuntimeService } from "@iterminal/application";
import type { Actor, ActorCapability, ControlDelivery, ShellKind } from "@iterminal/domain";
import { ACTOR_CAPABILITIES, RuntimeError, isCanonicalActorCapabilities } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";

const runtime = new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory());
const input = createInterface({ input: process.stdin, terminal: false });
let requestChain = Promise.resolve();

process.stderr.write("iTerminal M1 JSONL CLI ready; one JSON request per line\n");

input.on("line", (line) => {
  requestChain = requestChain.then(async () => handleLine(line));
});

input.on("close", () => {
  void requestChain.finally(async () => closeAll());
});

process.on("SIGINT", () => {
  void closeAll().then(() => process.exit(130));
});

async function handleLine(line: string): Promise<void> {
  let request: Record<string, unknown> = {};
  try {
    request = asRecord(JSON.parse(line));
    const result = await dispatch(request);
    write({ ok: true, requestId: requestId(request), result });
  } catch (error) {
    if (error instanceof RuntimeError) {
      write({
        error: {
          code: error.code,
          details: error.details,
          message: error.message,
          retryable: error.retryable,
        },
        ok: false,
        requestId: requestId(request ?? {}),
      });
      return;
    }
    write({
      error: { code: "INTERNAL", message: errorMessage(error), retryable: false },
      ok: false,
      requestId: requestId(request ?? {}),
    });
  }
}

async function dispatch(request: Record<string, unknown>): Promise<unknown> {
  const op = stringField(request, "op");
  if (op === "create") {
    return runtime.createSession({
      idempotencyKey: stringField(request, "idempotencyKey"),
      shell: shellField(request, "shell"),
      workspaceRoot: stringField(request, "workspaceRoot"),
    });
  }
  if (op === "status") {
    return runtime.getSession(stringField(request, "sessionId"));
  }
  if (op === "execute") {
    const started = await runtime.startExecute({
      actor: actorField(request),
      command: stringField(request, "command"),
      idempotencyKey: stringField(request, "idempotencyKey"),
      sessionGeneration: numberField(request, "sessionGeneration"),
      sessionId: stringField(request, "sessionId"),
    });
    return { action: started.action, execution: started.execution };
  }
  if (op === "wait") {
    return runtime.waitExecution(stringField(request, "executionId"));
  }
  if (op === "input") {
    const expectedScreenVersion = optionalNumberField(request, "expectedScreenVersion");
    return runtime.sendInput({
      actor: actorField(request),
      data: stringField(request, "data"),
      idempotencyKey: stringField(request, "idempotencyKey"),
      sessionGeneration: numberField(request, "sessionGeneration"),
      sessionId: stringField(request, "sessionId"),
      targetExecutionId: stringField(request, "targetExecutionId"),
      ...(expectedScreenVersion === undefined ? {} : { expectedScreenVersion }),
    });
  }
  if (op === "control") {
    return runtime.sendControl({
      actor: actorField(request),
      delivery: controlField(request),
      idempotencyKey: stringField(request, "idempotencyKey"),
      sessionGeneration: numberField(request, "sessionGeneration"),
      sessionId: stringField(request, "sessionId"),
      targetExecutionId: stringField(request, "targetExecutionId"),
    });
  }
  if (op === "events") {
    return runtime.queryEvents(
      stringField(request, "sessionId"),
      numberField(request, "generation"),
      optionalNumberField(request, "after") ?? 0,
      optionalNumberField(request, "limit") ?? 100,
    );
  }
  if (op === "close") {
    return runtime.closeSession(
      stringField(request, "sessionId"),
      numberField(request, "generation"),
    );
  }
  if (op === "list") {
    return runtime.listSessions();
  }
  throw new RuntimeError("INVALID_REQUEST", `Unsupported CLI operation: ${op}`);
}

async function closeAll(): Promise<void> {
  for (const session of runtime.listSessions()) {
    if (session.status !== "CLOSED") {
      await runtime.closeSession(session.id, session.generation);
    }
  }
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requestId(request: Record<string, unknown>): string {
  return typeof request.requestId === "string" ? request.requestId : "unassigned";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeError("INVALID_REQUEST", "Request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new RuntimeError("INVALID_REQUEST", `${key} must be a string`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RuntimeError("INVALID_REQUEST", `${key} must be a safe integer`);
  }
  return value;
}

function optionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  return record[key] === undefined ? undefined : numberField(record, key);
}

function shellField(record: Record<string, unknown>, key: string): ShellKind {
  const value = stringField(record, key);
  if (value !== "bash" && value !== "zsh") {
    throw new RuntimeError("INVALID_REQUEST", `${key} must be bash or zsh`);
  }
  return value;
}

function actorField(record: Record<string, unknown>): Actor {
  const actor = asRecord(record.actor);
  const type = stringField(actor, "type");
  if (type !== "human" && type !== "agent" && type !== "scheduler" && type !== "system") {
    throw new RuntimeError("INVALID_REQUEST", "actor.type is invalid");
  }
  const capabilities = arrayField(actor, "capabilities");
  if (
    !capabilities.every(
      (capability): capability is ActorCapability =>
        typeof capability === "string" &&
        ACTOR_CAPABILITIES.includes(capability as ActorCapability),
    ) ||
    !isCanonicalActorCapabilities(capabilities)
  ) {
    throw new RuntimeError("INVALID_REQUEST", "actor.capabilities must be canonical");
  }
  return {
    capabilities,
    client: stringField(actor, "client"),
    id: stringField(actor, "id"),
    principal: stringField(actor, "principal"),
    type,
  };
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new RuntimeError("INVALID_REQUEST", `${key} must be an array`);
  }
  return value;
}

function controlField(record: Record<string, unknown>): ControlDelivery {
  const delivery = asRecord(record.delivery);
  const mode = stringField(delivery, "mode");
  if (mode === "TTY_CONTROL") {
    const control = stringField(delivery, "control");
    if (control !== "CTRL_C" && control !== "CTRL_D" && control !== "CTRL_Z" && control !== "ESC") {
      throw new RuntimeError("INVALID_REQUEST", "Unsupported TTY control");
    }
    return { control, mode };
  }
  if (mode === "PROCESS_SIGNAL") {
    const signal = stringField(delivery, "signal");
    if (
      signal !== "SIGINT" &&
      signal !== "SIGTERM" &&
      signal !== "SIGKILL" &&
      signal !== "SIGTSTP" &&
      signal !== "SIGCONT"
    ) {
      throw new RuntimeError("INVALID_REQUEST", "Unsupported process signal");
    }
    return { mode, signal };
  }
  throw new RuntimeError("INVALID_REQUEST", "delivery.mode is invalid");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
