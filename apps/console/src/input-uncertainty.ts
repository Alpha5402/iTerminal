export type InputUncertaintyReason = "untracked_input" | "delivery";

export function describeInputUncertainty(reason: InputUncertaintyReason): string {
  if (reason === "untracked_input") {
    return "Raw Input, Control, or Secret input may have changed the program's line buffer, so line input is temporarily unavailable. Switch to Raw keys, inspect the current Execution, or use the existing guarded interrupt control.";
  }
  return "This Input or Control write may not have reached the PTY. Check the exact Action and do not resend with a new idempotency key to decide whether it arrived.";
}
