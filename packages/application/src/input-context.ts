import type { InputContext, LineInputPrecondition } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";

// Deliberately not a terminal line editor. Unsupported control bytes remain unknown.
function printable(text: string): boolean {
  return [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029;
  });
}

export function validateLineInput(
  data: string,
  precondition: LineInputPrecondition,
  expectedScreenVersion?: number,
): void {
  if (
    expectedScreenVersion !== undefined ||
    !Number.isSafeInteger(precondition.expectedInputVersion) ||
    precondition.expectedInputVersion < 0 ||
    !Number.isSafeInteger(precondition.expectedInteractionVersion) ||
    precondition.expectedInteractionVersion < 1 ||
    !data.endsWith("\n") ||
    data.length < 2 ||
    !printable(data.slice(0, -1))
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "lineInput requires one printable LF-terminated line and input/interaction versions, without screen CAS",
    );
  }
}

export function deliveredInputState(
  previous: InputContext["state"],
  data: string,
): InputContext["state"] {
  if (previous === "unknown" || !printable(data.replace(/[\r\n\b\u007f]/g, ""))) return "unknown";
  if (data.length === 0) return previous;
  return /[\r\n]$/.test(data) ? "clear" : "pending";
}
