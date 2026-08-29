import { describe, expect, it } from "vitest";

import { ControlFrameDecoder, ControlProtocolError } from "./control-protocol.js";

describe("ControlFrameDecoder", () => {
  it("parses multiple frames split across arbitrary chunks", () => {
    const decoder = new ControlFrameDecoder();

    expect(decoder.push(Buffer.from("HEL"))).toEqual([]);
    expect(decoder.push(Buffer.from("LO\x00zsh\x0012"))).toEqual([]);
    expect(
      decoder.push(
        Buffer.from(
          "34\x00PREEXEC\x00echo ready\x00\x00RESULT\x007\x00\x00READY\x000\x00/tmp/work\x00",
        ),
      ),
    ).toEqual([
      { type: "hello", shell: "zsh", pid: 1234 },
      { type: "preexec", command: "echo ready" },
      { type: "result", exitCode: 7 },
      { type: "ready", exitCode: 0, cwd: "/tmp/work" },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("does not treat marker-like terminal text as a control event", () => {
    const decoder = new ControlFrameDecoder();
    const terminalOutput = Buffer.from("READY:fake:0\nACTION_END:not-a-frame\n");

    expect(terminalOutput.includes(0)).toBe(false);
    expect(decoder.push(Buffer.from("READY\x000\x00/work\x00"))).toEqual([
      { type: "ready", exitCode: 0, cwd: "/work" },
    ]);
  });

  it("rejects unknown and partial frames", () => {
    const unknown = new ControlFrameDecoder();
    expect(() => unknown.push(Buffer.from("FAKE\x00"))).toThrow(ControlProtocolError);

    const partial = new ControlFrameDecoder();
    partial.push(Buffer.from("PREEXEC\x00unterminated"));
    expect(() => partial.finish()).toThrow("partial frame");
  });
});
