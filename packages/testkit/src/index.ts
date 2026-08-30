import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { RuntimeService, type RuntimeServiceOptions } from "@iterminal/application";
import type { Actor } from "@iterminal/domain";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";

export * from "./tcp-fault-proxy.js";

export const humanActor: Actor = {
  client: "test-console",
  id: "human_test",
  principal: "local-human",
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  type: "human",
};

export const agentActor: Actor = {
  client: "test-mcp",
  id: "agent_test",
  principal: "local-agent",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent",
};

export function createTestRuntime(options: RuntimeServiceOptions = {}): RuntimeService {
  return new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory(), options);
}
