import type { RuntimeGateway } from "@iterminal/runtime-rpc";
import { describe, expect, it } from "vitest";

import { createMcpServer, MCP_INSTRUCTIONS } from "./server.js";

const baselineToolNames = new Set([
  "action_lookup",
  "artifact_read",
  "execution_observe",
  "execution_output_read",
  "runtime_capabilities",
  "session_create",
  "session_get",
  "session_checkpoint",
  "session_fork",
  "session_list",
  "session_close",
  "approval_request",
  "approval_get",
  "approval_list",
  "execute",
  "execution_get",
  "execution_wait",
  "execution_wait_v2",
  "interaction_get",
  "input",
  "control",
  "terminal_resize",
  "events_query",
  "screen_get",
  "terminal_state",
  "screen_region",
  "screen_cells",
  "screen_diff",
  "screen_search",
  "screen_wait",
]);

describe("MCP tool metadata", () => {
  it("keeps core instructions within the character budget", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(700);
    expect(MCP_INSTRUCTIONS).toContain("shared Session");
    expect(MCP_INSTRUCTIONS).toContain("PTY_BUSY");
    expect(MCP_INSTRUCTIONS).toContain("UNKNOWN");
    expect(MCP_INSTRUCTIONS).toContain("merged stream");
    expect(MCP_INSTRUCTIONS).toContain("secrets");
  });

  it("preserves the complete tool set and bounds each local description", () => {
    const server = createMcpServer({} as RuntimeGateway, {
      id: "metadata-test",
      type: "agent",
      principal: "metadata-test",
      client: "metadata-test",
      capabilities: ["session.execute"],
    });
    const registered = (
      server as unknown as { _registeredTools: Record<string, { description?: string }> }
    )._registeredTools;
    expect(new Set(Object.keys(registered))).toEqual(baselineToolNames);
    for (const tool of Object.values(registered)) {
      expect(tool.description?.length ?? 0).toBeLessThanOrEqual(700);
    }
    expect(registered.execution_output_read?.description).toContain(
      "An Artifact gap must be acknowledged before using its resumeCursor",
    );
    expect(registered.execution_output_read?.description).not.toContain(
      "A gap must be acknowledged before using its resume cursor",
    );
    expect(registered.execution_wait?.description).toContain("Prefer execution_wait_v2");
    expect(registered.execution_wait_v2?.description).toContain(
      "completed=true means terminal, not successful",
    );
    expect(registered.execution_observe?.description).toContain("Raw base64 is authoritative");
    expect(registered.execution_observe?.description).toContain(
      "original Actor and idempotency key",
    );
  });
});
