import { startRuntimeRouter } from "../server.js";

const failpoint = requiredEnvironment("ITERM_TEST_FAILPOINT");
if (failpoint !== "after-placement-claim" && failpoint !== "after-execution-start-forward") {
  throw new Error(`Unsupported Router failpoint: ${failpoint}`);
}

const crash = (): void => {
  process.kill(process.pid, "SIGKILL");
};
const router = await startRuntimeRouter({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  hooks: {
    ...(failpoint === "after-placement-claim" ? { afterPlacementClaim: crash } : {}),
    ...(failpoint === "after-execution-start-forward"
      ? {
          afterForward: ({ operation }: { readonly operation: string }) => {
            if (operation === "execution.start") crash();
          },
        }
      : {}),
  },
  socketPath: requiredEnvironment("ITERM_ROUTER_SOCKET"),
});

process.stderr.write(`iTerminal Runtime Router listening at ${router.socketPath}\n`);

const shutdown = async (): Promise<void> => router.close();
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
