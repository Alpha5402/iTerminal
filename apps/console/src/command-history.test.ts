import { describe, expect, it } from "vitest";

import {
  commandHistoryKey,
  CommandHistoryNavigation,
  MAX_COMMAND_HISTORY_CHARACTERS,
  mergeCommandHistory,
  readCommandHistory,
} from "./command-history.js";

const event = (sequence: number, command: string) => ({
  id: `event-${sequence}`,
  sequence,
  actor: { id: "human-a", type: "human" },
  type: "execution.started",
  payload: { observedCommand: command },
});
const history = mergeCommandHistory([], [event(1, "pwd"), event(2, "cd /\npwd")], "human-a");

describe("READY command history", () => {
  it("collects only this Human's started commands, preserving raw multiline text", () => {
    expect(
      mergeCommandHistory(
        [],
        [
          event(1, "pwd"),
          { ...event(2, "output"), type: "terminal.pty_output" },
          { ...event(3, "secret"), type: "sensitive_input.started" },
          { ...event(4, "other"), actor: { id: "human-b", type: "human" } },
          { ...event(5, "agent"), actor: { id: "human-a", type: "agent" } },
          event(6, "cd /\npwd\n"),
        ],
        "human-a",
      ).map((entry) => entry.command),
    ).toEqual(["pwd", "cd /\npwd\n"]);
  });

  it("deduplicates reconnects and consecutive commands, orders by sequence, and bounds storage", () => {
    expect(mergeCommandHistory(history, [event(1, "pwd")], "human-a")).toBe(history);
    expect(
      mergeCommandHistory(history, [event(1, "pwd"), event(3, "cd /\npwd")], "human-a"),
    ).toEqual([history[0], { eventId: "event-3", sequence: 3, command: "cd /\npwd" }]);
    const many = Array.from({ length: 150 }, (_, i) => event(i + 1, `echo ${i}`));
    const bounded = mergeCommandHistory([], many.reverse(), "human-a");
    expect(bounded).toHaveLength(100);
    expect(bounded[0]?.sequence).toBe(51);
    expect(
      mergeCommandHistory(
        [],
        [
          event(1, "x".repeat(40_000)),
          event(2, "y".repeat(40_000)),
          event(3, "z".repeat(MAX_COMMAND_HISTORY_CHARACTERS + 1)),
        ],
        "human-a",
      ).map((entry) => entry.sequence),
    ).toEqual([2]);
  });

  it("restores the draft and keeps a stable navigation snapshot", () => {
    const navigation = new CommandHistoryNavigation();
    expect(navigation.move("newer", "draft", history)).toBeUndefined();
    expect(navigation.move("older", "draft", history)).toBe("cd /\npwd");
    const updated = mergeCommandHistory(history, [event(3, "new command")], "human-a");
    expect(navigation.move("older", "cd /\npwd", updated)).toBe("pwd");
    expect(navigation.move("older", "pwd", updated)).toBe("pwd");
    expect(navigation.move("newer", "pwd", updated)).toBe("cd /\npwd");
    expect(navigation.move("newer", "cd /\npwd", updated)).toBe("draft");
    expect(navigation.move("older", "draft", updated)).toBe("new command");
    navigation.reset();
    expect(navigation.move("newer", "edited command", updated)).toBeUndefined();
  });

  it("isolates actor, Session, and generation and tolerates unavailable or malformed storage", () => {
    const key = commandHistoryKey("human-a", "session-a", 1);
    expect(key).not.toBe(commandHistoryKey("human-b", "session-a", 1));
    expect(key).not.toBe(commandHistoryKey("human-a", "session-b", 1));
    expect(key).not.toBe(commandHistoryKey("human-a", "session-a", 2));
    expect(readCommandHistory({ getItem: () => JSON.stringify(history) }, key)).toEqual(history);
    for (const value of [
      "{",
      "{}",
      '[{"command":1}]',
      JSON.stringify([{ ...history[0], sequence: -1 }]),
    ]) {
      expect(readCommandHistory({ getItem: () => value }, key)).toEqual([]);
    }
    expect(
      readCommandHistory(
        {
          getItem: () => {
            throw new Error("denied");
          },
        },
        key,
      ),
    ).toEqual([]);
  });
});
