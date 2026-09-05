import { describe, expect, it } from "vitest";

import {
  dismissSessionTab,
  readDismissedTabs,
  selectedSessionTab,
  sessionTabKey,
  visibleSessionTabs,
} from "./session-tabs.js";

const tabs = [
  { id: "a", generation: 1, status: "BROKEN" },
  { id: "b", generation: 1, status: "READY" },
  { id: "c", generation: 1, status: "RUNNING" },
] as const;

describe("Session tab lifecycle", () => {
  it("hides closed history and dismissed exact generations, not a replacement", () => {
    const dismissed = dismissSessionTab([], tabs[0]);
    expect(
      visibleSessionTabs(
        [...tabs, { ...tabs[0], generation: 2 }, { id: "d", generation: 1, status: "CLOSED" }],
        dismissed,
      ).map(sessionTabKey),
    ).toEqual([sessionTabKey(tabs[1]), sessionTabKey(tabs[2]), '["a",2]']);
    expect(tabs[0].status).toBe("BROKEN");
  });

  it("keeps the selected tab when a background tab disappears", () => {
    expect(selectedSessionTab("b", tabs, tabs.slice(1))).toBe("b");
  });

  it("selects the next neighbor, then the previous, then no tab", () => {
    expect(selectedSessionTab("b", tabs, [tabs[0], tabs[2]])).toBe("c");
    expect(selectedSessionTab("c", tabs, tabs.slice(0, 2))).toBe("b");
    expect(selectedSessionTab("b", tabs, [])).toBeUndefined();
    expect(selectedSessionTab(undefined, [], tabs)).toBe("a");
  });

  it("restores dismissal metadata after refresh and deduplicates repeated closes", () => {
    const dismissed = dismissSessionTab(dismissSessionTab([], tabs[0]), tabs[0]);
    const restored = readDismissedTabs({ getItem: () => JSON.stringify(dismissed) });
    expect(restored).toHaveLength(1);
    expect(visibleSessionTabs(tabs, restored)).toEqual(tabs.slice(1));
  });

  it("tolerates unavailable or malformed browser storage", () => {
    for (const raw of [null, "{", "{}", '"text"', "[]", "[null,12,{}]"]) {
      expect(readDismissedTabs({ getItem: () => raw })).toEqual([]);
    }
    expect(
      readDismissedTabs({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toEqual([]);
    expect(readDismissedTabs({ getItem: () => " ".repeat(1_024 * 1_024 + 1) })).toEqual([]);
  });

  it("bounds stored metadata", () => {
    const prior = Array.from({ length: 2_000 }, (_, index) => `old-${index.toString()}`);
    const dismissed = dismissSessionTab(prior, tabs[0]);
    expect(dismissed).toHaveLength(2_000);
    expect(dismissed[0]).toBe("old-1");
    expect(dismissed.at(-1)).toBe(sessionTabKey(tabs[0]));
  });
});
