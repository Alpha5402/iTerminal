import { describe, expect, it } from "vitest";

import { BoundedByteRing } from "./bounded-byte-ring.js";

describe("BoundedByteRing", () => {
  it("retains only the newest bytes and reports truncation", () => {
    const ring = new BoundedByteRing(8);
    ring.append("12345");
    ring.append("67890");

    expect(ring.snapshot()).toEqual({
      byteLength: 8,
      data: "34567890",
      totalBytes: 10,
      truncated: true,
    });
  });
});
