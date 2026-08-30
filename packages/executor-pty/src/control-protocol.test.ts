import { describe, expect, it } from "vitest";

import { ControlFrameDecoder, ControlProtocolError } from "./control-protocol.js";

describe("Shell checkpoint control frame", () => {
  it("decodes chunked READY facts and bounded allowlisted environment values", () => {
    const decoder = new ControlFrameDecoder();
    const frame = Buffer.from(
      `READY\0${"0"}\0/workspace/packages/web\0LANG=${Buffer.from("C.UTF-8").toString("base64")}\nITERM_M7_SAFE=${Buffer.from("shared").toString("base64")}\0`,
    );

    expect(decoder.push(frame.subarray(0, 11))).toEqual([]);
    expect(decoder.push(frame.subarray(11))).toEqual([
      {
        cwd: "/workspace/packages/web",
        exitCode: 0,
        filteredEnvironment: { ITERM_M7_SAFE: "shared", LANG: "C.UTF-8" },
        type: "ready",
      },
    ]);
  });

  it("rejects malformed checkpoint environment records without returning their value", () => {
    const decoder = new ControlFrameDecoder();
    expect(() =>
      decoder.push(Buffer.from("READY\x000\x00/workspace\x00TOKEN=not-base64\x00")),
    ).toThrow(ControlProtocolError);
  });

  it("rejects duplicate environment keys instead of accepting last-value-wins state", () => {
    const decoder = new ControlFrameDecoder();
    const encoded = Buffer.from("one").toString("base64");
    expect(() =>
      decoder.push(Buffer.from(`READY\x000\x00/workspace\x00LANG=${encoded}\nLANG=${encoded}\x00`)),
    ).toThrow(ControlProtocolError);
  });
});
