import { describe, expect, it } from "vitest";

import { SensitiveOutputSanitizer } from "./sensitive-output-sanitizer.js";

describe("SensitiveOutputSanitizer", () => {
  it("suppresses printable and split control-string content until explicitly finished", () => {
    const sanitizer = new SensitiveOutputSanitizer();
    expect(sanitizer.start()).toContain("sensitive terminal output redacted");
    const observed = [
      sanitizer.push("secret-before\r\n\x1b]0;split-secret"),
      sanitizer.push("-payload\x1b"),
      sanitizer.push("\\secret-after\n"),
    ].join("");
    expect(observed).toBe("");
    expect(observed).not.toContain("secret");
    sanitizer.finish();
    expect(sanitizer.push("visible-after")).toBe("visible-after");
  });

  it("fails closed for nested activation and incomplete escape syntax", () => {
    const sanitizer = new SensitiveOutputSanitizer();
    sanitizer.start();
    expect(() => sanitizer.start()).toThrow("already active");
    expect(sanitizer.push("\x1b[31")).toBe("");
    expect(sanitizer.push("mhidden\r")).toBe("");
    sanitizer.finish();
    expect(() => sanitizer.finish()).toThrow("not active");
  });
});
