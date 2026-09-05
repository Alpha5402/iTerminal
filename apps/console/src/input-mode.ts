export type InputMode = "line" | "raw";

export type RawControl = "CTRL_C" | "CTRL_D" | "CTRL_Z" | "ESC";

export interface RawInputTarget {
  readonly executionId: string;
  readonly generation: number;
  readonly sessionId: string;
}

export type RawTerminalDispatch =
  | Readonly<{ readonly control: RawControl; readonly kind: "control" }>
  | Readonly<{ readonly data: string; readonly kind: "input" }>
  | Readonly<{ readonly kind: "unsupported"; readonly message: string }>;

export function classifyRawTerminalData(data: string): RawTerminalDispatch {
  const control = (
    {
      "\u0003": "CTRL_C",
      "\u0004": "CTRL_D",
      "\u001a": "CTRL_Z",
      "\u001b": "ESC",
    } as const
  )[data];
  if (control !== undefined) return { control, kind: "control" };
  if (data === "") return { kind: "unsupported", message: "An empty key batch was not sent." };
  if (data.includes("\0")) {
    return {
      kind: "unsupported",
      message: "NUL input is not supported by the controlled Input Action and was not sent.",
    };
  }
  return { data, kind: "input" };
}

export function sameRawInputTarget(
  left: RawInputTarget | undefined,
  right: RawInputTarget | undefined,
): boolean {
  return (
    left?.sessionId === right?.sessionId &&
    left?.generation === right?.generation &&
    left?.executionId === right?.executionId
  );
}

export function rawInputBatchCanSend(options: {
  readonly activeTarget: RawInputTarget | undefined;
  readonly armedTarget: RawInputTarget | undefined;
  readonly batchTarget: RawInputTarget;
  readonly focused: boolean;
  readonly rawMode: boolean;
}): boolean {
  return (
    options.rawMode &&
    options.focused &&
    sameRawInputTarget(options.activeTarget, options.batchTarget) &&
    sameRawInputTarget(options.armedTarget, options.batchTarget)
  );
}

export function rawInputTargetLabel(target: RawInputTarget | undefined): string {
  return target === undefined
    ? "no active Execution"
    : `Session ${target.sessionId}, generation ${target.generation.toString()}, Execution ${target.executionId}`;
}
