import { RuntimeService } from "@iterminal/application";
import type { Actor } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";

export * from "./tcp-fault-proxy.js";

export const humanActor: Actor = {
  client: "test-console",
  id: "human_test",
  principal: "local-human",
  type: "human",
};

export const agentActor: Actor = {
  client: "test-mcp",
  id: "agent_test",
  principal: "local-agent",
  type: "agent",
};

export function createTestRuntime(): RuntimeService {
  return new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory());
}
