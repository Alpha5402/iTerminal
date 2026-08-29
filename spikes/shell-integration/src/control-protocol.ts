import { StringDecoder } from "node:string_decoder";

const FIELD_SEPARATOR = "\0";
const MAX_PENDING_BYTES = 1024 * 1024;

export type ControlEvent =
  | Readonly<{ type: "hello"; shell: "bash" | "zsh"; pid: number }>
  | Readonly<{ type: "preexec"; command: string }>
  | Readonly<{ type: "result"; exitCode: number }>
  | Readonly<{ type: "ready"; exitCode: number; cwd: string }>;

const frameFieldCounts: Readonly<Record<string, number>> = {
  HELLO: 3,
  PREEXEC: 3,
  READY: 3,
  RESULT: 3,
};

export class ControlProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlProtocolError";
  }
}

export class ControlFrameDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #pendingText = "";
  #fields: string[] = [];

  public push(chunk: Buffer): ControlEvent[] {
    this.#pendingText += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#pendingText, "utf8") > MAX_PENDING_BYTES) {
      throw new ControlProtocolError("Control frame exceeded the 1 MiB pending-data limit");
    }

    const events: ControlEvent[] = [];
    let separatorIndex = this.#pendingText.indexOf(FIELD_SEPARATOR);

    while (separatorIndex >= 0) {
      const field = this.#pendingText.slice(0, separatorIndex);
      this.#pendingText = this.#pendingText.slice(separatorIndex + FIELD_SEPARATOR.length);
      this.#fields.push(field);

      const expectedFields = frameFieldCounts[this.#fields[0] ?? ""];
      if (expectedFields === undefined) {
        throw new ControlProtocolError(`Unknown control frame type: ${this.#fields[0] ?? ""}`);
      }

      if (this.#fields.length === expectedFields) {
        events.push(parseFrame(this.#fields));
        this.#fields = [];
      }

      separatorIndex = this.#pendingText.indexOf(FIELD_SEPARATOR);
    }

    return events;
  }

  public finish(): void {
    this.#pendingText += this.#decoder.end();
    if (this.#pendingText.length > 0 || this.#fields.length > 0) {
      throw new ControlProtocolError("Control channel ended with a partial frame");
    }
  }
}

function parseFrame(fields: readonly string[]): ControlEvent {
  const [type] = fields;

  if (type === "HELLO") {
    const shell = fields[1];
    const pid = parseInteger(fields[2], "shell pid");
    if (shell !== "bash" && shell !== "zsh") {
      throw new ControlProtocolError(`Unsupported shell in HELLO frame: ${shell ?? ""}`);
    }
    return { type: "hello", shell, pid };
  }

  if (type === "PREEXEC") {
    return { type: "preexec", command: fields[1] ?? "" };
  }

  if (type === "READY") {
    return {
      type: "ready",
      exitCode: parseInteger(fields[1], "exit code"),
      cwd: fields[2] ?? "",
    };
  }

  if (type === "RESULT") {
    return {
      type: "result",
      exitCode: parseInteger(fields[1], "exit code"),
    };
  }

  throw new ControlProtocolError(`Unhandled control frame type: ${type ?? ""}`);
}

function parseInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new ControlProtocolError(`Invalid ${label}: ${value ?? ""}`);
  }
  return Number.parseInt(value, 10);
}
