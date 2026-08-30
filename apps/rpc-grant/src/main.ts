import { issueRuntimeRpcGrant } from "./issuer.js";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage:
  ITERM_RPC_AUTH_SECRET=<base64url> pnpm rpc:grant -- \\
    --type agent --client mcp-stdio --id agent-local --principal local-agent \\
    --operations execution.get,execution.start,execution.wait,session.create,session.list

Use --scope paired-prefix with --id-prefix and --principal-prefix for a bounded adapter namespace.
The grant is written to stdout. The secret is read only from ITERM_RPC_AUTH_SECRET.
`);
  process.exit(0);
}

try {
  const issued = issueRuntimeRpcGrant(process.argv.slice(2), process.env);
  process.stdout.write(`${issued.token}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime RPC grant failed"}\n`);
  process.exitCode = 1;
}
