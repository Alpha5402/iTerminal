import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Approval, Execution, Session } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium, type Browser, type Page } from "playwright-core";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHumanConsole, type HumanConsoleServerHandle } from "./server.js";

const root = resolve(import.meta.dirname, "../../..");
const databaseUrl = process.env.ITERM_DATABASE_URL;
const executablePath =
  process.env.ITERM_BROWSER_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const staticRoot = join(root, "dist/console-web");
const ready =
  databaseUrl && existsSync(executablePath) && existsSync(join(staticRoot, "index.html"));
(ready ? describe : describe.skip)(
  "remediation canonical Console and official MCP shared path",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    let directory: string;
    let daemon: RuntimeDaemonHandle;
    let server: HumanConsoleServerHandle;
    let browser: Browser;
    let page: Page;
    let agent: Client;
    let runtime: UnixRuntimeClient;
    let session: Session;
    beforeAll(async () => {
      const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
      if (database.rows[0]?.name !== "iterminal_test")
        throw new Error("Requires isolated iterminal_test");
      const migration = new PostgresRuntimeDurability(databaseUrl!);
      await migration.migrate();
      await migration.close();
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE sessions, actors, outbox, artifacts, runtime_workers RESTART IDENTITY CASCADE",
      );
      directory = await realpath(await mkdtemp(join(tmpdir(), "it-remediation-browser-")));
      daemon = await startRuntimeDaemon({
        databaseUrl: databaseUrl!,
        socketPath: join(directory, "r.sock"),
        ownerId: "remediation-browser",
      });
      runtime = new UnixRuntimeClient(daemon.socketPath);
      agent = new Client({ name: "remediation-agent", version: "1.0.0" });
      await agent.connect(
        new StdioClientTransport({
          command: join(root, "node_modules/.bin/tsx"),
          args: [join(root, "apps/mcp/src/main.ts")],
          cwd: root,
          env: {
            ...getDefaultEnvironment(),
            NODE_ENV: "test",
            ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
            ITERM_RUNTIME_SOCKET: daemon.socketPath,
          },
          stderr: "pipe",
        }),
      );
      session = await call<Session>("session_create", {
        workspaceRoot: directory,
        shell: "zsh",
        idempotencyKey: "browser-session",
      });
      server = await startHumanConsole({ gateway: runtime, port: 0, staticRoot });
      browser = await chromium.launch({ executablePath, headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(5000);
      await page.goto(server.url, { waitUntil: "networkidle" });
      await expect.poll(() => page.locator(".connection").innerText()).toContain("live");
    });
    afterEach(async () => {
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await agent?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      if (directory) await rm(directory, { force: true, recursive: true });
    });
    afterAll(async () => {
      await pool.end();
    });
    async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await agent.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`Fixture tool failed: ${name}`);
      const value = result.structuredContent;
      if (!value || typeof value !== "object" || !("result" in value))
        throw new Error("Missing MCP result");
      return value.result as T;
    }
    async function execute(command: string, key: string, target = session): Promise<Execution> {
      const started = await call<{ execution: Execution }>("execute", {
        sessionId: target.id,
        generation: target.generation,
        command,
        idempotencyKey: key,
      });
      return call<Execution>("execution_wait", { executionId: started.execution.id });
    }

    it("renders canonical palette/RGB/inverse/wide cells and never replays hostile OSC", async () => {
      // Fixture program is separate from echoed command, including hidden/OSC payloads.
      await writeFile(
        join(directory, "styles.py"),
        'import os\nos.write(1, b"\\x1b[2J\\x1b[H\\x1b[31mRED_ERROR\\x1b[0m\\r\\n\\x1b[48;2;12;34;56mRGB_BACKGROUND   \\x1b[0m\\r\\n\\x1b[7mINVERSE\\x1b[0m\\r\\n" + "中文🙂é".encode() + b"\\r\\n\\x1b[8mHIDDEN_CANARY\\x1b[0mVISIBLE_END\\r\\n\\x1b]52;c;SE9TVElMRQ==\\x07\\x1b]2;HOSTILE_TITLE\\x07")\n',
      );
      const title = await page.title();
      await execute("python3 styles.py", "styles");
      await expect
        .poll(() => page.getByTestId("browser-terminal-output").textContent())
        .toContain("VISIBLE_END");
      const text = await page.getByTestId("browser-terminal-output").textContent();
      expect(text).toContain("中文🙂é");
      expect(text).not.toContain("HIDDEN_CANARY");
      expect(await page.title()).toBe(title);
      const canonical = await runtime.getConsoleFrame(session.id, session.generation);
      expect(
        canonical.cells.some(
          (cell) =>
            cell.text === "R" &&
            cell.style.foreground?.mode === "palette" &&
            cell.style.foreground.index === 1,
        ),
      ).toBe(true);
      expect(
        canonical.cells.some(
          (cell) => cell.style.background?.mode === "rgb" && cell.style.background.red === 12,
        ),
      ).toBe(true);
      const readColors = () =>
        page.locator(".xterm-rows span").evaluateAll((spans) =>
          spans.map((span) => ({
            text: span.textContent,
            color: getComputedStyle(span).color,
            background: getComputedStyle(span).backgroundColor,
          })),
        );
      // The xterm write callback precedes its animation-frame DOM paint.
      await expect
        .poll(async () =>
          (await readColors()).some(
            (cell) => cell.text?.includes("RED_ERROR") && cell.color !== "rgb(216, 239, 226)",
          ),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          (await readColors()).some((cell) => cell.background === "rgb(12, 34, 56)"),
        )
        .toBe(true);
      // Screenshot lives in an ignored artifact directory and is inspected separately.
      await page.screenshot({
        path: join(root, "docs/verification/review-remediation/artifacts/remediation-styles.png"),
        fullPage: true,
      });
    }, 20_000);

    it("pages genuine history, preserves a browsing position during output, and isolates session switches", async () => {
      await execute("python3 -c 'for i in range(250): print(\"history-row-%04d\" % i)'", "history");
      await page.locator(".terminal-surface").hover();
      await page.mouse.wheel(0, -400);
      const history = page.getByRole("region", { name: "Terminal history" });
      await history.waitFor();
      const lines = page.getByLabel("Retained terminal lines");
      await expect.poll(() => lines.textContent()).toContain("history-row-");
      await page.getByRole("button", { name: "Load older lines" }).click();
      await expect.poll(() => lines.textContent()).toContain("history-row-0050");
      const before = await lines.textContent();
      await lines.evaluate((element) => {
        element.scrollTop = 40;
      });
      const top = await lines.evaluate((element) => element.scrollTop);
      await execute("printf 'new-live-output\\n'", "new-output");
      expect(await lines.textContent()).toBe(before);
      expect(await lines.evaluate((element) => element.scrollTop)).toBe(top);
      const other = await call<Session>("session_create", {
        workspaceRoot: directory,
        shell: "zsh",
        idempotencyKey: "other-history",
      });
      await execute("printf 'other-session-only\\n'", "other-output", other);
      await expect.poll(() => page.locator(".session-tab").count(), { timeout: 8000 }).toBe(2);
      await page.locator(".session-tab").last().click();
      await expect
        .poll(() => page.getByTestId("browser-terminal-output").textContent())
        .toContain("other-session-only");
      expect(await page.getByLabel("Retained terminal lines").textContent()).not.toContain(
        "history-row-",
      );
      await page.getByRole("button", { name: "Back to live terminal" }).click();
      expect(await page.getByLabel("Retained terminal lines").count()).toBe(0);
    }, 20_000);

    it("loads the next authenticated inbox page without resetting the selected session", async () => {
      // Reduce the real endpoint page size to exercise pagination with two actual approvals.
      await page.route("**/api/approvals/pending*", async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.set("limit", "1");
        await route.continue({ url: url.toString() });
      });
      const other = await call<Session>("session_create", {
        workspaceRoot: directory,
        shell: "zsh",
        idempotencyKey: "paged-inbox",
      });
      for (let index = 0; index < 2; index++)
        await call<Approval>("approval_request", {
          sessionId: other.id,
          generation: other.generation,
          command: `printf inbox-page-${index}`,
          reason: "Pagination fixture",
          actionIdempotencyKey: `inbox-action-${index}`,
          requestIdempotencyKey: `inbox-request-${index}`,
        });
      const more = page.getByRole("button", { name: "Load more approvals" });
      await more.waitFor({ timeout: 8000 });
      await expect.poll(() => page.locator(".approval-list li").count()).toBe(1);
      await more.click();
      await expect.poll(() => page.locator(".approval-list li").count()).toBe(2);
      expect(await page.locator(".approval-list").innerText()).toContain("inbox-page-0");
      expect(await page.locator(".approval-list").innerText()).toContain("inbox-page-1");
      expect(
        await page
          .locator(".session-tab")
          .first()
          .evaluate((element) => element.classList.contains("selected")),
      ).toBe(true);
    }, 20000);

    it("shows another session's pending approval and removes it after a Human decision", async () => {
      const other = await call<Session>("session_create", {
        workspaceRoot: directory,
        shell: "zsh",
        idempotencyKey: "approval-other",
      });
      const proposal = await call<Approval>("approval_request", {
        sessionId: other.id,
        generation: other.generation,
        command: "printf approved-other",
        reason: "Cross-session browser fixture",
        actionIdempotencyKey: "approved-other",
        requestIdempotencyKey: "approval-other",
      });
      await expect
        .poll(() => page.locator(".approval-panel").textContent(), { timeout: 8000 })
        .toContain("printf approved-other");
      expect(
        await page
          .locator(".session-tab")
          .first()
          .evaluate((element) => element.classList.contains("selected")),
      ).toBe(true);
      await page.getByRole("button", { name: `Open session ${other.id.slice(-8)}` }).click();
      await page.getByRole("button", { name: "Approve once" }).click();
      await expect
        .poll(() =>
          call<Approval>("approval_get", {
            sessionId: other.id,
            generation: other.generation,
            approvalId: proposal.id,
          }),
        )
        .toMatchObject({ status: "APPROVED" });
      await expect
        .poll(() => page.getByRole("button", { name: /^Approvals / }).innerText(), {
          timeout: 8000,
        })
        .toBe("Approvals 0");
    }, 20_000);
  },
);
