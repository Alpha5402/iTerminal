import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium, type Browser, type Page } from "playwright-core";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startHumanConsole, type HumanConsoleServerHandle } from "./server.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const staticRoot = join(repositoryRoot, "dist/console-web");
const databaseUrl = process.env.ITERM_DATABASE_URL;
const browserExecutable =
  process.env.ITERM_BROWSER_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserReady = existsSync(browserExecutable) && existsSync(join(staticRoot, "index.html"));
const describeBrowser = databaseUrl !== undefined && browserReady ? describe : describe.skip;

describeBrowser("M5 real Browser Human Console plus official MCP Agent", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let browser: Browser | undefined;
  let consoleServer: HumanConsoleServerHandle | undefined;
  let daemon: RuntimeDaemonHandle | undefined;
  let mcp: Client | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M5 browser test refuses to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    await page?.close().catch(() => undefined);
    page = undefined;
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await mcp?.close().catch(() => undefined);
    mcp = undefined;
    await consoleServer?.close().catch(() => undefined);
    consoleServer = undefined;
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("shares cwd, env, Python REPL, Guard, screen, and attributed timeline across transports", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m5-browser-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "subdir"), { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m5-browser",
      socketPath: join(root, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({
      gateway: runtime,
      port: 0,
      staticRoot,
    });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 1_100, width: 1_600 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });

    await page.getByLabel("Workspace root").fill(workspace);
    await page.getByRole("button", { name: "Create persistent shell" }).click();
    await waitForPageText(page, ".status-strip", "READY");
    await page.getByLabel("READY command composer").fill("cd subdir && export ITERM_M5=shared");
    await page.getByRole("button", { name: "Execute Action" }).click();
    await waitForPageText(page, ".timeline", "execution.completed");
    await waitForPageText(page, ".status-strip", "READY");

    const sessions = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    expect(sessions).toHaveLength(1);
    const session = required(sessions[0]);
    const python = await callTool<StartedResult>(mcp, "execute", {
      command: "python3 -q",
      generation: session.generation,
      idempotencyKey: "m5-browser-python",
      sessionId: session.id,
    });
    await waitUntilRunning(mcp, python.execution.id);
    await waitForPageText(page, ".status-strip", "RUNNING");

    await page.getByRole("button", { name: "Enter interactive focus" }).click();
    await page.keyboard.type("human_value = 40", { delay: 5 });
    await page.keyboard.press("Enter");
    const humanGuard = await waitForHumanGuard(runtime, session.id, session.generation);
    expect(humanGuard.guardActorType).toBe("human");

    const blocked = await mcp.callTool({
      arguments: {
        data: "agent_raced = True\n",
        generation: session.generation,
        idempotencyKey: "m5-browser-agent-guarded",
        sessionId: session.id,
        targetExecutionId: python.execution.id,
      },
      name: "input",
    });
    expect(blocked.isError).toBe(true);
    expect(textContent(blocked)).toContain('"code":"INPUT_GUARDED"');
    await waitUntilGuardReleased(runtime, session.id, session.generation);

    await callTool(mcp, "input", {
      data: "print(human_value + 2)\n",
      generation: session.generation,
      idempotencyKey: "m5-browser-agent-print",
      sessionId: session.id,
      targetExecutionId: python.execution.id,
    });
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "42");
    await callTool(mcp, "input", {
      data: "exit()\n",
      generation: session.generation,
      idempotencyKey: "m5-browser-agent-exit",
      sessionId: session.id,
      targetExecutionId: python.execution.id,
    });
    await callTool(mcp, "execution_wait", { executionId: python.execution.id });
    await waitForPageText(page, ".status-strip", "READY");

    await page
      .getByLabel("READY command composer")
      .fill('printf "PWD=%s ENV=%s\\n" "$PWD" "$ITERM_M5"');
    await page.getByRole("button", { name: "Execute Action" }).click();
    await waitForPageText(
      page,
      '[data-testid="screen-reader-output"]',
      `PWD=${join(workspace, "subdir")}`,
    );
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "ENV=shared");
    await waitForPageText(page, ".timeline", "human:");
    await waitForPageText(page, ".timeline", "agent:agent-m5-browser");

    const cursorBeforeReload = await page.locator(".status-strip").textContent();
    await page.reload({ waitUntil: "networkidle" });
    await waitForPageText(page, ".connection", "live");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "ENV=shared");
    await waitForPageText(page, ".timeline", "execution.completed");
    const cursorAfterReload = await page.locator(".status-strip").textContent();
    expect(cursorAfterReload).not.toBeNull();
    expect(cursorBeforeReload).not.toBeNull();

    const durable = await pool.query<{
      agent_actions: string;
      guarded_rejected_actions: string;
      human_actions: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE actor_id LIKE 'human_console_%') AS human_actions,
         count(*) FILTER (WHERE actor_id = 'agent-m5-browser') AS agent_actions,
         count(*) FILTER (WHERE idempotency_key = 'm5-browser-agent-guarded') AS guarded_rejected_actions
       FROM actions WHERE session_id = $1`,
      [session.id],
    );
    expect(Number(durable.rows[0]?.human_actions)).toBeGreaterThanOrEqual(2);
    expect(Number(durable.rows[0]?.agent_actions)).toBeGreaterThanOrEqual(3);
    expect(durable.rows[0]?.guarded_rejected_actions).toBe("0");
  }, 60_000);

  it("keeps Human and Agent resize on one versioned PTY geometry and browser render", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-resize-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m6-resize",
      socketPath: join(root, "runtime.sock"),
    });
    consoleServer = await startHumanConsole({
      gateway: new UnixRuntimeClient(daemon.socketPath),
      port: 0,
      staticRoot,
    });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 1_100, width: 1_600 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });

    await page.getByLabel("Workspace root").fill(workspace);
    await page.getByRole("button", { name: "Create persistent shell" }).click();
    await waitForPageText(page, ".status-strip", "READY");
    const sessions = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    const session = required(sessions[0]);
    const watcher = await callTool<StartedResult>(mcp, "execute", {
      command:
        "python3 -u -c 'import os,signal,time; emit=lambda *_: print(f\"SIZE={os.get_terminal_size().columns}x{os.get_terminal_size().lines}\",flush=True); signal.signal(signal.SIGWINCH,emit); emit(); time.sleep(30)'",
      generation: session.generation,
      idempotencyKey: "m6-resize-watcher",
      sessionId: session.id,
    });
    await waitUntilRunning(mcp, watcher.execution.id);
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "SIZE=120x40");
    const beforeHuman = await callTool<ScreenResult>(mcp, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });

    await page.getByLabel("Columns").fill("96");
    await page.getByLabel("Rows").fill("30");
    await page.getByRole("button", { name: "Resize canonical PTY" }).click();
    await waitForPageText(page, ".status-strip", "geometry 96×30 v2");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "SIZE=96x30");
    const afterHuman = await callTool<ScreenResult>(mcp, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(afterHuman).toMatchObject({ columns: 96, geometryVersion: 2, rows: 30 });
    const crossGeometryDiff = await callTool<ScreenDiffResult>(mcp, "screen_diff", {
      afterVersion: beforeHuman.screenVersion,
      generation: session.generation,
      sessionId: session.id,
    });
    expect(crossGeometryDiff).toMatchObject({
      reason: "geometry_changed",
      resyncRequired: true,
      snapshot: { columns: 96, geometryVersion: 2, rows: 30 },
    });

    const stale = await mcp.callTool({
      arguments: {
        columns: 100,
        expectedGeometryVersion: 1,
        generation: session.generation,
        idempotencyKey: "m6-resize-stale",
        rows: 32,
        sessionId: session.id,
      },
      name: "terminal_resize",
    });
    expect(stale.isError).toBe(true);
    expect(textContent(stale)).toContain('"code":"GEOMETRY_CHANGED"');

    await callTool(mcp, "terminal_resize", {
      columns: 100,
      expectedGeometryVersion: 2,
      generation: session.generation,
      idempotencyKey: "m6-resize-agent",
      rows: 32,
      sessionId: session.id,
    });
    await waitForPageText(page, ".status-strip", "geometry 100×32 v3");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "SIZE=100x32");
    const afterAgent = await callTool<ScreenResult>(mcp, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(afterAgent).toMatchObject({ columns: 100, geometryVersion: 3, rows: 32 });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="screen-reader-output"]')?.textContent?.trimEnd() ===
        document.querySelector('[data-testid="browser-terminal-output"]')?.textContent?.trimEnd(),
      undefined,
      { timeout: 10_000 },
    );

    await callTool(mcp, "control", {
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      generation: session.generation,
      idempotencyKey: "m6-resize-stop",
      sessionId: session.id,
      targetExecutionId: watcher.execution.id,
    });
    await callTool(mcp, "execution_wait", { executionId: watcher.execution.id });

    const durable = await pool.query<{
      agent_resize_actions: string;
      human_resize_actions: string;
      stale_resize_actions: string;
      terminal_columns: number;
      terminal_rows: number;
      geometry_version: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE a.actor_id LIKE 'human_console_%' AND a.kind = 'resize') AS human_resize_actions,
         count(*) FILTER (WHERE a.actor_id = 'agent-m5-browser' AND a.kind = 'resize') AS agent_resize_actions,
         count(*) FILTER (WHERE a.idempotency_key = 'm6-resize-stale') AS stale_resize_actions,
         max(s.terminal_columns) AS terminal_columns,
         max(s.terminal_rows) AS terminal_rows,
         max(s.geometry_version)::text AS geometry_version
       FROM sessions s LEFT JOIN actions a ON a.session_id = s.id
       WHERE s.id = $1`,
      [session.id],
    );
    expect(durable.rows[0]).toMatchObject({
      agent_resize_actions: "1",
      geometry_version: "3",
      human_resize_actions: "1",
      stale_resize_actions: "0",
      terminal_columns: 100,
      terminal_rows: 32,
    });
  }, 60_000);

  it("lets a Human inspect and rebuild a same-owner historical checkpoint after daemon loss", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m7-browser-rebuild-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    const restoredCwd = join(workspace, "subdir");
    await mkdir(restoredCwd, { recursive: true });
    const ownerId = "owner-m7-browser-rebuild";

    daemon = await startRuntimeDaemon({
      checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: join(root, "a.sock"),
    });
    const firstRuntime = new UnixRuntimeClient(daemon.socketPath);
    const parent = await firstRuntime.createSession({ shell: "zsh", workspaceRoot: workspace });
    const parentMutation = await firstRuntime.startExecute({
      actor: {
        client: "m7-browser-fixture",
        id: "agent-m7-browser-fixture",
        principal: "local-m7-browser-fixture",
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
        type: "agent",
      },
      command: "git init -q && cd subdir && export ITERM_M7_SAFE=historical",
      idempotencyKey: "m7-browser-parent-state",
      sessionGeneration: parent.generation,
      sessionId: parent.id,
    });
    await firstRuntime.waitExecution(parentMutation.execution.id);
    const sourceCheckpoint = await firstRuntime.getSessionCheckpoint(parent.id, parent.generation);
    expect(sourceCheckpoint.version).toBe(2);

    daemon.runtime.shutdownLiveOwner("injected browser owner loss");
    await daemon.close();
    daemon = undefined;

    daemon = await startRuntimeDaemon({
      checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: join(root, "b.sock"),
    });
    const replacementRuntime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({
      gateway: replacementRuntime,
      port: 0,
      staticRoot,
    });
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 1_100, width: 1_600 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });

    await waitForPageText(page, ".status-strip", "BROKEN");
    await waitForPageText(page, ".mode-note", "no live PTY or screen");
    await waitForPageText(page, ".checkpoint-panel", "v2");
    await waitForPageText(page, ".checkpoint-panel", restoredCwd);
    await waitForPageText(page, ".checkpoint-panel", "ITERM_M7_SAFE");
    await waitForPageText(page, ".checkpoint-warning", "does not copy processes");

    const rebuild = page.getByRole("button", {
      name: "Rebuild new Session from checkpoint",
    });
    await expect(rebuild.isDisabled()).resolves.toBe(true);
    await page.getByRole("checkbox").check();
    await expect(rebuild.isEnabled()).resolves.toBe(true);
    await rebuild.click();
    await waitForPageText(page, ".status-strip", "READY");

    const childSessions = await replacementRuntime.listSessions();
    const child = childSessions.find((session) => session.lineage?.parentSessionId === parent.id);
    expect(child).toMatchObject({
      lineage: {
        checkpointVersion: sourceCheckpoint.version,
        parentGeneration: parent.generation,
        parentSessionId: parent.id,
      },
      status: "READY",
    });
    await page
      .getByLabel("READY command composer")
      .fill('git status --short && printf \'GIT_OK PWD=%s SAFE=%s\\n\' "$PWD" "$ITERM_M7_SAFE"');
    await page.getByRole("button", { name: "Execute Action" }).click();
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "GIT_OK");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', `PWD=${restoredCwd}`);
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "SAFE=historical");

    const durable = await pool.query<{
      actor_id: string;
      child_session_id: string;
      child_status: string;
      parent_status: string;
    }>(
      `SELECT f.actor_id, f.child_session_id, child.status AS child_status,
              parent.status AS parent_status
         FROM session_forks f
         JOIN sessions child ON child.id = f.child_session_id
         JOIN sessions parent ON parent.id = f.parent_session_id
        WHERE f.parent_session_id = $1`,
      [parent.id],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({
      child_session_id: child?.id,
      child_status: "READY",
      parent_status: "BROKEN",
    });
    expect(durable.rows[0]?.actor_id).toMatch(/^human_console_/);
  }, 60_000);
});

async function connectAgent(socketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m5-browser-agent",
      ITERM_ACTOR_ID: "agent-m5-browser",
      ITERM_ACTOR_PRINCIPAL: "m5-browser-agent",
      ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
      ITERM_RUNTIME_SOCKET: socketPath,
      NODE_ENV: "test",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "m5-browser-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
  if (result.isError === true) throw new Error(`MCP tool ${name} failed: ${textContent(result)}`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> =>
      Boolean(block.type === "text"),
    )
    .map((block) => block.text)
    .join("\n");
}

async function waitUntilRunning(client: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await callTool<{ readonly status: string }>(client, "execution_get", {
      executionId,
    });
    if (execution.status === "RUNNING") return;
    await delay(10);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitForHumanGuard(
  runtime: UnixRuntimeClient,
  sessionId: string,
  generation: number,
): Promise<{ readonly guardActorType: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await runtime.getInteractionState(sessionId, generation);
    if (state.guard !== undefined) return { guardActorType: state.guard.actor.type };
    await delay(5);
  }
  throw new Error("Browser did not acquire an Interaction Guard");
}

async function waitUntilGuardReleased(
  runtime: UnixRuntimeClient,
  sessionId: string,
  generation: number,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await runtime.getInteractionState(sessionId, generation);
    if (state.guard === undefined) return;
    await delay(5);
  }
  throw new Error("Browser Interaction Guard did not converge after idle");
}

async function waitForPageText(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ expectedText, target }) =>
      document.querySelector(target)?.textContent?.includes(expectedText) === true,
    { expectedText: expected, target: selector },
    { timeout: 10_000 },
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface ScreenResult {
  readonly columns: number;
  readonly geometryVersion: number;
  readonly rows: number;
  readonly screenVersion: number;
}

interface ScreenDiffResult {
  readonly reason?: string;
  readonly resyncRequired: boolean;
  readonly snapshot?: ScreenResult;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}
