import { describe, expect, it } from "vitest";

import { BoundedByteRing } from "./bounded-byte-ring.js";

describe("BoundedByteRing", () => {
  it("rejects invalid capacity and preserves snapshots and borrowed input", () => {
    for (const capacity of [0, -1, 1.5, Infinity]) {
      expect(() => new BoundedByteRing(capacity)).toThrow();
    }
    const ring = new BoundedByteRing(3);
    const source = Buffer.from("abcdef");
    ring.append(source);
    const snapshot = ring.snapshot();
    source.fill(0);
    expect(ring.snapshot().data).toBe("def");
    ring.append("xy");
    expect(snapshot.data).toBe("def");
    expect(ring.snapshot().data).toBe("fxy");
  });

  it("matches byte-tail semantics through randomized wraps and UTF-8 boundaries", () => {
    let seed = 12345;
    for (const capacity of [1, 4, 7, 31, 1024]) {
      const ring = new BoundedByteRing(capacity);
      let reference = Buffer.alloc(0);
      let total = 0;
      for (let i = 0; i < 500; i += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const input = Buffer.from("中文🙂abc".repeat(seed % 5));
        ring.append(input);
        reference = Buffer.concat([reference, input]).subarray(-capacity);
        total += input.length;
        expect(ring.snapshot()).toEqual({
          data: reference.toString("utf8"),
          byteLength: reference.length,
          totalBytes: total,
          truncated: total > reference.length,
        });
      }
    }
  });
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
