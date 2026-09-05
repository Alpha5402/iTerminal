import type { Actor, InputAction } from "./model.js";
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS } from "./model.js";

export const TERMINAL_RESPONSE_ACTOR: Actor = Object.freeze({
  id: "system_terminal_response",
  type: "system",
  principal: "runtime-terminal",
  client: "canonical-terminal-parser",
  capabilities: Object.freeze(["terminal.input"] as const),
});

export interface TerminalCursorResponse {
  readonly kind: "cursor_position";
  readonly data: string;
  readonly sourceScreenVersion: number;
}

export function isCursorPositionResponse(data: string): boolean {
  if (!data.startsWith("\x1b")) return false;
  const match = /^\[([1-9][0-9]{0,2});([1-9][0-9]{0,2})R$/u.exec(data.slice(1));
  return (
    match !== null &&
    Number(match[1]) <= MAX_TERMINAL_ROWS &&
    Number(match[2]) <= MAX_TERMINAL_COLUMNS + 1
  );
}

export function isTerminalResponseAction(action: InputAction): boolean {
  const provenance = action.terminalResponse;
  return (
    provenance?.kind === "cursor_position" &&
    Number.isSafeInteger(provenance.sourceScreenVersion) &&
    provenance.sourceScreenVersion > 0 &&
    isCursorPositionResponse(action.data) &&
    action.actor.id === TERMINAL_RESPONSE_ACTOR.id &&
    action.actor.type === "system" &&
    action.actor.principal === TERMINAL_RESPONSE_ACTOR.principal &&
    action.actor.client === TERMINAL_RESPONSE_ACTOR.client &&
    action.actor.capabilities.length === 1 &&
    action.actor.capabilities[0] === "terminal.input"
  );
}
