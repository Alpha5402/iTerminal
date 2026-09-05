import { describe, expect, it } from "vitest";

import { describeInputUncertainty } from "./input-uncertainty.js";

describe("input uncertainty explanations", () => {
  it("distinguishes untracked program input from uncertain delivery", () => {
    const untracked = describeInputUncertainty("untracked_input");
    const delivery = describeInputUncertainty("delivery");
    expect(untracked).toContain("Raw Input, Control, or Secret input");
    expect(untracked).toContain("Switch to Raw keys");
    expect(delivery).toContain("may not have reached the PTY");
    expect(delivery).toContain("do not resend with a new idempotency key");
    expect(untracked).not.toContain("known");
    expect(delivery).not.toContain("known");
  });
});
