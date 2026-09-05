import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { Pool } from "pg";

const root = resolve(import.meta.dirname, "..");
const shared = process.argv.includes("--shared-path");
const files = shared
  ? ["apps/console/src/browser-shared-path.test.ts", "apps/console/src/remediation-browser.test.ts"]
  : [
      "packages/application/src/execution-wait.test.ts",
      "packages/application/src/execution-observation.test.ts",
      "apps/runtime-daemon/src/shell-lifecycle.test.ts",
      "apps/console/src/server.test.ts",
      "apps/console/src/stream-observation.test.ts",
      "packages/terminal-screen/src/history.test.ts",
      "apps/cli/src/shared-runtime.test.ts",
      "apps/local-stack/src/local-stack.test.ts",
      "apps/mcp/src/execution-output-durable.test.ts",
      "apps/mcp/src/agent-workflows.test.ts",
    ];
let temporary;
try {
  const value = process.env.ITERM_DATABASE_URL;
  if (!value)
    throw new Error("ITERM_DATABASE_URL is required; integration tests may not silently skip");
  const target = new URL(value);
  if (target.pathname !== "/iterminal_test")
    throw new Error("Only the dedicated iterminal_test database is accepted");
  if (target.port === "55432")
    throw new Error(
      "Port 55432 is reserved for the user's local stack; use the isolated fixture database",
    );
  const pool = new Pool({ connectionString: value, connectionTimeoutMillis: 3000 });
  try {
    const result = await pool.query("SELECT current_database() AS name");
    if (result.rows[0]?.name !== "iterminal_test")
      throw new Error("Connected database is not the isolated test database");
  } finally {
    await pool.end();
  }
  const require = createRequire(join(root, "packages/executor-pty/package.json"));
  const pty = require("node-pty");
  await new Promise((resolveProbe, reject) => {
    const child = pty.spawn("/bin/sh", ["-c", "exit 0"], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PTY preflight timed out"));
    }, 3000);
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      exitCode === 0 ? resolveProbe() : reject(new Error("PTY preflight failed"));
    });
  });
  if (shared) {
    await access(
      process.env.ITERM_BROWSER_EXECUTABLE ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    await access(join(root, "dist/console-web/index.html"));
  }
  for (const file of files) await access(join(root, file));
  temporary = await mkdtemp(join(tmpdir(), "iterminal-required-tests-"));
  const report = join(temporary, "results.json");
  const result = await new Promise((resolveExit) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--maxWorkers=1",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
        ...files,
      ],
      { cwd: root, stdio: "inherit", env: process.env },
    );
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (result !== 0) throw new Error("Required integration tests failed");
  const results = JSON.parse(await readFile(report, "utf8"));
  let count = 0;
  for (const file of files) {
    const suite = results.testResults.find((item) => item.name === join(root, file));
    if (!suite?.assertionResults.length) throw new Error(`No tests ran for required file: ${file}`);
    if (suite.assertionResults.some((test) => test.status !== "passed"))
      throw new Error(`Required file contains failed/skipped/todo tests: ${file}`);
    count += suite.assertionResults.length;
  }
  console.log(
    `Required ${shared ? "L3 shared-path" : "L1/L2 integration"} gate: ${files.length} files, ${count} passed, 0 skipped.`,
  );
} catch (error) {
  // Never echo a connection URL, credential, or raw database error message.
  console.error(
    error instanceof Error && !error.message.includes("://")
      ? error.message
      : "Integration preflight failed",
  );
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
