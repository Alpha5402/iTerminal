import { access } from "node:fs/promises";

import { startRuntimeRouter } from "../server.js";

const targetOwnerId = requiredEnvironment("ITERM_TEST_DELAY_OWNER_ID");
const releasePath = requiredEnvironment("ITERM_TEST_DELAY_RELEASE_PATH");
let delayed = false;
const router = await startRuntimeRouter({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  hooks: {
    afterPlacementClaim: async (owner) => {
      if (delayed || owner.ownerId !== targetOwnerId) return;
      delayed = true;
      process.stderr.write(`iTerminal test Router placement paused owner=${owner.ownerId}\n`);
      while (!(await exists(releasePath))) await delay(10);
      process.stderr.write(`iTerminal test Router placement released owner=${owner.ownerId}\n`);
    },
  },
  socketPath: requiredEnvironment("ITERM_ROUTER_SOCKET"),
});

process.stderr.write(`iTerminal Runtime Router listening at ${router.socketPath}\n`);

const shutdown = async (): Promise<void> => router.close();
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
