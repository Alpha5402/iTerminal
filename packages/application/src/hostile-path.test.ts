import { join } from "node:path";

import { createTestRuntime } from "@iterminal/testkit";
import { describe, expect, it } from "vitest";

describe("M10.11 hostile path diagnostics", () => {
  it("does not echo an unresolvable workspace or filesystem error", async () => {
    const sentinel = "HOSTILE_WORKSPACE_PATH_MUST_NOT_ECHO";
    const runtime = createTestRuntime();
    const request = runtime.createSession({
      shell: "zsh",
      workspaceRoot: join("/definitely-missing", sentinel),
    });
    await expect(request).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { pathKind: "workspace_root" },
    });
    await request.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain("ENOENT");
    });
  });
});
