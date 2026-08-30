const REDACTION_NOTICE = "\r\n[sensitive terminal output redacted]\r\n";

type ParserState = "normal" | "escape" | "csi" | "control_string" | "control_string_escape";

/** Suppresses every PTY byte while active and tracks split ANSI control syntax across callbacks. */
export class SensitiveOutputSanitizer {
  #active = false;
  #state: ParserState = "normal";

  public get active(): boolean {
    return this.#active;
  }

  public start(): string {
    if (this.#active) throw new Error("Sensitive output redaction is already active");
    this.#active = true;
    this.#state = "normal";
    return REDACTION_NOTICE;
  }

  public finish(): void {
    if (!this.#active) throw new Error("Sensitive output redaction is not active");
    this.#active = false;
    this.#state = "normal";
  }

  public push(data: string): string {
    if (!this.#active) return data;
    for (const character of data) {
      const code = character.codePointAt(0) ?? 0;
      switch (this.#state) {
        case "normal":
          if (character === "\x1b") {
            this.#state = "escape";
          }
          break;
        case "escape":
          if (character === "[") {
            this.#state = "csi";
          } else if (
            character === "]" ||
            character === "P" ||
            character === "X" ||
            character === "^" ||
            character === "_"
          ) {
            this.#state = "control_string";
          } else if (code >= 0x30 && code <= 0x7e) {
            this.#state = "normal";
          }
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) this.#state = "normal";
          break;
        case "control_string":
          if (character === "\x07") {
            this.#state = "normal";
          } else if (character === "\x1b") {
            this.#state = "control_string_escape";
          }
          break;
        case "control_string_escape":
          this.#state =
            character === "\\"
              ? "normal"
              : character === "\x1b"
                ? "control_string_escape"
                : "control_string";
          break;
      }
    }
    return "";
  }
}
