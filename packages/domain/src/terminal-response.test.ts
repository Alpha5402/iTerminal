import { describe, expect, it } from "vitest";
import {
  isCursorPositionResponse,
  isTerminalResponseAction,
  TERMINAL_RESPONSE_ACTOR,
} from "./terminal-response.js";
import type { InputAction } from "./model.js";

describe("bounded terminal response provenance", () => {
  it("accepts only bounded CSI cursor coordinates, not arbitrary terminal control", () => {
    expect(isCursorPositionResponse("\x1b[1;1R")).toBe(true);
    expect(isCursorPositionResponse("\x1b[100;241R")).toBe(true);
    for (const data of [
      "\x1b[0;1R",
      "\x1b[101;1R",
      "\x1b[1;242R",
      "\x1b[1;1R\r",
      "\x1b]52;c;secret\x07",
      "rm -rf /",
      "\x1b[?1;2R",
      "[1;1R",
    ])
      expect(isCursorPositionResponse(data)).toBe(false);
  });
  it("requires exact service identity, explicit provenance, and valid bytes", () => {
    const action: InputAction = {
      id: "action",
      sessionId: "session",
      sessionGeneration: 1,
      actionSequence: 1,
      acceptedAt: new Date(0).toISOString(),
      idempotencyKey: "key",
      requestHash: "hash",
      status: "ACCEPTED",
      type: "input",
      targetExecutionId: "execution",
      actor: TERMINAL_RESPONSE_ACTOR,
      data: "\x1b[1;1R",
      terminalResponse: { kind: "cursor_position", sourceScreenVersion: 1 },
    };
    expect(isTerminalResponseAction(action)).toBe(true);
    expect(isTerminalResponseAction({ ...action, data: "secret\r" })).toBe(false);
    expect(isTerminalResponseAction({ ...action, actor: { ...action.actor, type: "human" } })).toBe(
      false,
    );
    expect(
      isTerminalResponseAction({ ...action, actor: { ...action.actor, id: "system-other" } }),
    ).toBe(false);
    expect(
      isTerminalResponseAction({
        ...action,
        terminalResponse: { kind: "cursor_position", sourceScreenVersion: -1 },
      }),
    ).toBe(false);
  });
});
