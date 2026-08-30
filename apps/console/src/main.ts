import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { UnixRuntimeClient, defaultRuntimeSocketPath } from "@iterminal/runtime-rpc";

import { startHumanConsole } from "./server.js";

const socketPath = process.env.ITERM_RUNTIME_SOCKET ?? defaultRuntimeSocketPath();
const host = process.env.ITERM_CONSOLE_HOST ?? "127.0.0.1";
const port = parsePort(process.env.ITERM_CONSOLE_PORT ?? "4173");
const staticRoot = resolve(process.env.ITERM_CONSOLE_STATIC_ROOT ?? "dist/console-web");
if (!existsSync(resolve(staticRoot, "index.html"))) {
  throw new Error(`Human Console assets are missing at ${staticRoot}; run pnpm build:console`);
}
const consoleServer = await startHumanConsole({
  gateway: new UnixRuntimeClient(socketPath),
  host,
  port,
  staticRoot,
});

process.stderr.write(`iTerminal Human Console listening at ${consoleServer.url}\n`);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stderr.write(`iTerminal Human Console stopping after ${signal}\n`);
  await consoleServer.close();
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

function parsePort(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535 || value.toString() !== raw) {
    throw new Error("ITERM_CONSOLE_PORT must be an integer between 0 and 65535");
  }
  return value;
}
