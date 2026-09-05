import { describe, expect, it } from "vitest";

import {
  classifyRawTerminalData,
  rawInputBatchCanSend,
  rawInputTargetLabel,
  sameRawInputTarget,
  type RawInputTarget,
} from "./input-mode.js";

const target: RawInputTarget = {
  executionId: "execution-a",
  generation: 2,
  sessionId: "session-a",
};

describe("Console input modes", () => {
  it("routes raw Enter, Tab, arrows and printable text through Input Actions", () => {
    for (const data of ["\r", "\t", "\u001b[A", "\u001b[B", "\u001b[C", "\u001b[D", "中文"]) {
      expect(classifyRawTerminalData(data)).toEqual({ data, kind: "input" });
    }
  });

  it("routes only exact supported terminal controls through Control Actions", () => {
    expect(classifyRawTerminalData("\u0003")).toEqual({ control: "CTRL_C", kind: "control" });
    expect(classifyRawTerminalData("\u0004")).toEqual({ control: "CTRL_D", kind: "control" });
    expect(classifyRawTerminalData("\u001a")).toEqual({ control: "CTRL_Z", kind: "control" });
    expect(classifyRawTerminalData("\u001b")).toEqual({ control: "ESC", kind: "control" });
    expect(classifyRawTerminalData("\u001b[A")).toEqual({ data: "\u001b[A", kind: "input" });
  });

  it("keeps unsupported NUL input observable without forwarding it", () => {
    const nul = classifyRawTerminalData("\0");
    expect(nul.kind).toBe("unsupported");
    if (nul.kind !== "unsupported") throw new Error("NUL unexpectedly became sendable");
    expect(nul.message).toContain("was not sent");
    expect(classifyRawTerminalData("prefix\0suffix")).toMatchObject({ kind: "unsupported" });
    expect(classifyRawTerminalData("")).toMatchObject({ kind: "unsupported" });
  });

  it("compares and labels the complete raw target identity", () => {
    expect(sameRawInputTarget(target, { ...target })).toBe(true);
    expect(sameRawInputTarget(target, { ...target, executionId: "execution-b" })).toBe(false);
    expect(sameRawInputTarget(target, { ...target, generation: 3 })).toBe(false);
    expect(sameRawInputTarget(target, { ...target, sessionId: "session-b" })).toBe(false);
    expect(rawInputTargetLabel(target)).toContain("generation 2, Execution execution-a");
  });

  it("drops a pending raw batch unless mode, focus, armed target, and current target still match", () => {
    const allowed = {
      activeTarget: target,
      armedTarget: target,
      batchTarget: target,
      focused: true,
      rawMode: true,
    } as const;
    expect(rawInputBatchCanSend(allowed)).toBe(true);
    expect(rawInputBatchCanSend({ ...allowed, focused: false })).toBe(false);
    expect(rawInputBatchCanSend({ ...allowed, rawMode: false })).toBe(false);
    expect(
      rawInputBatchCanSend({
        ...allowed,
        activeTarget: { ...target, sessionId: "session-b" },
      }),
    ).toBe(false);
    expect(
      rawInputBatchCanSend({
        ...allowed,
        armedTarget: { ...target, executionId: "execution-b" },
      }),
    ).toBe(false);
  });
});
