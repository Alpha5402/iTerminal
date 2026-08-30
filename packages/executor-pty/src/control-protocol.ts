import { StringDecoder } from "node:string_decoder";

const FIELD_SEPARATOR = "\0";
const MAX_PENDING_BYTES = 1024 * 1024;

export type ControlEvent =
  | Readonly<{ type: "hello"; shell: "bash" | "zsh"; pid: number }>
  | Readonly<{ type: "preexec"; command: string }>
  | Readonly<{ type: "result"; exitCode: number }>
  | Readonly<{
      type: "ready";
      exitCode: number;
      cwd: string;
      filteredEnvironment: Readonly<Record<string, string>>;
    }>;

const frameFieldCounts: Readonly<Record<string, number>> = {
  HELLO: 4,
  PREEXEC: 4,
  READY: 4,
  RESULT: 4,
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
      this.#fields.push(this.#pendingText.slice(0, separatorIndex));
      this.#pendingText = this.#pendingText.slice(separatorIndex + 1);
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
}

function parseFrame(fields: readonly string[]): ControlEvent {
  const type = fields[0];
  if (type === "HELLO") {
    const shell = fields[1];
    if (shell !== "bash" && shell !== "zsh") {
      throw new ControlProtocolError(`Unsupported shell: ${shell ?? ""}`);
    }
    return { pid: parseInteger(fields[2], "shell pid"), shell, type: "hello" };
  }
  if (type === "PREEXEC") {
    return { command: fields[1] ?? "", type: "preexec" };
  }
  if (type === "RESULT") {
    return { exitCode: parseInteger(fields[1], "exit code"), type: "result" };
  }
  if (type === "READY") {
    return {
      cwd: fields[2] ?? "",
      exitCode: parseInteger(fields[1], "exit code"),
      filteredEnvironment: parseFilteredEnvironment(fields[3] ?? ""),
      type: "ready",
    };
  }
  throw new ControlProtocolError(`Unhandled frame: ${type ?? ""}`);
}

function parseFilteredEnvironment(payload: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  if (payload === "") return environment;
  const records = payload.split("\n");
  if (records.length > 32) {
    throw new ControlProtocolError("Checkpoint environment exceeded 32 entries");
  }
  for (const record of records) {
    if (record === "") continue;
    const separator = record.indexOf("=");
    const key = separator < 0 ? "" : record.slice(0, separator);
    const encoded = separator < 0 ? "" : record.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) {
      throw new ControlProtocolError("Invalid checkpoint environment record");
    }
    if (Object.hasOwn(environment, key)) {
      throw new ControlProtocolError(`Duplicate checkpoint environment key: ${key}`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 4_096 || bytes.toString("base64") !== encoded) {
      throw new ControlProtocolError(`Invalid checkpoint environment value for ${key}`);
    }
    const value = bytes.toString("utf8");
    if (
      value.includes("\0") ||
      value.includes("\n") ||
      Buffer.from(value).length !== bytes.length
    ) {
      throw new ControlProtocolError(`Unsafe checkpoint environment value for ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

function parseInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new ControlProtocolError(`Invalid ${label}: ${value ?? ""}`);
  }
  return Number.parseInt(value, 10);
}
