import { describe, expect, it } from "vitest";
import { deliveredInputState, validateLineInput } from "./input-context.js";

describe("explicit foreground line input contract", () => {
  const versions = { expectedInputVersion: 0, expectedInteractionVersion: 1 };
  it("accepts exactly one printable Unicode line, not raw keys or multiline/coordinate actions", () => {
    expect(() => validateLineInput("/miner 状态\n", versions)).not.toThrow();
    for (const data of [
      "",
      "\n",
      "x",
      "x\r\n",
      "x\ny\n",
      "\u001b[A\n",
      "x\t\n",
      "x\u0003\n",
      "x\u009b\n",
      "x\u2028y\n",
    ]) {
      expect(() => validateLineInput(data, versions)).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(() => validateLineInput("x\n", versions, 1)).toThrow();
    expect(() => validateLineInput("x\n", { ...versions, expectedInputVersion: -1 })).toThrow();
  });
  it("retains pending input and never clears unknown based on output or subsequent Enter", () => {
    expect(deliveredInputState("clear", "中文")).toBe("pending");
    expect(deliveredInputState("pending", "")).toBe("pending");
    expect(deliveredInputState("pending", "\r")).toBe("clear");
    expect(deliveredInputState("clear", "first\nsecond")).toBe("pending");
    for (const data of ["\u001b[A", "\t", "\u0003\n"]) {
      expect(deliveredInputState("clear", data)).toBe("unknown");
    }
    for (const data of ["\b", "\u007f", "text\u007f"]) {
      expect(deliveredInputState("clear", data)).toBe("pending");
      expect(deliveredInputState("pending", `${data}\r`)).toBe("clear");
    }
    expect(deliveredInputState("unknown", "done\n")).toBe("unknown");
  });
});
