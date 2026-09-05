import { ACTOR_CAPABILITY_PROFILES, type InteractionState } from "@iterminal/domain";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

async function createSessionFromForm(page: Page, workspace: string): Promise<void> {
  await page.getByRole("button", { name: "New Session" }).click();
  await page.getByLabel("Workspace directory").fill(workspace);
  await page.getByRole("button", { name: "Create Session" }).click();
}

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

  it("keeps Human foreground drafts local while Agent lines and logs continue", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-line-draft-")));
    fixtures.push(root);
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "line-draft-browser",
      socketPath: join(root, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    page = await browser.newPage({ viewport: { width: 1309, height: 1249 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    const screenshotDir = join(
      repositoryRoot,
      "docs/verification/review-remediation/artifacts/2026-09-05-C06",
    );
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, "current-1309x1249.png"), fullPage: true });
    await page.getByRole("button", { name: "New Session" }).click();
    await page.getByRole("button", { name: "Create Session" }).click();
    expect(
      await page
        .getByLabel("Workspace directory")
        .evaluate((input) => (input instanceof HTMLInputElement ? input.validationMessage : "")),
    ).not.toBe("");
    const missingWorkspace = join(root, "missing-workspace");
    await page.getByLabel("Workspace directory").fill(missingWorkspace);
    await page.getByRole("button", { name: "Create Session" }).click();
    const errorBanner = page.locator(".error-banner");
    await errorBanner.waitFor({ state: "visible" });
    expect(await errorBanner.textContent()).toContain(
      "Workspace root must resolve to an existing directory",
    );
    expect(await errorBanner.textContent()).not.toContain(missingWorkspace);
    const refresh = errorBanner.getByRole("button", { name: "Refresh sessions" });
    await refresh.focus();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Refresh sessions");
    await page.keyboard.press("Enter");
    const dismiss = errorBanner.getByRole("button", { name: "Dismiss" });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await errorBanner.waitFor({ state: "hidden" });

    const notDirectory = join(root, "not-a-directory");
    await writeFile(notDirectory, "fixture");
    await page.getByLabel("Workspace directory").fill(notDirectory);
    await page.getByRole("button", { name: "Create Session" }).click();
    await errorBanner.waitFor({ state: "visible" });
    expect(await errorBanner.textContent()).toContain(
      "Workspace root must resolve to an existing directory",
    );
    expect(await errorBanner.textContent()).not.toContain(notDirectory);
    await errorBanner.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await errorBanner.waitFor({ state: "hidden" });

    const noPermission = join(root, "no-permission");
    await mkdir(noPermission);
    try {
      await chmod(noPermission, 0o000);
      await page.getByLabel("Workspace directory").fill(noPermission);
      await page.getByRole("button", { name: "Create Session" }).click();
      await errorBanner.waitFor({ state: "visible" });
      const permissionError = (await errorBanner.textContent()) ?? "";
      expect(permissionError).toMatch(
        /Workspace root must resolve to an existing directory|Runtime RPC request failed/u,
      );
      expect(permissionError).not.toContain(noPermission);
      await errorBanner.getByRole("button", { name: "Dismiss" }).focus();
      await page.keyboard.press("Enter");
      await errorBanner.waitFor({ state: "hidden" });
    } finally {
      await chmod(noPermission, 0o700);
    }

    await page.getByLabel("Workspace directory").fill(root);
    await page.getByRole("button", { name: "Create Session" }).click();
    await waitForPageText(page, ".status-strip", "READY");
    const session = required(
      (await runtime.listSessions()).find((candidate) => candidate.status === "READY"),
    );
    const script =
      'const r=require("node:readline").createInterface({input:process.stdin,terminal:false});let n=0;setInterval(()=>console.log("日志 "+ ++n),40);r.on("line",s=>console.log("ACK:"+s));';
    const started = await callTool<StartedResult>(mcp, "execute", {
      sessionId: session.id,
      generation: session.generation,
      command: `${JSON.stringify(process.execPath)} -e '${script}'`,
      idempotencyKey: "start-line-fixture",
    });
    await waitUntilRunning(mcp, started.execution.id);
    const editor = page.getByLabel("Foreground command composer");
    await editor.waitFor({ state: "visible" });
    const modeBar = page.getByTestId("input-mode-bar");
    expect(await modeBar.textContent()).toContain(`Execution ${started.execution.id}`);
    expect(
      await page.getByRole("button", { name: "Line input" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const initial = await runtime.getInteractionState(session.id, session.generation);
    await editor.fill("Human 中文草稿X");
    await editor.press("Backspace");
    const draft = "Human 中文草稿";
    expect(await editor.inputValue()).toBe(draft);
    const observed = await callTool<InteractionState>(mcp, "interaction_get", {
      sessionId: session.id,
      generation: session.generation,
    });
    expect(observed.inputContext).toEqual(initial.inputContext);
    expect(observed.guard).toBeUndefined();
    const beforeEnter = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM actions WHERE session_id=$1 AND kind='input' AND NOT(payload ? 'terminalResponse')",
      [session.id],
    );
    expect(beforeEnter.rows[0]?.count).toBe(0);
    const agentLine = await callTool<{ status: string }>(mcp, "input", {
      sessionId: session.id,
      generation: session.generation,
      targetExecutionId: started.execution.id,
      data: "agent-status\n",
      idempotencyKey: "agent-while-human-drafts",
      lineInput: {
        expectedInputVersion: observed.inputContext?.version,
        expectedInteractionVersion: observed.version,
      },
    });
    expect(agentLine.status).toBe("DELIVERED");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "ACK:agent-status");
    expect(await editor.inputValue()).toBe(draft);
    await editor.press("Enter");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', `ACK:${draft}`);
    await expect.poll(() => editor.inputValue()).toBe("");
    const sent = await pool.query<{ data: string }>(
      "SELECT payload->>'data' AS data FROM actions WHERE session_id=$1 AND kind='input' AND NOT(payload ? 'terminalResponse') ORDER BY action_sequence",
      [session.id],
    );
    expect(sent.rows.map((row) => row.data)).toEqual(["agent-status\n", `${draft}\n`]);
    await page.screenshot({ path: join(screenshotDir, "after-1309x1249.png"), fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: join(screenshotDir, "after-1024x768.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(screenshotDir, "after-1440x900.png"), fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page.screenshot({ path: join(screenshotDir, "after-200-percent.png"), fullPage: true });
    for (const locator of [
      page.getByRole("button", { name: "New Session" }),
      page.locator('[aria-label$="command composer"]'),
      page.getByText("Diagnostics", { exact: true }),
    ]) {
      await locator.scrollIntoViewIfNeeded();
      expect(await locator.isVisible()).toBe(true);
      await locator.focus();
    }
    const diagnostics = page.locator("details.diagnostics");
    const diagnosticsSummary = diagnostics.locator("summary");
    await diagnosticsSummary.focus();
    await page.keyboard.press("Enter");
    expect(await diagnostics.getAttribute("open")).toBe("");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
    await page.setViewportSize({ width: 1309, height: 900 });
    expect(
      (await runtime.getInteractionState(session.id, session.generation)).inputContext?.state,
    ).toBe("clear");
    await editor.fill("first\nsecond");
    await editor.press("Enter");
    await waitForPageText(page, ".error-banner", "INVALID_REQUEST");
    await waitForPageText(page, '[data-testid="submission-intent"]', "rejected");
    expect(await editor.inputValue()).toBe("first\nsecond");
    const afterInvalid = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM actions WHERE session_id=$1 AND kind='input'",
      [session.id],
    );
    expect(afterInvalid.rows[0]?.count).toBe(2);
    // A lost response keeps one frozen identity. Repeated Enter and lookup never write again.
    await editor.fill("uncertain-line");
    let posts = 0;
    let lookups = 0;
    let frozenInputBody: unknown;
    const inputPattern = `**/api/sessions/${session.id}/input`;
    const lookupPattern = `**/api/sessions/${session.id}/actions/lookup`;
    await page.route(inputPattern, async (route) => {
      posts++;
      frozenInputBody = route.request().postDataJSON();
      await route.fetch();
      await route.abort("failed");
    });
    await page.route(lookupPattern, async (route) => {
      lookups++;
      await delay(75);
      if (lookups === 1) {
        const body = frozenInputBody as { readonly idempotencyKey?: unknown } | undefined;
        if (typeof body?.idempotencyKey !== "string") {
          throw new Error("Browser did not expose the frozen idempotency key");
        }
        await route.fulfill({
          body: JSON.stringify({
            requestId: "c01-synthetic-not-found",
            result: {
              generation: session.generation,
              idempotencyKey: body.idempotencyKey,
              kind: "not_found",
              mayStillBeInFlight: true,
              message:
                "No accepted Action is currently observable; the original request may still be in flight, so do not generate a replacement idempotency key",
              sessionId: session.id,
            },
          }),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      await route.continue();
    });
    await editor.press("Enter");
    await expect.poll(() => posts).toBe(1);
    await waitForPageText(page, ".error-banner", "Failed to fetch");
    await waitForPageText(page, '[data-testid="submission-intent"]', "uncertain");
    await editor.fill("newer local draft");
    await editor.press("Enter");
    await editor.press("Enter");
    expect(posts).toBe(1);
    expect(await editor.inputValue()).toBe("newer local draft");

    await page.evaluate(() => {
      const check = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Check result",
      );
      if (!(check instanceof HTMLButtonElement)) throw new Error("Check result button missing");
      check.click();
      check.click();
    });
    await waitForPageText(page, '[data-testid="submission-intent"]', "may still be in flight");
    expect(lookups).toBe(1);
    expect(posts).toBe(1);
    const c01ScreenshotDir = join(
      repositoryRoot,
      "docs/verification/review-remediation/artifacts/2026-09-05-C01",
    );
    await mkdir(c01ScreenshotDir, { recursive: true });
    await page.screenshot({
      path: join(c01ScreenshotDir, "uncertain-not-found-with-newer-draft.png"),
      fullPage: true,
    });
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "ACK:uncertain-line");
    await page.getByRole("button", { name: "Check result" }).click();
    await waitForPageText(page, '[data-testid="submission-intent"]', "actual status DELIVERED");
    await waitForPageText(
      page,
      '[data-testid="submission-intent"]',
      "not proof that the program handled the input or that execution succeeded",
    );
    expect(lookups).toBe(2);
    expect(posts).toBe(1);
    expect(await editor.inputValue()).toBe("newer local draft");
    if (frozenInputBody === undefined) throw new Error("Browser did not expose the frozen body");
    const frozenKey = (frozenInputBody as { readonly idempotencyKey?: unknown }).idempotencyKey;
    expect(typeof frozenKey).toBe("string");
    const acceptedFrozen = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM actions WHERE session_id=$1 AND idempotency_key=$2",
      [session.id, frozenKey],
    );
    expect(acceptedFrozen.rows[0]?.count).toBe(1);
    await page.locator(".error-banner").getByRole("button", { name: "Dismiss" }).click();
    await page.screenshot({
      path: join(c01ScreenshotDir, "accepted-with-newer-draft.png"),
      fullPage: true,
    });
  }, 60_000);

  it("explains untracked input and fences recovery controls", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-c03-short-")));
    fixtures.push(root);
    const fixture = join(root, "raw.cjs");
    await writeFile(
      fixture,
      'process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", d => { const s=d.toString(); if(s.includes("\\u001b[B")){ process.stdout.write("ARROW_UNKNOWN"); setTimeout(()=>process.stdout.write("\\nAUTONOMOUS_LINE"),250); } if(s.includes("\\u0003")){ process.stdout.write("\\nCTRL_C_SEEN"); process.exit(130); } });',
    );
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "c03-short",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    page = await browser.newPage({ viewport: { width: 1309, height: 1249 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    const sessions = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    const session = sessions[0];
    if (session === undefined) throw new Error("short C03 session missing");
    await page.getByLabel("READY command composer").fill(`node ${fixture}`);
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(page, ".status-strip", "RUNNING");
    await page.getByRole("button", { name: "Raw keys" }).click();
    await page.locator(".terminal-host").click();
    await page.keyboard.press("ArrowDown");
    await waitForPageText(page, '[role="alert"]', "Raw Input, Control, or Secret input");
    const expectedExecution = required((await runtime.getSession(session.id)).activeExecutionId);
    const before = await runtime.getInteractionState(session.id, session.generation);
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "AUTONOMOUS_LINE");
    const after = await runtime.getInteractionState(session.id, session.generation);
    expect(after.inputContext).toEqual(before.inputContext);
    await page.getByRole("button", { name: "Line input" }).click();
    const editor = page.getByLabel("Foreground command composer");
    await editor.fill("kept draft");
    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [session.id],
    );
    await editor.evaluate((form) => form.closest("form")?.requestSubmit());
    expect(await editor.inputValue()).toBe("kept draft");
    const countAfter = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [session.id],
    );
    expect(countAfter.rows[0]?.count).toBe(count.rows[0]?.count);
    await page.getByRole("button", { name: "Interrupt (Ctrl-C)" }).click();
    await waitForPageText(page, ".control-outcome", "Control Action");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "CTRL_C_SEEN");
    const controls = await pool.query<{ id: string; status: string; target_execution_id: string }>(
      "SELECT id,status,payload->>'targetExecutionId' AS target_execution_id FROM actions WHERE session_id=$1 AND kind='control' ORDER BY action_sequence DESC LIMIT 1",
      [session.id],
    );
    expect(controls.rows[0]?.status).toBe("DELIVERED");
    expect(controls.rows[0]?.target_execution_id).toBe(expectedExecution);
    await waitForPageText(page, ".control-outcome", controls.rows[0]?.id ?? "missing-control-id");
    await waitForPageText(page, ".status-strip", "READY");
    let deliveryPosts = 0;
    let deliveryBody:
      | {
          generation?: number;
          idempotencyKey?: string;
          targetExecutionId?: string;
        }
      | undefined;
    let lookupCalls = 0;
    let lookupUrl = "";
    let lookupBody: { generation?: number; idempotencyKey?: string } | undefined;
    await page.route("**/api/sessions/*/input", async (route) => {
      deliveryPosts += 1;
      deliveryBody = JSON.parse(route.request().postData() ?? "{}") as typeof deliveryBody;
      await route.fulfill({
        contentType: "application/json",
        status: 503,
        body: JSON.stringify({
          error: {
            allowedNextActions: ["check_action"],
            code: "DELIVERY_UNKNOWN",
            details: {},
            message: "Input delivery is uncertain; check the exact Action.",
            requestId: "c03-delivery-unknown",
            retryable: false,
          },
        }),
      });
    });
    await page.route("**/api/sessions/*/actions/lookup", async (route) => {
      lookupCalls += 1;
      lookupUrl = route.request().url();
      lookupBody = JSON.parse(route.request().postData() ?? "{}") as typeof lookupBody;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          result: {
            generation: session.generation,
            idempotencyKey: deliveryBody?.idempotencyKey,
            kind: "not_found",
            mayStillBeInFlight: true,
            message: "The Action may still be in flight.",
            sessionId: session.id,
          },
        }),
      });
    });
    await page.getByLabel("READY command composer").fill("cat");
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(page, ".status-strip", "RUNNING");
    const deliveryExecution = required((await runtime.getSession(session.id)).activeExecutionId);
    expect(deliveryExecution).not.toBe(expectedExecution);
    expect(await page.getByRole("status").filter({ hasText: expectedExecution }).count()).toBe(0);
    await page.getByRole("button", { name: "Line input" }).click();
    const deliveryEditor = page.getByLabel("Foreground command composer");
    await deliveryEditor.fill("delivery draft");
    await deliveryEditor.evaluate((form) => form.closest("form")?.requestSubmit());
    await waitForPageText(page, '[role="alert"]', "may not have reached the PTY");
    expect(await deliveryEditor.inputValue()).toBe("delivery draft");
    expect(deliveryPosts).toBe(1);
    await deliveryEditor.evaluate((form) => form.closest("form")?.requestSubmit());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deliveryPosts).toBe(1);
    await page.getByRole("button", { name: "Check result" }).click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lookupCalls).toBe(1);
    await waitForPageText(page, '[data-testid="submission-intent"]', "may still be in flight");
    expect(lookupUrl).toContain(`/api/sessions/${session.id}/actions/lookup`);
    expect(lookupBody?.idempotencyKey).toBe(deliveryBody?.idempotencyKey);
    expect(lookupBody?.generation).toBe(deliveryBody?.generation);
    expect(deliveryBody?.generation).toBe(session.generation);
    expect(deliveryBody?.targetExecutionId).toBe(deliveryExecution);
    expect(await deliveryEditor.inputValue()).toBe("delivery draft");
    const cleanupControl = await callTool<{ readonly status: string }>(mcp, "control", {
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      generation: session.generation,
      idempotencyKey: "c03-short-cleanup-control",
      sessionId: session.id,
      targetExecutionId: deliveryExecution,
    });
    expect(cleanupControl.status).toBe("DELIVERED");
    await callTool(mcp, "execution_wait", { executionId: deliveryExecution });
  }, 60_000);

  it("fences explicit line and raw modes to the focused current Execution", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-input-modes-")));
    fixtures.push(root);
    const nodeFixture = join(root, "line-repl.cjs");
    const menuFixture = join(root, "raw-menu.cjs");
    await writeFile(
      nodeFixture,
      [
        'const readline = require("node:readline");',
        "const input = readline.createInterface({ input: process.stdin, terminal: false });",
        'console.log("NODE_READY");',
        'input.on("line", (line) => {',
        "  console.log(`LINE:${JSON.stringify(line)}`);",
        '  if (line === "quit") process.exit(0);',
        "});",
      ].join("\n"),
    );
    await writeFile(
      menuFixture,
      [
        "process.stdin.setRawMode(true);",
        "process.stdin.resume();",
        'process.stdout.write("\\u001b[?1049hMENU:0");',
        'process.stdin.on("data", (chunk) => {',
        '  const data = chunk.toString("utf8");',
        '  if (data.includes("\\u001b[B")) process.stdout.write("\\rMENU:1");',
        '  if (data.includes("\\t")) process.stdout.write("\\r\\nTAB_SEEN");',
        '  if (data.includes("\\u0003")) { process.stdout.write("\\r\\nCTRL_C_SEEN"); process.exit(130); }',
        '  if (data.includes("q")) {',
        '    process.stdout.write("\\u001b[?1049lMENU_EXIT\\n");',
        "    process.exit(0);",
        "  }",
        "});",
      ].join("\n"),
    );
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "input-modes-browser",
      socketPath: join(root, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 900, width: 1309 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    const lineSession = required((await runtime.listSessions())[0]);
    const node = await callTool<StartedResult>(mcp, "execute", {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(nodeFixture)}`,
      generation: lineSession.generation,
      idempotencyKey: "c02-node-line-repl",
      sessionId: lineSession.id,
    });
    await waitUntilRunning(mcp, node.execution.id);
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "NODE_READY");
    const modeBar = page.getByTestId("input-mode-bar");
    await waitForPageText(page, '[data-testid="input-mode-bar"]', node.execution.id);
    expect(await modeBar.textContent()).toContain(`Target ${lineSession.id}`);
    expect(await modeBar.textContent()).toContain(
      `generation ${lineSession.generation.toString()}`,
    );
    expect(
      await page.getByRole("button", { name: "Line input" }).getAttribute("aria-pressed"),
    ).toBe("true");

    const screenshotDir = join(
      repositoryRoot,
      "docs/verification/review-remediation/artifacts/2026-09-05-C02",
    );
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, "node-line-mode-target.png"),
      fullPage: true,
    });

    const editor = page.getByLabel("Foreground command composer");
    await editor.click();
    const composingEnterPrevented = await editor.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: "Enter",
      });
      element.dispatchEvent(event);
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      return event.defaultPrevented;
    });
    expect(composingEnterPrevented).toBe(false);
    await page.keyboard.insertText("中文-ime");
    expect(await editor.inputValue()).toBe("中文-ime");
    const beforeLineEnter = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [lineSession.id],
    );
    expect(beforeLineEnter.rows[0]?.count).toBe("0");
    await editor.press("Enter");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', 'LINE:"中文-ime"');
    await expect.poll(() => editor.inputValue()).toBe("");
    const ordinaryLine = await pool.query<{ count: string; data: string }>(
      `SELECT count(*)::text AS count, max(payload->>'data') AS data
       FROM actions WHERE session_id=$1 AND kind='input'`,
      [lineSession.id],
    );
    expect(ordinaryLine.rows[0]).toEqual({ count: "1", data: "中文-ime\n" });
    await page.getByTestId("submission-intent").getByRole("button", { name: "Dismiss" }).click();

    const beforeEmptyLine = ordinaryLine.rows[0]?.count;
    await editor.press("Enter");
    await waitForPageText(page, '[data-testid="input-mode-bar"]', "does not send an empty return");
    const afterEmptyLine = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [lineSession.id],
    );
    expect(afterEmptyLine.rows[0]?.count).toBe(beforeEmptyLine);

    const humanDraft = "draft-stays-local";
    await editor.fill(humanDraft);
    await callTool(mcp, "input", {
      data: "agent-line\n",
      generation: lineSession.generation,
      idempotencyKey: "c02-agent-while-human-drafts",
      sessionId: lineSession.id,
      targetExecutionId: node.execution.id,
    });
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', 'LINE:"agent-line"');
    expect(await editor.inputValue()).toBe(humanDraft);
    const actionsBeforeSwitch = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1",
      [lineSession.id],
    );
    await modeBar.getByRole("button", { name: "Raw keys" }).click();
    expect(await editor.count()).toBe(0);
    await page.getByRole("button", { name: "Line input" }).click();
    await editor.waitFor({ state: "visible" });
    expect(await editor.inputValue()).toBe(humanDraft);
    const actionsAfterSwitch = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1",
      [lineSession.id],
    );
    expect(actionsAfterSwitch.rows[0]?.count).toBe(actionsBeforeSwitch.rows[0]?.count);
    await editor.fill("");

    await modeBar.getByRole("button", { name: "Raw keys" }).click();
    const beforeExplicitFocus = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [lineSession.id],
    );
    await page.keyboard.type("X");
    await page.waitForTimeout(40);
    const afterUnfocusedKey = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id=$1 AND kind='input'",
      [lineSession.id],
    );
    expect(afterUnfocusedKey.rows[0]?.count).toBe(beforeExplicitFocus.rows[0]?.count);
    await page.locator(".terminal-host").click();
    await page.waitForFunction(
      () => document.querySelector(".terminal-host")?.classList.contains("interactive") === true,
    );
    await page.keyboard.press("Enter");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', 'LINE:""');
    await waitUntilGuardReleased(runtime, lineSession.id, lineSession.generation);
    await page.locator(".terminal-host").click();
    await page.keyboard.insertText("原始中文");
    await page.waitForTimeout(40);
    await page.keyboard.press("Enter");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', 'LINE:"原始中文"');
    const rawIme = await pool.query<{ data: string }>(
      `SELECT payload->>'data' AS data FROM actions
       WHERE session_id=$1 AND kind='input' AND actor_id LIKE 'human_console_%'
       ORDER BY action_sequence`,
      [lineSession.id],
    );
    expect(
      rawIme.rows
        .map((row) => row.data)
        .join("")
        .split("原始中文"),
    ).toHaveLength(2);
    await waitUntilGuardReleased(runtime, lineSession.id, lineSession.generation);

    await page.getByRole("button", { name: "Line input" }).click();
    await createSessionFromForm(page, root);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 2);
    const sessionTabs = page.locator(".session-tab");
    await sessionTabs.nth(0).click();
    await waitForPageText(page, '[data-testid="input-mode-bar"]', node.execution.id);
    await modeBar.getByRole("button", { name: "Raw keys" }).click();

    let releaseGuard!: () => void;
    const guardRelease = new Promise<void>((resolveGuard) => {
      releaseGuard = resolveGuard;
    });
    let markGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolveGuard) => {
      markGuardStarted = resolveGuard;
    });
    let inputPosts = 0;
    await page.route(`**/api/sessions/${lineSession.id}/input`, async (route) => {
      inputPosts++;
      await route.continue();
    });
    await page.route(`**/api/sessions/${lineSession.id}/interaction/guard`, async (route) => {
      markGuardStarted();
      await guardRelease;
      await route.continue();
    });
    await page.locator(".terminal-host").click();
    await page.keyboard.type("Z");
    await guardStarted;
    await sessionTabs.nth(1).click();
    releaseGuard();
    await page.waitForTimeout(100);
    expect(inputPosts).toBe(0);
    await sessionTabs.nth(0).click();
    await waitForPageText(page, '[data-testid="input-mode-bar"]', "dropped and was not sent");
    expect(
      await page.getByRole("button", { name: "Line input" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const crossedTab = await pool.query<{ count: string }>(
      `SELECT count(*) FROM actions
       WHERE session_id=$1 AND kind='input' AND payload->>'data' LIKE '%Z%'`,
      [lineSession.id],
    );
    expect(crossedTab.rows[0]?.count).toBe("0");
    await page.unroute(`**/api/sessions/${lineSession.id}/input`);
    await page.unroute(`**/api/sessions/${lineSession.id}/interaction/guard`);

    await page.getByRole("button", { name: "Interrupt (Ctrl-C)" }).click();
    await waitForPageText(page, ".control-outcome", node.execution.id);
    await callTool(mcp, "execution_wait", { executionId: node.execution.id });
    await waitForPageText(page, ".status-strip", "READY");
    const menu = await callTool<StartedResult>(mcp, "execute", {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(menuFixture)}`,
      generation: lineSession.generation,
      idempotencyKey: "c02-raw-menu",
      sessionId: lineSession.id,
    });
    await waitUntilRunning(mcp, menu.execution.id);
    await waitForPageText(page, '[data-testid="input-mode-bar"]', menu.execution.id);
    expect(await page.getByTestId("input-mode-bar").textContent()).toContain(
      `Previous: Session ${lineSession.id}, generation ${lineSession.generation.toString()}, Execution ${node.execution.id}`,
    );
    expect(await page.getByTestId("input-mode-bar").textContent()).toContain(
      `Current: Session ${lineSession.id}, generation ${lineSession.generation.toString()}, Execution ${menu.execution.id}`,
    );
    expect(
      await page.getByRole("button", { name: "Line input" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await page.screenshot({
      path: join(screenshotDir, "new-execution-reset-line-mode.png"),
      fullPage: true,
    });

    const stale = await page.evaluate(
      async ({ executionId, generation, sessionId }) => {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
          body: JSON.stringify({
            data: "\u001b[A",
            generation,
            idempotencyKey: "c02-stale-old-execution",
            targetExecutionId: executionId,
          }),
          headers: {
            "content-type": "application/json",
            "x-iterminal-request": "console",
          },
          method: "POST",
        });
        return { body: (await response.json()) as unknown, status: response.status };
      },
      {
        executionId: node.execution.id,
        generation: lineSession.generation,
        sessionId: lineSession.id,
      },
    );
    expect(stale.status).not.toBe(202);
    expect(JSON.stringify(stale.body)).toContain("EXECUTION_CHANGED");
    const staleAction = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE idempotency_key='c02-stale-old-execution'",
    );
    expect(staleAction.rows[0]?.count).toBe("0");

    await page.getByRole("button", { name: "Raw keys" }).click();
    await page.locator(".terminal-host").click();
    await page.keyboard.press("ArrowDown");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "MENU:1");
    await waitForPageText(page, '[role="alert"]', "Raw Input, Control, or Secret input");
    await page.locator(".terminal-host").click();
    console.log("C03-R3");
    await page.keyboard.press("Tab");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "TAB_SEEN");
    await waitForPageText(page, '[role="alert"]', "Raw Input, Control, or Secret input");
    await page.screenshot({
      path: join(screenshotDir, "raw-menu-focused-target.png"),
      fullPage: true,
    });
    await page.locator(".terminal-host").click();
    console.log("C03-R4");
    await page.keyboard.type("q");
    console.log("C03-R5");
    await callTool(mcp, "execution_wait", { executionId: menu.execution.id });
    await waitForPageText(page, ".status-strip", "READY");
    expect(await page.getByTestId("input-mode-bar").count()).toBe(0);
    await page.getByLabel("READY command composer").waitFor({ state: "visible" });
    const menuInputs = await pool.query<{ data: string; target_execution_id: string }>(
      `SELECT payload->>'data' AS data, payload->>'targetExecutionId' AS target_execution_id
       FROM actions WHERE session_id=$1 AND payload->>'targetExecutionId'=$2 AND kind='input'
       ORDER BY action_sequence`,
      [lineSession.id, menu.execution.id],
    );
    expect(menuInputs.rows.map((row) => row.data).join("")).toContain("\u001b[B");
    expect(menuInputs.rows.map((row) => row.data).join("")).toContain("\t");
    expect(menuInputs.rows.map((row) => row.data).join("")).toContain("q");
    expect(menuInputs.rows.every((row) => row.target_execution_id === menu.execution.id)).toBe(
      true,
    );
  }, 60_000);

  it("copies wrapped output back into the Shell without extra newlines and survives Console loss", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-copy-browser-")));
    fixtures.push(root);
    const directory = join(root, "long-directory-".repeat(4), "publish");
    await mkdir(directory, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "copy-browser",
      socketPath: join(root, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    page = await browser.newPage({ viewport: { width: 1309, height: 1249 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Fit terminal to active window").uncheck();
    await page.getByLabel("Columns").fill("80");
    await page.getByLabel("Rows").fill("40");
    await page.getByRole("button", { name: "Resize canonical PTY" }).click();
    await waitForPageText(page, ".status-strip", "80×40");
    await page.getByRole("button", { name: "Close side panel" }).click();
    const session = required((await runtime.listSessions())[0]);
    const command = `cd "${directory}"\nprintf '%s\\n' '中文 copy-roundtrip-ok'`;
    const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
    const printed = await callTool<StartedResult>(mcp, "execute", {
      command: `printf '%s\\n' '__COPY_BEGIN__' ${quoted(command)} '__COPY_END__'`,
      sessionId: session.id,
      generation: session.generation,
      idempotencyKey: "print-copy-fixture",
    });
    await callTool(mcp, "execution_wait", { executionId: printed.execution.id });
    await waitForPageText(page, ".status-strip", "READY");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "__COPY_END__");
    const screen = await runtime.getScreen(session.id, session.generation);
    const fromRow = screen.lines.findIndex((line) => line === "__COPY_BEGIN__") + 1;
    const toRow = screen.lines.findIndex((line) => line === "__COPY_END__");
    expect(fromRow).toBeGreaterThan(0);
    expect(toRow).toBeGreaterThan(fromRow + 1);
    expect(screen.wrappedRows?.slice(fromRow, toRow)).toContain(true);
    const rect = await page.locator(".xterm-screen").boundingBox();
    if (rect === null) throw new Error("Missing terminal screen geometry");
    const rowHeight = rect.height / screen.rows;
    await page.mouse.move(rect.x + 1, rect.y + (fromRow + 0.5) * rowHeight);
    await page.mouse.down();
    await page.mouse.move(rect.x + 1, rect.y + (toRow + 0.5) * rowHeight, { steps: 10 });
    await page.mouse.up();
    // Exercise the real copy handler without reading or replacing the user's OS clipboard.
    const copied = await page.evaluate(() => {
      const target = document.querySelector(".terminal-host .xterm-helper-textarea");
      if (target === null) throw new Error("Missing terminal copy target");
      const data = new DataTransfer();
      const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      target.dispatchEvent(event);
      return { handled: event.defaultPrevented, text: data.getData("text/plain") };
    });
    expect(copied.handled).toBe(true);
    expect(copied.text).toBe(`${command}\n`);
    await page.getByLabel("READY command composer").fill(copied.text);
    const submitted = page.waitForResponse(
      (response) => response.url().endsWith("/execute") && response.request().method() === "POST",
    );
    await page.getByLabel("READY command composer").press("Enter");
    const response = await submitted;
    expect(response.status()).toBe(202);
    const admitted = (await response.json()) as { result: StartedResult };
    await callTool(mcp, "execution_wait", { executionId: admitted.result.execution.id });
    await waitForPageText(page, ".status-strip", "READY");
    const stored = await pool.query<{ command: string; exit_code: number }>(
      "SELECT command, exit_code FROM executions WHERE session_id = $1 ORDER BY started_at DESC LIMIT 1",
      [session.id],
    );
    expect(stored.rows[0]).toEqual({ command: copied.text, exit_code: 0 });

    // Losing the Console transport for longer than an owner lease must not close the PTY.
    await page.context().setOffline(true);
    for (const connection of consoleServer.app.websocketServer.clients) connection.terminate();
    await waitForPageText(page, ".connection", "offline");
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    expect((await runtime.getSession(session.id)).status).toBe("READY");
    await page.context().setOffline(false);
    await waitForPageText(page, ".connection", "live");
    expect((await runtime.getSession(session.id)).generation).toBe(session.generation);
    const afterReconnect = await callTool<StartedResult>(mcp, "execute", {
      command: `test "$PWD" = ${quoted(directory)}`,
      sessionId: session.id,
      generation: session.generation,
      idempotencyKey: "same-shell-after-console-offline",
    });
    await callTool(mcp, "execution_wait", { executionId: afterReconnect.execution.id });
    expect(
      (
        await pool.query<{ exit_code: number }>("SELECT exit_code FROM executions WHERE id = $1", [
          afterReconnect.execution.id,
        ])
      ).rows[0]?.exit_code,
    ).toBe(0);
  }, 60_000);

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
    const mcpConfigPath = join(root, "mcp.json");
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            iterminal: {
              args: ["apps/mcp/src/main.ts"],
              command: "tsx",
              env: { ITERM_RUNTIME_SOCKET: daemon.socketPath },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    consoleServer = await startHumanConsole({
      gateway: runtime,
      mcpConfigPath,
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

    expect(await page.locator(".inspector").count()).toBe(0);
    await page.getByRole("button", { name: "Connect MCP", exact: true }).click();
    const mcpPanel = await page.getByLabel("MCP connection").textContent();
    expect(mcpPanel).toContain("Agent connection");
    expect(mcpPanel).toContain("mcpServers");
    expect(mcpPanel).not.toContain(mcpConfigPath);
    expect(await page.locator(".rail").count()).toBe(0);
    await page.getByRole("button", { name: "Close side panel" }).click();
    expect(await page.locator(".inspector").count()).toBe(0);

    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    expect(await page.locator(".session-tab").count()).toBe(1);
    await page.getByLabel("READY command composer").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "READY command composer",
    );
    const promptPlacement = await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('[aria-label="READY command composer"]');
      const xtermScreen = document.querySelector<HTMLElement>(".xterm-screen");
      if (editor === null || xtermScreen === null) {
        throw new Error("READY command editor was not rendered inside the terminal");
      }
      const editorRect = editor.getBoundingClientRect();
      const screenRect = xtermScreen.getBoundingClientRect();
      return {
        activeLabel: document.activeElement?.getAttribute("aria-label"),
        editorBottom: editorRect.bottom,
        editorLeft: editorRect.left,
        promptIndent: parseFloat(getComputedStyle(editor).textIndent),
        editorTop: editorRect.top,
        screenBottom: screenRect.bottom,
        screenLeft: screenRect.left,
        screenTop: screenRect.top,
      };
    });
    expect(promptPlacement.activeLabel).toBe("READY command composer");
    expect(promptPlacement.editorLeft + promptPlacement.promptIndent).toBeGreaterThan(
      promptPlacement.screenLeft,
    );
    expect(promptPlacement.editorTop).toBeGreaterThanOrEqual(promptPlacement.screenTop);
    expect(promptPlacement.editorBottom).toBeLessThanOrEqual(promptPlacement.screenBottom + 1);
    expect(await page.locator(".mode-panel").count()).toBe(0);
    // This scenario exercises draft/history behavior at a deliberately fixed geometry.
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Fit terminal to active window").uncheck();
    await page.getByRole("button", { name: "Close side panel" }).click();
    await page.setViewportSize({ width: 1309, height: 1249 });
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const longDraft = `# cd "/${"long-directory/".repeat(12)}publish"\n# env EXAMPLE=${"字母ab".repeat(45)} ./example`;
    const editor = page.getByLabel("READY command composer");
    await editor.fill(longDraft);
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".command-editor");
      return (
        input !== null && input.clientHeight >= parseFloat(getComputedStyle(input).lineHeight) * 4
      );
    });
    const wrapped = await commandLayout(page);
    expect(await editor.inputValue()).toBe(longDraft);
    expect(wrapped.top).toBeCloseTo(wrapped.screenTop, 0);
    expect(wrapped.right).toBeLessThanOrEqual(wrapped.viewportRight);
    expect(wrapped.scrollWidth).toBeLessThanOrEqual(wrapped.clientWidth + 1);
    expect(wrapped.height).toBeGreaterThan(wrapped.lineHeight * 3);
    await page.getByRole("button", { name: "Close side panel" }).click();
    await page.waitForFunction((priorWidth) => {
      const input = document.querySelector<HTMLTextAreaElement>(".command-editor");
      return input !== null && input.clientWidth >= priorWidth;
    }, wrapped.clientWidth);
    expect((await commandLayout(page)).height).toBeLessThanOrEqual(wrapped.height);

    const tallDraft = Array.from({ length: 120 }, (_, index) => `# draft ${index}`).join("\n");
    await editor.fill(tallDraft);
    await page.waitForFunction(
      () => (document.querySelector(".terminal-surface")?.scrollTop ?? 0) > 0,
    );
    const tall = await commandLayout(page);
    expect(tall.height).toBeGreaterThanOrEqual(tall.lineHeight * 120);
    expect(tall.bottom).toBeLessThanOrEqual(tall.viewportBottom);
    await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await page.waitForFunction(
      () => (document.querySelector(".terminal-surface")?.scrollTop ?? -1) === 0,
    );
    expect(await editor.inputValue()).toBe(tallDraft);
    await editor.fill("");
    await page.setViewportSize({ width: 1600, height: 1100 });
    const multilineCommand = `cd "${join(workspace, "subdir")}"\nexport ITERM_M5=shared`;
    await page.getByLabel("READY command composer").fill(multilineCommand);
    expect(await page.getByLabel("READY command composer").inputValue()).toBe(multilineCommand);
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "export ITERM_M5=shared");
    await waitForPageText(page, ".status-strip", "READY");
    const firstScreen = await page.getByTestId("screen-reader-output").textContent();
    expect(firstScreen?.replace(/\n/gu, "")).toContain(`cd "${join(workspace, "subdir")}"`);
    expect(firstScreen).not.toContain("cd: too many arguments");
    expect(firstScreen).not.toContain("__it_execute");
    expect(firstScreen).toMatch(/[^\s@]+@[^\s]+ /u);
    expect(firstScreen).toMatch(/[^\s@]+@[^\s]+ subdir [%#$]/u);

    const sessions = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    expect(sessions).toHaveLength(1);
    const session = required(sessions[0]);
    expect(session.workspaceRoot).toBe(root);
    const historyOutputCommand = "for i in {1..45}; do printf 'LAYOUT_HISTORY\\n'; done";
    await editor.fill(historyOutputCommand);
    await editor.press("Enter");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "LAYOUT_HISTORY");
    await waitForPageText(page, ".status-strip", "READY");
    await page.setViewportSize({ width: 1309, height: 600 });
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const bottomDraft = Array.from({ length: 12 }, (_, index) => `# bottom draft ${index}`).join(
      "\n",
    );
    await editor.fill(bottomDraft);
    await page.waitForFunction(
      () => {
        const input = document.querySelector<HTMLTextAreaElement>(".command-editor");
        const surface = document.querySelector<HTMLElement>(".terminal-surface");
        return (
          input !== null &&
          surface !== null &&
          surface.scrollTop > 100 &&
          input.getBoundingClientRect().bottom <=
            surface.getBoundingClientRect().top + surface.clientHeight
        );
      },
      undefined,
      { timeout: 5000 },
    );
    const bottom = await commandLayout(page);
    expect(bottom.top - bottom.screenTop).toBeGreaterThan(bottom.lineHeight * 30);
    expect(bottom.height).toBeGreaterThanOrEqual(bottom.lineHeight * 12);
    expect(bottom.bottom).toBeLessThanOrEqual(bottom.viewportBottom);
    expect(bottom.scrollWidth).toBeLessThanOrEqual(bottom.clientWidth + 1);
    expect(await editor.inputValue()).toBe(bottomDraft);
    await editor.fill("");
    await page.getByRole("button", { name: "Close side panel" }).click();
    await page.setViewportSize({ width: 1600, height: 1100 });
    const unsubmittedDraft = "echo keep-my-draft";
    await editor.fill(unsubmittedDraft);
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(historyOutputCommand);
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(multilineCommand);
    await editor.press("ArrowDown");
    expect(await editor.inputValue()).toBe(historyOutputCommand);
    await editor.press("ArrowDown");
    expect(await editor.inputValue()).toBe(unsubmittedDraft);

    const multilineDraft = "# first line\n# second line";
    await editor.fill(multilineDraft);
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(multilineDraft);
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(historyOutputCommand);
    await editor.press("ArrowDown");
    expect(await editor.inputValue()).toBe(multilineDraft);

    const softWrappedDraft = `# ${"wide-draft".repeat(40)}`;
    await editor.fill(softWrappedDraft);
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(softWrappedDraft);
    await editor.press("Shift+ArrowUp");
    expect(await editor.inputValue()).toBe(softWrappedDraft);
    await editor.fill("");
    const imeWasConsumed = await editor.evaluate((element) => {
      const composingArrow = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(composingArrow);
      return composingArrow.defaultPrevented;
    });
    expect(imeWasConsumed).toBe(false);
    expect(await editor.inputValue()).toBe("");
    const executesBeforeRecall = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id = $1 AND kind = 'execute'",
      [session.id],
    );
    expect(executesBeforeRecall.rows[0]?.count).toBe("2");

    // Simulate the first page load after upgrading, before a history cache exists.
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("iterminal.command-history.")) sessionStorage.removeItem(key);
      }
    });
    await page.reload({ waitUntil: "networkidle" });
    await waitForPageText(page, ".connection", "live");
    await editor.waitFor({ state: "visible" });
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(historyOutputCommand);
    await editor.fill("");

    const proposal = await callTool<ApprovalResult>(mcp, "approval_request", {
      actionIdempotencyKey: "m10-browser-approved-action",
      command: "export ITERM_M10_BROWSER=approved",
      generation: session.generation,
      reason: "Browser Human reviews this exact Agent proposal",
      requestIdempotencyKey: "m10-browser-approval-request",
      sessionId: session.id,
    });
    await waitForPageText(page, ".approval-panel", "export ITERM_M10_BROWSER=approved");
    await page.getByRole("button", { name: "Approve once" }).click();
    await waitForPageText(page, ".approval-panel", "APPROVED");
    const approved = await callTool<ApprovalResult>(mcp, "approval_get", {
      approvalId: proposal.id,
      generation: session.generation,
      sessionId: session.id,
    });
    expect(approved.status).toBe("APPROVED");
    const approvedExecution = await callTool<StartedResult>(mcp, "execute", {
      approvalId: proposal.id,
      command: "export ITERM_M10_BROWSER=approved",
      generation: session.generation,
      idempotencyKey: "m10-browser-approved-action",
      sessionId: session.id,
    });
    await callTool(mcp, "execution_wait", { executionId: approvedExecution.execution.id });
    await waitForPageText(page, ".approval-panel", "CONSUMED");
    const python = await callTool<StartedResult>(mcp, "execute", {
      command: "python3 -q",
      generation: session.generation,
      idempotencyKey: "m5-browser-python",
      sessionId: session.id,
    });
    await waitUntilRunning(mcp, python.execution.id);
    await waitForPageText(page, ".status-strip", "RUNNING");
    const pythonModeBar = page.getByTestId("input-mode-bar");
    expect(await pythonModeBar.textContent()).toContain(`Execution ${python.execution.id}`);
    expect(
      await page.getByRole("button", { name: "Line input" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const pythonLine = page.getByLabel("Foreground command composer");
    await pythonLine.fill("human_value = 40");
    await pythonLine.press("Enter");
    await expect.poll(() => pythonLine.inputValue()).toBe("");
    await page.getByRole("button", { name: "Raw keys" }).click();
    expect(await page.getByRole("button", { name: "Raw keys" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await page.locator(".terminal-host").click();
    await page.waitForFunction(
      () => document.querySelector(".terminal-host")?.classList.contains("interactive") === true,
    );
    // An explicit empty return is a raw Input Action; line mode intentionally has no empty special case.
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
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(
      page,
      '[data-testid="screen-reader-output"]',
      `PWD=${join(workspace, "subdir")}`,
    );
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "ENV=shared");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await waitForPageText(page, ".timeline", "human:");
    await waitForPageText(page, ".timeline", "agent:agent-m5-browser");

    const cursorBeforeReload = await page.locator(".status-strip").textContent();
    await page.reload({ waitUntil: "networkidle" });
    await waitForPageText(page, ".connection", "live");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "ENV=shared");
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe('printf "PWD=%s ENV=%s\\n" "$PWD" "$ITERM_M5"');
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe(historyOutputCommand);
    await editor.fill("");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
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

    await createSessionFromForm(page, root);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 2);
    const sessionTabs = page.locator(".session-tab");
    expect(await sessionTabs.nth(1).textContent()).toContain("/");
    await waitForPageText(page, ".status-strip", "READY");
    await editor.waitFor({ state: "visible" });
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe("");
    await sessionTabs.nth(0).click();
    expect(await sessionTabs.nth(0).getAttribute("aria-current")).toBe("page");
    await waitForPageText(page, ".status-strip", "READY");
    await editor.waitFor({ state: "visible" });
    await editor.press("ArrowUp");
    expect(await editor.inputValue()).toBe('printf "PWD=%s ENV=%s\\n" "$PWD" "$ITERM_M5"');
    const tabSessions = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    expect(tabSessions).toHaveLength(2);
    expect(tabSessions.every((candidate) => candidate.workspaceRoot === root)).toBe(true);
  }, 60_000);

  it("keeps Browser Human secret input out of Console, MCP, screen, and PostgreSQL observations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "it-m10-sec-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const secretFixture = join(root, "secret.cjs");
    await writeFile(
      secretFixture,
      'process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write("Password:"); let seen=false; process.stdin.on("data", d => { const s=d.toString(); if (s.includes("\\u0003")) { process.stdout.write("\\nSECRET_CTRL_C_SEEN\\n"); process.exit(130); } if (!seen && s.length > 0) { seen=true; process.stdout.write("\\nECHO:[redacted]\\n"); } });',
    );
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m10-secret-browser",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    mcp = await connectAgent(daemon.socketPath);
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 1_100, width: 1_600 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });

    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    const [session] = await callTool<readonly SessionResult[]>(mcp, "session_list", {});
    if (session === undefined) throw new Error("Browser secret Session was not created");
    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name).filter((name) => name.includes("secret"))).toEqual(
      [],
    );

    await page.getByLabel("READY command composer").fill(`node ${secretFixture}`);
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(page, ".status-strip", "RUNNING");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "Password:");
    await page.getByLabel("Human-only secret input").waitFor({ state: "visible" });
    const securePlacement = await page.getByLabel("Human-only secret input").evaluate((input) => {
      const inputRect = input.getBoundingClientRect();
      const xtermScreen = document.querySelector<HTMLElement>(".xterm-screen");
      const screenRect = xtermScreen?.getBoundingClientRect();
      return {
        bottomPanelSecretInputs: document.querySelectorAll(
          '.mode-panel [aria-label="Human-only secret input"]',
        ).length,
        modePanels: document.querySelectorAll(".mode-panel").length,
        insideTerminal:
          screenRect !== undefined &&
          inputRect.left >= screenRect.left - 1 &&
          inputRect.top >= screenRect.top - 1 &&
          inputRect.right <= screenRect.right + 1 &&
          inputRect.bottom <= screenRect.bottom + 1,
      };
    });
    expect(securePlacement).toEqual({
      bottomPanelSecretInputs: 0,
      insideTerminal: true,
      modePanels: 0,
    });
    const secret = "BROWSER_SECRET_SENTINEL_752c";
    await page.getByLabel("Human-only secret input").fill(secret);
    await page.getByLabel("Human-only secret input").press("Enter");
    await waitForPageText(page, '[role="alert"]', "Raw Input, Control, or Secret input");
    await page
      .getByRole("button", {
        name: "Sensitive input protection is active; stop protecting output",
      })
      .waitFor({ state: "visible" });
    expect(await page.locator(".mode-panel").count()).toBe(0);
    expect(await page.locator(".secret-channel").count()).toBe(0);
    await waitForPageText(
      page,
      '[data-testid="screen-reader-output"]',
      "sensitive terminal output redacted",
    );
    expect(await page.locator("body").textContent()).not.toContain(secret);
    const screen = await callTool<ScreenResult>(mcp, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(screen.lines.join("\n")).not.toContain(secret);
    const blockedInput = await mcp.callTool({
      arguments: {
        data: "AGENT_INTERFERENCE_MUST_NOT_WRITE\n",
        generation: session.generation,
        idempotencyKey: "m10-browser-agent-sensitive-blocked",
        sessionId: session.id,
        targetExecutionId: required((await runtime.getSession(session.id)).activeExecutionId),
      },
      name: "input",
    });
    expect(blockedInput.isError).toBe(true);
    expect(textContent(blockedInput)).toContain('"code":"SENSITIVE_INPUT_ACTIVE"');

    await page
      .getByRole("button", {
        name: "Sensitive input protection is active; stop protecting output",
      })
      .click();
    await page
      .getByRole("button", {
        name: "Sensitive input protection is active; stop protecting output",
      })
      .waitFor({ state: "detached" });
    await waitForPageText(page, ".status-strip", "RUNNING");
    await waitForPageText(page, '[role="alert"]', "Raw Input, Control, or Secret input");

    await page.getByRole("button", { name: "Interrupt (Ctrl-C)" }).click();
    await waitForPageText(page, '[role="status"]', "Control Action");
    await waitForPageText(page, '[data-testid="browser-terminal-output"]', "SECRET_CTRL_C_SEEN");
    await waitForPageText(page, ".status-strip", "READY");
    await page.getByLabel("READY command composer").fill("printf 'VISIBLE_AFTER_SECRET\\n'");
    await page.getByLabel("READY command composer").press("Enter");
    await waitForPageText(page, '[data-testid="screen-reader-output"]', "VISIBLE_AFTER_SECRET");

    const durable = await pool.query<{
      action_payloads: string;
      artifact_content: string;
      event_payloads: string;
      event_search: string;
      sensitive_rows: string;
    }>(
      `SELECT
         coalesce((SELECT string_agg(payload::text, ' ') FROM actions WHERE session_id = $1), '') AS action_payloads,
         coalesce((SELECT string_agg(encode(content, 'escape'), ' ') FROM artifacts WHERE session_id = $1), '') AS artifact_content,
         coalesce((SELECT string_agg(payload::text, ' ') FROM session_events WHERE session_id = $1), '') AS event_payloads,
         coalesce((SELECT string_agg(search_text, ' ') FROM session_events WHERE session_id = $1), '') AS event_search,
         coalesce((SELECT string_agg(row_to_json(sensitive)::text, ' ') FROM sensitive_inputs sensitive WHERE session_id = $1), '') AS sensitive_rows`,
      [session.id],
    );
    expect(JSON.stringify(durable.rows[0])).not.toContain(secret);
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

    await createSessionFromForm(page, root);
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

    await page.getByRole("button", { name: "Session", exact: true }).click();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("stop its running process");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Close Session" }).click();
    await waitForPageText(page, ".status-strip", "RUNNING");

    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Columns").fill("96");
    await page.getByLabel("Rows").fill("30");
    await page.getByRole("button", { name: "Resize canonical PTY" }).click();
    expect(await page.getByLabel("Fit terminal to active window").isChecked()).toBe(false);
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

  it("fits the active Human window through shared ResizeActions without passive viewer feedback", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-window-fit-")));
    fixtures.push(root);
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-window-fit",
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
    const context = await browser.newContext({ viewport: { width: 1309, height: 1249 } });
    page = await context.newPage();
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    const session = required(
      (await callTool<readonly SessionResult[]>(mcp, "session_list", {}))[0],
    );
    const getScreen = () =>
      callTool<ScreenResult>(required(mcp), "screen_get", {
        sessionId: session.id,
        generation: session.generation,
      });
    const initialScreen = await getScreen();
    expect(initialScreen).toMatchObject({ columns: 120, rows: 40, geometryVersion: 1 });
    const initialResizeActions = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id = $1 AND kind = 'resize'",
      [session.id],
    );
    await page.bringToFront();
    await page.getByLabel("READY command composer").click();
    await waitForPageText(page, ".status-strip", "v2");
    await expect.poll(async () => (await getScreen()).geometryVersion).toBe(2);
    const first = await getScreen();
    expect(first.rows).toBeGreaterThan(40);
    await assertViewportFit(page);
    const draft = Array.from({ length: 120 }, (_, index) => `# unsubmitted ${index}`).join("\n");
    await page.getByLabel("READY command composer").fill(draft);
    await page.waitForTimeout(350);
    expect((await getScreen()).geometryVersion).toBe(2);
    expect(await page.getByLabel("READY command composer").inputValue()).toBe(draft);
    await page.getByLabel("READY command composer").fill("");

    const watcher = await callTool<StartedResult>(mcp, "execute", {
      command:
        "python3 -u -c 'import os,signal,time; emit=lambda *_: print(f\"SIZE={os.get_terminal_size().columns}x{os.get_terminal_size().lines}\",flush=True); signal.signal(signal.SIGWINCH,emit); emit(); time.sleep(45)'",
      generation: session.generation,
      sessionId: session.id,
      idempotencyKey: "window-fit-watcher",
    });
    await waitForPageText(
      page,
      '[data-testid="screen-reader-output"]',
      `SIZE=${first.columns}x${first.rows}`,
    );
    await page.setViewportSize({ width: 1100, height: 850 });
    await expect.poll(async () => (await getScreen()).geometryVersion).toBe(3);
    const smaller = await getScreen();
    expect(smaller.columns).toBeLessThan(first.columns);
    expect(smaller.rows).toBeLessThan(first.rows);
    await waitForPageText(
      page,
      '[data-testid="screen-reader-output"]',
      `SIZE=${smaller.columns}x${smaller.rows}`,
    );
    await assertViewportFit(page);
    const beforePanel = await getScreen();
    await page.getByRole("button", { name: "Session", exact: true }).click();
    await expect
      .poll(async () => (await getScreen()).geometryVersion)
      .toBeGreaterThanOrEqual(beforePanel.geometryVersion);
    const afterPanel = await getScreen();
    expect(await page.locator(".inspector").count()).toBe(1);
    expect(afterPanel.columns).toBeLessThanOrEqual(beforePanel.columns);
    expect(afterPanel.rows).toBeLessThanOrEqual(beforePanel.rows);
    await assertViewportFit(page);

    const observer = await page.context().newPage();
    await observer.setViewportSize({ width: 1500, height: 1000 });
    await observer.goto(consoleServer.url, { waitUntil: "networkidle" });
    await observer.bringToFront();
    await waitForPageText(observer, ".status-strip", "RUNNING");
    // Playwright forces every headless page focused by default. Release that override for
    // the background viewer to exercise real document.hasFocus()/blur admission.
    const background = await page.context().newCDPSession(page);
    await background.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await observer.bringToFront();
    await expect.poll(() => page?.evaluate(() => document.hasFocus())).toBe(false);
    await observer.setViewportSize({ width: 1450, height: 950 });
    await page.setViewportSize({ width: 1150, height: 900 });
    await observer.waitForTimeout(500);
    const beforeObserverClick = await getScreen();
    await observer.locator(".terminal-host").click({ position: { x: 12, y: 12 } });
    await expect
      .poll(async () => (await getScreen()).geometryVersion)
      .toBeGreaterThan(beforeObserverClick.geometryVersion);
    const secondWindow = await getScreen();
    expect(secondWindow.columns).toBeGreaterThanOrEqual(beforeObserverClick.columns);
    expect(secondWindow.rows).toBeGreaterThanOrEqual(beforeObserverClick.rows);
    expect(
      secondWindow.columns > beforeObserverClick.columns ||
        secondWindow.rows > beforeObserverClick.rows,
    ).toBe(true);
    await waitForPageText(
      page,
      ".status-strip",
      `geometry ${secondWindow.columns}×${secondWindow.rows} v${secondWindow.geometryVersion}`,
    );
    await assertViewportFit(observer);
    await observer.waitForTimeout(500);
    const observerWindow = await getScreen();
    expect(observerWindow.geometryVersion).toBeGreaterThanOrEqual(secondWindow.geometryVersion);

    // Remote canonical changes do not count as local layout intent, even in the active viewer.
    await callTool(mcp, "terminal_resize", {
      columns: 100,
      rows: 32,
      expectedGeometryVersion: observerWindow.geometryVersion,
      generation: session.generation,
      sessionId: session.id,
      idempotencyKey: "window-fit-agent",
    });
    const agentResizeVersion = observerWindow.geometryVersion + 1;
    await waitForPageText(observer, ".status-strip", `geometry 100×32 v${agentResizeVersion}`);
    await observer.waitForTimeout(500);
    expect((await getScreen()).geometryVersion).toBe(agentResizeVersion);
    await observer.reload({ waitUntil: "networkidle" });
    await observer.waitForTimeout(300);
    expect((await getScreen()).geometryVersion).toBe(agentResizeVersion);
    const actions = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id = $1 AND kind = 'resize'",
      [session.id],
    );
    expect(Number(actions.rows[0]?.count)).toBe(
      Number(initialResizeActions.rows[0]?.count) +
        (agentResizeVersion - initialScreen.geometryVersion),
    );
    await callTool(mcp, "control", {
      delivery: { mode: "TTY_CONTROL", control: "CTRL_C" },
      generation: session.generation,
      sessionId: session.id,
      targetExecutionId: watcher.execution.id,
      idempotencyKey: "window-fit-stop",
    });
    await callTool(mcp, "execution_wait", { executionId: watcher.execution.id });
  }, 60_000);

  it("closes tabs without switching background selection and preserves failed or cancelled closes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-tab-close-")));
    fixtures.push(root);
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-tab-close",
      socketPath: join(root, "runtime.sock"),
    });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    const first = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
    const second = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
    const third = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
    const closed = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
    await runtime.closeSession(closed.id, closed.generation);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
    browser = await chromium.launch({
      args: ["--disable-background-networking", "--no-first-run"],
      executablePath: browserExecutable,
      headless: true,
    });
    page = await browser.newPage({ viewport: { height: 900, width: 1309 } });
    await page.goto(consoleServer.url, { waitUntil: "networkidle" });
    await waitForPageText(page, ".status-strip", "READY");
    expect(await page.locator(".session-tab").count()).toBe(3);
    expect(await page.locator("button button").count()).toBe(0);
    await page.getByRole("button", { name: "Close zsh 3", exact: true }).click();
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(2);
    expect(await page.locator(".session-tab").nth(0).getAttribute("aria-current")).toBe("page");
    expect((await runtime.getSession(third.id)).status).toBe("CLOSED");

    const closeUrl = `${consoleServer.url}/api/sessions/${first.id}`;
    await page.route(closeUrl, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RUNTIME_UNAVAILABLE",
            message: "Injected close failure",
            allowedNextActions: [],
            details: {},
            retryable: false,
          },
        }),
      });
    });
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).click();
    await waitForPageText(page, ".error-banner", "Injected close failure");
    expect(await page.locator(".session-tab").count()).toBe(2);
    expect((await runtime.getSession(first.id)).status).toBe("READY");
    await page.unroute(closeUrl);

    const started = await runtime.startExecute({
      actor: {
        id: "agent-tab-close",
        type: "agent",
        client: "tab-close-test",
        principal: "tab-close-test",
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      },
      command: "sleep 60",
      idempotencyKey: "tab-close-running",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    await waitForPageText(page, ".status-strip", "RUNNING");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).click();
    await expect
      .poll(() =>
        required(page).getByRole("button", { name: "Close zsh 1", exact: true }).isEnabled(),
      )
      .toBe(true);
    expect((await runtime.getSession(first.id)).status).toBe("RUNNING");
    expect((await runtime.getExecution(started.execution.id)).status).toBe("RUNNING");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).click();
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(1);
    await waitForPageText(page, ".status-strip", "READY");
    expect((await runtime.getSession(first.id)).status).toBe("CLOSED");
    expect((await runtime.getSession(second.id)).status).toBe("READY");
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(0);
    await waitForPageText(page, ".status-strip", "NONE");
    expect((await runtime.getSession(second.id)).status).toBe("CLOSED");
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator(".session-tab").count()).toBe(0);
    await createSessionFromForm(page, root);
    await waitForPageText(page, ".status-strip", "READY");
    expect(await page.locator(".session-tab").count()).toBe(1);
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
    expect(await page.locator(".mode-panel").count()).toBe(0);
    await waitForPageText(page, ".checkpoint-panel", "v2");
    await waitForPageText(page, ".checkpoint-panel", restoredCwd);
    await waitForPageText(page, ".checkpoint-panel", "ITERM_M7_SAFE");
    await waitForPageText(page, ".checkpoint-warning", "Running programs");

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
    await page.getByLabel("READY command composer").press("Enter");
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

    // Historical parents are read-only: removing their tabs must not attempt DELETE.
    const deletes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE") deletes.push(request.url());
    });
    await page.locator(".session-tab").nth(0).click();
    await waitForPageText(page, ".status-strip", "BROKEN");
    await waitForPageText(page, ".checkpoint-panel", "v2");
    expect(await page.locator(".error-banner").count()).toBe(0);
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).click();
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(1);
    expect(deletes).toHaveLength(0);
    await waitForPageText(page, ".status-strip", "READY");
    expect((await replacementRuntime.getSession(parent.id)).status).toBe("BROKEN");
    await page.reload({ waitUntil: "networkidle" });
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(1);
    await waitForPageText(page, ".status-strip", "READY");
    await page.getByRole("button", { name: "Close zsh 1", exact: true }).click();
    await expect.poll(() => required(page).locator(".session-tab").count()).toBe(0);
    await waitForPageText(page, ".status-strip", "NONE");
    expect((await replacementRuntime.getSession(required(child).id)).status).toBe("CLOSED");
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator(".session-tab").count()).toBe(0);
    expect(await page.getByRole("button", { name: "New Session", exact: true }).isEnabled()).toBe(
      true,
    );
  }, 60_000);
});

async function assertViewportFit(target: Page): Promise<void> {
  await expect
    .poll(() =>
      target.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(".terminal-surface");
        const host = document.querySelector<HTMLElement>(".terminal-host");
        const grid = document.querySelector(".xterm-screen")?.getBoundingClientRect();
        const geometry = host?.getAttribute("aria-label")?.match(/Canonical (\d+) by (\d+)/u);
        if (
          surface === null ||
          host === null ||
          grid === undefined ||
          geometry === undefined ||
          geometry === null
        )
          return false;
        const padding = getComputedStyle(host);
        const remainingWidth =
          surface.clientWidth -
          parseFloat(padding.paddingLeft) -
          parseFloat(padding.paddingRight) -
          grid.width;
        const remainingHeight =
          surface.clientHeight -
          parseFloat(padding.paddingTop) -
          parseFloat(padding.paddingBottom) -
          grid.height;
        return (
          remainingWidth >= -1 &&
          remainingWidth < grid.width / Number(geometry[1]) + 1 &&
          remainingHeight >= -1 &&
          remainingHeight < grid.height / Number(geometry[2]) + 1
        );
      }),
    )
    .toBe(true);
}

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

async function commandLayout(page: Page): Promise<{
  top: number;
  bottom: number;
  right: number;
  height: number;
  lineHeight: number;
  screenTop: number;
  viewportBottom: number;
  viewportRight: number;
  scrollWidth: number;
  clientWidth: number;
}> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>(".command-editor");
    const surface = document.querySelector<HTMLElement>(".terminal-surface");
    const screen = document.querySelector<HTMLElement>(".xterm-screen");
    if (input === null || surface === null || screen === null)
      throw new Error("Command layout is missing");
    const rect = input.getBoundingClientRect();
    const viewport = surface.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right,
      height: rect.height,
      lineHeight: parseFloat(getComputedStyle(input).lineHeight),
      screenTop: screen.getBoundingClientRect().top,
      viewportBottom: viewport.top + surface.clientHeight,
      viewportRight: viewport.left + surface.clientWidth,
      scrollWidth: input.scrollWidth,
      clientWidth: input.clientWidth,
    };
  });
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
  readonly workspaceRoot: string;
}

interface ApprovalResult {
  readonly id: string;
  readonly status: string;
}

interface ScreenResult {
  readonly columns: number;
  readonly geometryVersion: number;
  readonly lines: readonly string[];
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
