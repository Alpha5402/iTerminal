import type { Execution, Session, TerminalScreenSnapshot } from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import { classifyTerminalState } from "./terminal-state.js";

describe("bounded advisory terminal-state classifier", () => {
  it("lets authoritative READY override spoofed prompt-like screen text", () => {
    const result = classifyTerminalState({
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["Password:", ">>>", "Continue? [y/N]"]),
      session: sessionFixture("READY"),
    });

    expect(result).toMatchObject({
      advisory: true,
      confidence: "high",
      evidence: [{ code: "session.ready", source: "runtime", strength: "fact" }],
      kind: "shell_ready",
      sessionStatus: "READY",
    });
    expect(result.evidence).toHaveLength(1);
  });

  it("classifies a simple REPL command with bounded command and screen signals", () => {
    const session = sessionFixture("RUNNING", "exe-state");
    const result = classifyTerminalState({
      execution: executionFixture(session, "python3 -q"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture([">>>"]),
      session,
    });

    expect(result).toMatchObject({
      confidence: "medium",
      executionId: "exe-state",
      kind: "repl",
    });
    expect(result.evidence.map((item) => item.code)).toEqual([
      "session.running",
      "execution.running",
      "command.repl_family",
      "screen.repl_prompt",
    ]);
    expect(result.limitations).toEqual(
      expect.arrayContaining(["command_may_not_be_foreground", "screen_content_spoofable"]),
    );
  });

  it("keeps password and confirmation screen guesses low-confidence and non-secret", () => {
    const session = sessionFixture("RUNNING", "exe-state");
    const password = classifyTerminalState({
      execution: executionFixture(session, "read value"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["Password:"]),
      session,
    });
    const confirm = classifyTerminalState({
      execution: executionFixture(session, "read answer"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["Continue? [y/N]"]),
      session,
    });

    expect(password).toMatchObject({ confidence: "low", kind: "password" });
    expect(password.limitations).toContain("terminal_echo_mode_unobserved");
    expect(confirm).toMatchObject({ confidence: "low", kind: "confirm" });
    expect(JSON.stringify({ confirm, password })).not.toContain("read answer");
    expect(JSON.stringify({ confirm, password })).not.toContain("Password:");
  });

  it("uses screen-only editor evidence at low confidence and generic monitor running as a fact", () => {
    const session = sessionFixture("RUNNING", "exe-state");
    const editor = classifyTerminalState({
      execution: executionFixture(session, "custom-tui"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["-- INSERT --"], "alternate"),
      session,
    });
    const monitor = classifyTerminalState({
      execution: executionFixture(session, "/usr/bin/top"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["Processes: 123"]),
      session,
    });

    expect(editor).toMatchObject({ confidence: "low", kind: "editor" });
    expect(editor.evidence.map((item) => item.code)).toEqual(
      expect.arrayContaining(["screen.alternate_buffer", "screen.editor_marker"]),
    );
    expect(monitor).toMatchObject({ confidence: "high", kind: "running" });
    expect(monitor.evidence.map((item) => item.code)).toContain("command.monitor_family");
  });

  it("does not call a RESERVED command running or parse composed shell syntax", () => {
    const reserved = sessionFixture("RESERVED", "exe-state");
    const result = classifyTerminalState({
      execution: { ...executionFixture(reserved, "vim file; sleep 30"), status: "DISPATCHING" },
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["~"]),
      session: reserved,
    });
    expect(result).toMatchObject({ confidence: "low", kind: "unknown" });
    expect(result.evidence.map((item) => item.code)).toEqual(["session.reserved"]);

    const running = sessionFixture("RUNNING", "exe-state");
    const composed = classifyTerminalState({
      execution: executionFixture(running, "vim file; sleep 30"),
      observedAt: "2026-08-30T00:00:00.000Z",
      screen: screenFixture(["ordinary output"]),
      session: running,
    });
    expect(composed).toMatchObject({ confidence: "high", kind: "running" });
    expect(composed.evidence.map((item) => item.code)).not.toContain("command.editor_family");
  });
});

function sessionFixture(status: Session["status"], activeExecutionId?: string): Session {
  return {
    actionSequence: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
    eventSequence: 0,
    generation: 1,
    id: "ses-state",
    ownerId: "owner-state",
    screenVersion: 1,
    shell: "zsh",
    status,
    workspaceRoot: "/tmp",
    ...(activeExecutionId === undefined ? {} : { activeExecutionId }),
  };
}

function executionFixture(session: Session, command: string): Execution {
  return {
    actionId: "act-state",
    actor: {
      client: "state-test",
      id: "agent-state",
      principal: "state-test",
      type: "agent",
    },
    command,
    createdAt: "2026-08-30T00:00:00.000Z",
    id: "exe-state",
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "RUNNING",
    version: 1,
  };
}

function screenFixture(
  visibleLines: readonly string[],
  buffer: TerminalScreenSnapshot["buffer"] = "normal",
): TerminalScreenSnapshot {
  const lines = [...visibleLines, ...Array.from({ length: 40 - visibleLines.length }, () => "")];
  return {
    buffer,
    columns: 120,
    cursor: { column: 0, row: Math.max(0, visibleLines.length - 1) },
    geometryVersion: 1,
    lines,
    rows: 40,
    screenVersion: 1,
    sessionGeneration: 1,
    sessionId: "ses-state",
  };
}
