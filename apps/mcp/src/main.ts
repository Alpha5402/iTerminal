import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";

const socketPath = process.env.ITERM_RUNTIME_SOCKET;
if (socketPath === undefined || socketPath.length === 0) {
  process.stderr.write("ITERM_RUNTIME_SOCKET is required for the iTerminal MCP bridge\n");
  process.exit(1);
}

const actor = {
  client: process.env.ITERM_ACTOR_CLIENT ?? "mcp-stdio",
  id: process.env.ITERM_ACTOR_ID ?? `agent_${process.pid.toString()}`,
  principal: process.env.ITERM_ACTOR_PRINCIPAL ?? "local-agent",
  type: "agent" as const,
};
const gateway = new UnixRuntimeClient(socketPath);
const handle = serveStdio(() => createMcpServer(gateway, actor));
process.stderr.write("iTerminal MCP bridge listening on stdio\n");

process.on("SIGINT", () => {
  void handle.close().then(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void handle.close().then(() => process.exit(0));
});
