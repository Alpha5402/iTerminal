import { RuntimeError } from "@iterminal/domain";
import {
  MAX_EXECUTION_OBSERVATION_TEXT_BYTES,
  MAX_EXECUTION_OBSERVATION_TEXT_SOURCE_BYTES,
} from "./ports.js";
export function executionObservationText(
  contentBase64: string,
  byteLength: number,
): Readonly<{
  readonly text?: string;
  readonly textStatus: "complete" | "unaligned_utf8" | "omitted_for_budget";
}> {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength !== byteLength) {
    throw new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Execution output byte metadata is inconsistent",
      { component: "execution_observation" },
      true,
    );
  }
  if (bytes.byteLength > MAX_EXECUTION_OBSERVATION_TEXT_SOURCE_BYTES) {
    return { textStatus: "omitted_for_budget" };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { textStatus: "unaligned_utf8" };
  }
  const text = [...decoded]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      if (character === "\n" || character === "\r" || character === "\t") return character;
      if (codePoint < 0x20) return String.fromCodePoint(0x2400 + codePoint);
      if (codePoint === 0x7f) return "␡";
      if (codePoint >= 0x80 && codePoint <= 0x9f) {
        return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
      }
      return character;
    })
    .join("");
  if (new TextEncoder().encode(text).byteLength > MAX_EXECUTION_OBSERVATION_TEXT_BYTES) {
    return { textStatus: "omitted_for_budget" };
  }
  return { text, textStatus: "complete" };
}
