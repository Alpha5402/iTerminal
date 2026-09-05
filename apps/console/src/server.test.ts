import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Actor, InteractionState } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import {
  signRuntimeRpcGrant,
  UnixRuntimeClient,
  type RuntimeRpcGrantClaims,
} from "@iterminal/runtime-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  approvedExecuteRequestFixture,
  lineInputRequestFixture,
} from "../../../packages/protocol/src/fixtures.js";

import {
  createHumanConsoleApp,
  startHumanConsole,
  type HumanConsoleServerHandle,
} from "./server.js";

const agent: Actor = {
  client: "m5-console-test-agent",
  id: "agent-m5-console-test",
  principal: "local-m5-console-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent",
};

describe("M5 Human Console HTTP/WebSocket adapter", () => {
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;
  let consoleServer: HumanConsoleServerHandle | undefined;

  afterEach(async () => {
    await consoleServer?.close().catch(() => undefined);
    consoleServer = undefined;
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects non-loopback binding before opening a listener", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    await expect(
      startHumanConsole({
        gateway: new UnixRuntimeClient(daemon.socketPath),
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      startHumanConsole({
        gateway: new UnixRuntimeClient(daemon.socketPath),
        port: 0,
        resourceLimits: { maxStreams: 1, maxStreamsPerActor: 2 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      startHumanConsole({
        gateway: new UnixRuntimeClient(daemon.socketPath),
        port: 0,
        resourceLimits: { maxRequestsPerActorPerWindow: 2, maxRequestsPerWindow: 1 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("serves assets created by a live Console rebuild and does not mask missing assets as HTML", async () => {
    const fixture = await createFixture(fixtures);
    const staticRoot = join(fixture.root, "console");
    await mkdir(join(staticRoot, "assets"), { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>iTerminal</title>\n");
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const app = await createHumanConsoleApp({
      gateway: runtimeGateway(daemon),
      port: 80,
      staticRoot,
    });
    try {
      await writeFile(join(staticRoot, "assets", "rebuilt.js"), "export const ready = true;\n");
      const rebuilt = await app.inject({
        headers: { host: "127.0.0.1" },
        method: "GET",
        url: "/assets/rebuilt.js",
      });
      expect(rebuilt.statusCode).toBe(200);
      expect(rebuilt.headers["content-type"]).toContain("javascript");
      expect(rebuilt.body).toContain("ready = true");

      const missing = await app.inject({
        headers: { host: "127.0.0.1" },
        method: "GET",
        url: "/assets/missing.css",
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).toContain("text/plain");
      expect(missing.body).not.toContain("<title>iTerminal</title>");
    } finally {
      await app.close();
    }
  });

  it("returns copyable MCP JSON without exposing its private file path", async () => {
    const fixture = await createFixture(fixtures);
    const mcpConfigPath = join(fixture.root, "mcp.json");
    const mcpConfiguration = {
      mcpServers: {
        iterminal: {
          args: ["apps/mcp/src/main.ts"],
          command: "tsx",
          env: { ITERM_RPC_GRANT: "test-grant" },
        },
      },
    };
    await writeFile(mcpConfigPath, `${JSON.stringify(mcpConfiguration)}\n`);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const app = await createHumanConsoleApp({
      gateway: runtimeGateway(daemon),
      mcpConfigPath,
      port: 80,
    });
    try {
      const response = await app.inject({
        headers: { host: "127.0.0.1", "x-iterminal-request": "console" },
        method: "GET",
        url: "/api/bootstrap",
      });
      expect(response.statusCode).toBe(200);
      const result = response.json<{
        readonly result: {
          readonly mcpConnection: { readonly configJson: string; readonly serverName: string };
        };
      }>().result;
      expect(result.mcpConnection).toEqual({
        configJson: JSON.stringify(mcpConfiguration, null, 2),
        serverName: "iterminal",
      });
      expect(response.body).not.toContain(mcpConfigPath);
    } finally {
      await app.close();
    }
  });

  it("binds Host, Origin, and WebSocket upgrades to one exact loopback authority", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    consoleServer = await startHumanConsole({
      gateway: new UnixRuntimeClient(daemon.socketPath),
      port: 0,
    });
    const listener = new URL(consoleServer.url);
    const aliasHost = await rawHttpGet(consoleServer, "/api/bootstrap", {
      host: `localhost:${consoleServer.port.toString()}`,
      "x-iterminal-request": "console",
    });
    expect(aliasHost.status).toBe(403);
    expect(aliasHost.body).not.toContain("localhost:");

    const missingPort = await rawHttpGet(consoleServer, "/api/bootstrap", {
      host: listener.hostname,
      "x-iterminal-request": "console",
    });
    expect(missingPort.status).toBe(403);

    const malformedHost = await rawHttpGet(consoleServer, "/api/bootstrap", {
      host: `user@${listener.host}`,
      "x-iterminal-request": "console",
    });
    expect(malformedHost.status).toBe(400);

    const ambientBootstrap = await fetch(`${consoleServer.url}/api/bootstrap`);
    expect(ambientBootstrap.status).toBe(403);
    expect(ambientBootstrap.headers.get("set-cookie")).toBeNull();
    const crossSiteBootstrap = await rawHttpGet(consoleServer, "/api/bootstrap", {
      host: listener.host,
      "sec-fetch-site": "cross-site",
      "x-iterminal-request": "console",
    });
    expect(crossSiteBootstrap.status).toBe(403);

    const bootstrapResponse = await requestBootstrap(consoleServer);
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.headers.get("cache-control")).toBe("no-store");
    expect(bootstrapResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(bootstrapResponse.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const setCookie = required(bootstrapResponse.headers.get("set-cookie"));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0] ?? "";
    const mismatchedScheme = `https://${listener.host}`;
    const reflectedRequestId = "HOSTILE_REQUEST_ID_MUST_NOT_REFLECT";
    const rejectedScheme = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({
        idempotencyKey: "rejected-scheme",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: mismatchedScheme,
        "x-iterminal-request": "console",
        "x-request-id": reflectedRequestId,
      },
      method: "POST",
    });
    expect(rejectedScheme.status).toBe(403);
    const rejectedSchemeBody = await rejectedScheme.text();
    expect(rejectedSchemeBody).not.toContain(mismatchedScheme);
    expect(rejectedSchemeBody).not.toContain(reflectedRequestId);

    const rejectedOriginPath = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({
        idempotencyKey: "rejected-origin-path",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: `${consoleServer.url}/forged-path`,
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedOriginPath.status).toBe(403);

    const rejectedNormalizedOrigin = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({
        idempotencyKey: "rejected-normalized-origin",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: `${consoleServer.url}/%2e`,
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedNormalizedOrigin.status).toBe(403);

    const unknownKey = "UNKNOWN_SECRET_KEY_MUST_NOT_ECHO";
    const unknownValue = "UNKNOWN_SECRET_VALUE_MUST_NOT_ECHO";
    const rejectedSchema = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({
        [unknownKey]: unknownValue,
        idempotencyKey: "rejected-schema-reflection",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: consoleServer.url,
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedSchema.status).toBe(400);
    const rejectedSchemaBody = await rejectedSchema.text();
    expect(rejectedSchemaBody).not.toContain(unknownKey);
    expect(rejectedSchemaBody).not.toContain(unknownValue);

    const hostilePath = join(fixture.root, "HOSTILE_WORKSPACE_PATH_MUST_NOT_ECHO");
    const rejectedPath = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({
        idempotencyKey: "rejected-hostile-path-reflection",
        shell: "zsh",
        workspaceRoot: hostilePath,
      }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: consoleServer.url,
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedPath.status).toBe(400);
    const rejectedPathBody = await rejectedPath.text();
    expect(rejectedPathBody).not.toContain(hostilePath);
    expect(rejectedPathBody).not.toContain("ENOENT");

    const oversizedSentinel = "OVERSIZED_CONSOLE_BODY_MUST_NOT_ECHO";
    const oversizedBody = JSON.stringify({
      data: `${oversizedSentinel}${"x".repeat(1024 * 1024)}`,
    });
    const injectedApp = await createHumanConsoleApp({ gateway: runtimeGateway(daemon), port: 80 });
    try {
      const oversized = await injectedApp.inject({
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
          "x-iterminal-request": "console",
        },
        method: "POST",
        payload: oversizedBody,
        url: "/api/sessions",
      });
      expect(oversized.statusCode).toBe(413);
      expect(JSON.parse(oversized.body)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(oversized.body).not.toContain(oversizedSentinel);

      const malformedSentinel = "MALFORMED_JSON_MUST_NOT_ECHO";
      const malformed = await injectedApp.inject({
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
          "x-iterminal-request": "console",
        },
        method: "POST",
        payload: `{"value":"${malformedSentinel}`,
        url: "/api/sessions",
      });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body)).toMatchObject({
        error: { code: "INVALID_REQUEST", message: "Console request body is not valid JSON" },
      });
      expect(malformed.body).not.toContain(malformedSentinel);
    } finally {
      await injectedApp.close();
    }

    await expectRejectedStreamResponse(
      consoleServer,
      cookie,
      { generation: 1, id: "forged-session" },
      { expectedStatus: 403, origin: mismatchedScheme },
    );
  });

  it("bounds Console actors and WebSocket streams and closes malformed acknowledgements", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({
      gateway: runtime,
      port: 0,
      resourceLimits: { maxActors: 3, maxStreams: 2, maxStreamsPerActor: 1 },
    });

    const firstBootstrap = await requestBootstrap(consoleServer);
    const firstCookie = required(firstBootstrap.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const session = await requestResult<SessionResult>(
      consoleServer,
      firstCookie,
      "/api/sessions",
      {
        body: {
          idempotencyKey: "bounded-stream-session",
          shell: "zsh",
          workspaceRoot: fixture.workspace,
        },
        method: "POST",
      },
    );
    const firstStream = (await connectStream(consoleServer, firstCookie, session)).socket;
    const perActorBody = await expectRejectedStreamResponse(consoleServer, firstCookie, session, {
      expectedStatus: 503,
      origin: consoleServer.url,
    });
    expect(perActorBody).toContain("BACKPRESSURE");
    expect(perActorBody).not.toContain(firstCookie);

    const secondBootstrap = await requestBootstrap(consoleServer);
    const secondCookie = required(secondBootstrap.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const secondStream = (await connectStream(consoleServer, secondCookie, session)).socket;

    const thirdBootstrap = await requestBootstrap(consoleServer);
    const thirdCookie = required(thirdBootstrap.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const globalBody = await expectRejectedStreamResponse(consoleServer, thirdCookie, session, {
      expectedStatus: 503,
      origin: consoleServer.url,
    });
    expect(globalBody).toContain("BACKPRESSURE");

    const actorCapacity = await requestBootstrap(consoleServer);
    expect(actorCapacity.status).toBe(503);
    expect(await bodyErrorCode(actorCapacity)).toBe("BACKPRESSURE");

    firstStream.close(1000, "free bounded slot");
    await delay(50);
    const thirdStream = (await connectStream(consoleServer, thirdCookie, session)).socket;
    const malformedClose = waitForSocketClose(thirdStream);
    thirdStream.send(JSON.stringify({ cursor: "invalid", screenVersion: 0, type: "ack" }));
    expect(await malformedClose).toBe(1008);

    const boundedPayloadStream = (await connectStream(consoleServer, thirdCookie, session)).socket;
    const oversizedClose = waitForSocketClose(boundedPayloadStream);
    boundedPayloadStream.send(Buffer.alloc(16 * 1024 + 1));
    expect(await oversizedClose).toBe(1009);
    secondStream.close(1000, "test complete");
  }, 30_000);

  it("rate-limits global and known-Actor API traffic without allocating attacker buckets", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    let now = 0;
    consoleServer = await startHumanConsole({
      gateway: new UnixRuntimeClient(daemon.socketPath),
      now: () => now,
      port: 0,
      resourceLimits: {
        maxRequestsPerActorPerWindow: 2,
        maxRequestsPerWindow: 4,
        requestRateWindowMilliseconds: 1_000,
      },
    });

    const bootstrap = await requestBootstrap(consoleServer);
    expect(bootstrap.status).toBe(200);
    const cookie = required(bootstrap.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    expect((await request(consoleServer, cookie, "/api/sessions")).status).toBe(200);
    expect((await request(consoleServer, cookie, "/api/sessions")).status).toBe(200);
    const actorLimited = await request(consoleServer, cookie, "/api/sessions");
    expect(actorLimited.status).toBe(429);
    expect(actorLimited.headers.get("retry-after")).toBe("1");
    await expect(actorLimited.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        details: { retryAfterMilliseconds: 1_000, scope: "actor" },
        retryable: true,
      },
    });

    expect((await requestBootstrap(consoleServer)).status).toBe(200);
    const globallyLimited = await fetch(`${consoleServer.url}/api/bootstrap`, {
      headers: {
        cookie: "iterminal_console=ATTACKER_CHOSEN_BUCKET_MUST_NOT_EXIST",
        "x-iterminal-request": "console",
      },
    });
    expect(globallyLimited.status).toBe(429);
    await expect(globallyLimited.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        details: { retryAfterMilliseconds: 1_000, scope: "console" },
      },
    });

    now = 1_000;
    expect((await request(consoleServer, cookie, "/api/sessions")).status).toBe(200);
  });

  it("rehydrates the same Human Actor from its Console cookie after a server restart", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const gateway = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway, port: 0 });

    const firstResponse = await requestBootstrap(consoleServer);
    const cookie = required(firstResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const first = await bodyResult<{ readonly actor: Actor }>(firstResponse);

    await consoleServer.close();
    consoleServer = await startHumanConsole({ gateway, port: 0 });
    const restoredResponse = await requestBootstrap(consoleServer, cookie);
    const restored = await bodyResult<{ readonly actor: Actor }>(restoredResponse);

    expect(restored.actor).toEqual(first.actor);
  });

  it("reconciles a lost Execute response without a second PTY write and denies an invalid grant", async () => {
    const fixture = await createFixture(fixtures);
    const secret = randomBytes(32);
    const audience = "iterminal-a04-console";
    daemon = await startRuntimeDaemon({
      rpcAuthentication: { audience, secret },
      socketPath: join(fixture.root, "runtime.sock"),
    });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const grant = signRuntimeRpcGrant(secret, {
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "human-console-web",
        idPrefix: "human_console_",
        kind: "paired_prefix",
        principalPrefix: "local-console:",
        type: "human",
      },
      audience,
      expiresAt: issuedAt + 60,
      grantId: "a04-console-grant",
      issuedAt,
      operations: [
        "events.query",
        "execution.start",
        "execution.wait",
        "session.close",
        "session.create",
        "session.get",
        "session.list",
      ],
      version: 1,
    } satisfies RuntimeRpcGrantClaims);
    const runtime = new UnixRuntimeClient(daemon.socketPath, { authorization: grant });
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await requestBootstrap(consoleServer);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{ readonly actor: Actor }>(bootstrapResponse);
    const session = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "a04-lost-response-session",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const marker = join(fixture.workspace, "a04-write-count.txt");
    const executeBody = {
      command: `printf 'once\\n' >> ${JSON.stringify(marker)}; sleep 0.1`,
      generation: session.generation,
      idempotencyKey: "a04-lost-execute",
    };
    const executePath = `/api/sessions/${session.id}/execute`;

    await dropHttpResponse(consoleServer, cookie, executePath, executeBody);
    await waitForFileContent(marker, "once\n");
    await waitUntilReady(runtime, session.id);
    const acceptedEvents = await runtime.queryEvents(session.id, session.generation, 0, 500);
    const accepted = acceptedEvents.events.find(
      (event) => event.type === "action.accepted" && event.actor?.id === bootstrap.actor.id,
    );
    expect(accepted?.actionId).toBeDefined();
    expect(accepted?.executionId).toBeDefined();

    const replay = await requestResult<{
      readonly action: { readonly id: string };
      readonly execution: { readonly id: string; readonly status: string };
    }>(consoleServer, cookie, executePath, { body: executeBody, method: "POST" });
    expect(replay.action.id).toBe(accepted?.actionId);
    expect(replay.execution.id).toBe(accepted?.executionId);
    expect(replay.execution.status).toBe("COMPLETED");
    expect(await readFile(marker, "utf8")).toBe("once\n");
    expect(
      acceptedEvents.events.filter(
        (event) => event.type === "action.accepted" && event.actor?.id === bootstrap.actor.id,
      ),
    ).toHaveLength(1);

    await consoleServer.close();
    consoleServer = await startHumanConsole({
      gateway: new UnixRuntimeClient(daemon.socketPath, { authorization: `${grant}x` }),
      port: 0,
    });
    expect((await requestBootstrap(consoleServer, cookie)).status).toBe(403);
    const denied = await request(consoleServer, cookie, executePath, {
      body: executeBody,
      method: "POST",
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain("POLICY_DENIED");
    expect(deniedBody).not.toContain(required(accepted?.actionId));
    expect(deniedBody).not.toContain(required(accepted?.executionId));
    expect(deniedBody).not.toContain(marker);

    await runtime.closeSession(session.id, session.generation);
  }, 30_000);

  it("keeps READY/interactive writes on Runtime Actions and releases a Guard on disconnect", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await requestBootstrap(consoleServer);
    expect(bootstrapResponse.status).toBe(200);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{
      readonly actor: Actor;
      readonly sessions: readonly unknown[];
    }>(bootstrapResponse);
    expect(bootstrap.actor.type).toBe("human");
    expect(bootstrap.sessions).toEqual([]);

    const rejectedOrigin = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({ shell: "zsh", workspaceRoot: fixture.workspace }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://attacker.example",
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedOrigin.status).toBe(403);

    const rejectedHeader = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({ shell: "zsh", workspaceRoot: fixture.workspace }),
      headers: { cookie, "content-type": "application/json", origin: consoleServer.url },
      method: "POST",
    });
    expect(rejectedHeader.status).toBe(403);

    const session = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "console-runtime-session-create",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const readyInput = await request(consoleServer, cookie, `/api/sessions/${session.id}/input`, {
      body: {
        data: lineInputRequestFixture.data,
        generation: session.generation,
        idempotencyKey: "m5-ready-bypass",
        lineInput: lineInputRequestFixture.lineInput,
        targetExecutionId: "exe-none",
      },
      method: "POST",
    });
    expect(readyInput.status).toBe(409);
    expect(await bodyErrorCode(readyInput)).toBe("EXECUTION_CHANGED");
    const forgedActor = await request(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/execute`,
      {
        body: {
          actor: approvedExecuteRequestFixture.actor,
          approvalId: approvedExecuteRequestFixture.approvalId,
          command: "echo forged",
          generation: session.generation,
          idempotencyKey: "forged-body-actor",
        },
        method: "POST",
      },
    );
    expect(forgedActor.status).toBe(400);
    const approvalBody = await request(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/execute`,
      {
        body: {
          approvalId: approvedExecuteRequestFixture.approvalId,
          command: "echo approval-parser",
          generation: session.generation,
          idempotencyKey: "approval-parser",
        },
        method: "POST",
      },
    );
    expect(approvalBody.status).not.toBe(400);
    expect(await bodyErrorCode(approvalBody)).toBe("POLICY_DENIED");
    const invalidLineInput = await request(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/input`,
      {
        body: {
          data: lineInputRequestFixture.data,
          generation: session.generation,
          idempotencyKey: "invalid-console-line-input",
          lineInput: { expectedInputVersion: -1, expectedInteractionVersion: 1 },
          targetExecutionId: "exe-none",
        },
        method: "POST",
      },
    );
    expect(invalidLineInput.status).toBe(400);
    const invalidInputGeneration = await request(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/input`,
      {
        body: {
          data: lineInputRequestFixture.data,
          generation: 0,
          idempotencyKey: "invalid-console-generation",
          targetExecutionId: "exe-none",
        },
        method: "POST",
      },
    );
    expect(invalidInputGeneration.status).toBe(400);

    const proposal = await runtime.requestExecuteApproval({
      actionIdempotencyKey: "m10-console-approved-action",
      actor: agent,
      command: "export ITERM_CONSOLE_APPROVED=yes",
      reason: "Exercise the Human Console decision path",
      requestIdempotencyKey: "m10-console-approval-request",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    const pending = await requestResult<readonly ApprovalResult[]>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/approvals?generation=${session.generation.toString()}&status=PENDING`,
    );
    expect(pending.map((approval) => approval.id)).toContain(proposal.id);
    const approved = await requestResult<ApprovalResult>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/approvals/${proposal.id}/decision`,
      {
        body: {
          decision: "approve",
          expectedVersion: proposal.version,
          generation: session.generation,
          idempotencyKey: "m10-console-human-approve",
          reason: "Exact Agent command reviewed in Console",
        },
        method: "POST",
      },
    );
    expect(approved).toMatchObject({ status: "APPROVED", version: 2 });
    const approvedExecution = await runtime.startExecute({
      actor: agent,
      approvalId: proposal.id,
      command: "export ITERM_CONSOLE_APPROVED=yes",
      idempotencyKey: "m10-console-approved-action",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await runtime.waitExecution(approvedExecution.execution.id);

    const started = await requestResult<StartedResult>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/execute`,
      {
        body: {
          command: "python3 -q",
          generation: session.generation,
          idempotencyKey: "m5-console-python",
        },
        method: "POST",
      },
    );
    await waitUntilRunning(runtime, started.execution.id);

    await expectRejectedStream(consoleServer, cookie, session);

    const { frame: sync, socket: firstStream } = await connectStream(
      consoleServer,
      cookie,
      session,
    );
    expect(sync).toMatchObject({ type: "sync" });
    expect(sync.screen).toMatchObject({ columns: 120, rows: 40 });
    const { socket: secondStream } = await connectStream(consoleServer, cookie, session);

    const initial = await runtime.getInteractionState(session.id, session.generation);
    const guarded = await requestResult<InteractionState>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/interaction/guard`,
      {
        body: {
          expectedVersion: initial.version,
          generation: session.generation,
          reason: "test raw batch",
          ttlMilliseconds: 1_000,
        },
        method: "POST",
      },
    );
    expect(guarded.guard?.actor).toEqual(bootstrap.actor);
    await expect(
      runtime.sendInput({
        actor: agent,
        data: "agent_blocked = True\n",
        idempotencyKey: "m5-agent-blocked",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "INPUT_GUARDED" });

    const humanInputBody = {
      data: "human_value = 40\n",
      generation: session.generation,
      idempotencyKey: "m5-human-input",
      targetExecutionId: started.execution.id,
    };
    const humanInputAction = await requestResult<{ readonly id: string }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/input`,
      {
        body: humanInputBody,
        method: "POST",
      },
    );
    const humanControlBody = {
      delivery: { mode: "PROCESS_SIGNAL", signal: "SIGCONT" },
      generation: session.generation,
      idempotencyKey: "m5-human-control",
      targetExecutionId: started.execution.id,
    };
    const humanControlAction = await requestResult<{ readonly id: string }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/control`,
      {
        body: humanControlBody,
        method: "POST",
      },
    );
    firstStream.close(1000, "first viewer disconnect");
    await delay(50);
    expect((await runtime.getInteractionState(session.id, session.generation)).guard).toBeDefined();
    secondStream.close(1000, "last viewer disconnect");
    await waitUntilGuardReleased(runtime, session.id, session.generation);

    await runtime.sendInput({
      actor: agent,
      data: "print(human_value + 2)\nexit()\n",
      idempotencyKey: "m5-agent-after-human",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    const execution = await runtime.waitExecution(started.execution.id);
    expect(execution.output).toContain("42");
    const inputReplay = await requestResult<{ readonly id: string }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/input`,
      { body: humanInputBody, method: "POST" },
    );
    const controlReplay = await requestResult<{ readonly id: string }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/control`,
      { body: humanControlBody, method: "POST" },
    );
    expect(inputReplay.id).toBe(humanInputAction.id);
    expect(controlReplay.id).toBe(humanControlAction.id);
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    const humanInput = events.events.find(
      (event) =>
        event.type === "action.accepted" &&
        event.actor?.id === bootstrap.actor.id &&
        event.actionId !== undefined,
    );
    expect(humanInput).toBeDefined();
    expect(
      events.events.filter(
        (event) => event.type === "action.accepted" && event.actionId === humanInputAction.id,
      ),
    ).toHaveLength(1);
    expect(
      events.events.filter(
        (event) => event.type === "action.accepted" && event.actionId === humanControlAction.id,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(events.events)).not.toContain("READY_BYPASS");
  }, 30_000);

  it("keeps Console secret bytes transient and requires an explicit Human finish", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await requestBootstrap(consoleServer);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{ readonly actor: Actor }>(bootstrapResponse);
    const session = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "console-secret-session-create",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const started = await requestResult<StartedResult>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/execute`,
      {
        body: {
          command: `IFS= read -r ITERM_SECRET; printf 'ECHO:%s\\n' "$ITERM_SECRET"`,
          generation: session.generation,
          idempotencyKey: "console-secret-reader",
        },
        method: "POST",
      },
    );
    await waitUntilRunning(runtime, started.execution.id);
    const secret = "CONSOLE_SECRET_SENTINEL_10da";
    const action = await requestResult<{ readonly sensitiveInputId: string }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/secret-input`,
      {
        body: {
          data: `${secret}\r`,
          generation: session.generation,
          idempotencyKey: "console-secret-submit",
          targetExecutionId: started.execution.id,
        },
        method: "POST",
      },
    );
    const completed = await runtime.waitExecution(started.execution.id);
    expect(completed.output).not.toContain(secret);
    const active = await requestResult<{
      readonly actor: Actor;
      readonly id: string;
      readonly status: string;
      readonly version: number;
    }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/secret-input?generation=${session.generation.toString()}`,
    );
    expect(active).toMatchObject({
      actor: bootstrap.actor,
      id: action.sensitiveInputId,
      status: "ACTIVE",
      version: 1,
    });
    const finished = await requestResult<{ readonly status: string; readonly version: number }>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/secret-input/${action.sensitiveInputId}/finish`,
      {
        body: {
          expectedVersion: active.version,
          generation: session.generation,
          idempotencyKey: "console-secret-finish",
          outcome: "completed",
        },
        method: "POST",
      },
    );
    expect(finished).toMatchObject({ status: "COMPLETED", version: 2 });
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    expect(JSON.stringify(events.events)).not.toContain(secret);
  }, 30_000);

  it("exposes checkpoint inspection and attributes an explicit fork to the Human Actor", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await requestBootstrap(consoleServer);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{ readonly actor: Actor }>(bootstrapResponse);

    const parent = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "console-fork-parent-session-create",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const checkpoint = await requestResult<CheckpointResult>(
      consoleServer,
      cookie,
      `/api/sessions/${parent.id}/checkpoint?generation=${parent.generation.toString()}`,
    );
    expect(checkpoint).toMatchObject({ sourceStatus: "READY", stale: false, version: 1 });

    const fork = await requestResult<ForkResult>(
      consoleServer,
      cookie,
      `/api/sessions/${parent.id}/fork`,
      {
        body: {
          allowStale: false,
          expectedCheckpointVersion: checkpoint.version,
          generation: parent.generation,
          idempotencyKey: "m7-console-human-fork",
        },
        method: "POST",
      },
    );
    expect(fork).toMatchObject({
      checkpoint: { version: 2 },
      replayed: false,
      session: {
        lineage: {
          checkpointVersion: 2,
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
        },
        status: "READY",
      },
    });
    const events = await runtime.queryEvents(parent.id, parent.generation, 0, 500);
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: bootstrap.actor, type: "session.fork_requested" }),
        expect.objectContaining({ actor: bootstrap.actor, type: "session.forked" }),
      ]),
    );

    await runtime.closeSession(fork.session.id, fork.session.generation);
    await runtime.closeSession(parent.id, parent.generation);
  }, 30_000);
});

type ApprovalResult = {
  readonly id: string;
  readonly status: string;
  readonly version: number;
};

async function createFixture(fixtures: string[]): Promise<{
  readonly root: string;
  readonly workspace: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m5-console-")));
  fixtures.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function request(
  server: HumanConsoleServerHandle,
  cookie: string,
  path: string,
  options: { readonly body?: unknown; readonly method?: string } = {},
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    headers: {
      cookie,
      "x-iterminal-request": "console",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      origin: server.url,
    },
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function requestBootstrap(server: HumanConsoleServerHandle, cookie?: string): Promise<Response> {
  return fetch(`${server.url}/api/bootstrap`, {
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      "x-iterminal-request": "console",
    },
  });
}

async function requestResult<T>(
  server: HumanConsoleServerHandle,
  cookie: string,
  path: string,
  options: { readonly body?: unknown; readonly method?: string } = {},
): Promise<T> {
  const response = await request(server, cookie, path, options);
  if (!response.ok) throw new Error(`Console request failed: ${await response.text()}`);
  return bodyResult<T>(response);
}

async function bodyResult<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { readonly result?: T };
  if (body.result === undefined) throw new Error("Console response has no result");
  return body.result;
}

async function bodyErrorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { readonly error?: { readonly code?: string } };
  return body.error?.code;
}

function connectStream(
  server: HumanConsoleServerHandle,
  cookie: string,
  session: SessionResult,
): Promise<{ readonly frame: StreamFrame; readonly socket: WebSocket }> {
  const url = new URL(server.url);
  url.protocol = "ws:";
  url.pathname = `/api/sessions/${session.id}/stream`;
  url.searchParams.set("after", "0");
  url.searchParams.set("generation", session.generation.toString());
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url, { headers: { cookie, origin: server.url } });
    const timeout = setTimeout(
      () => rejectSocket(new Error("Timed out waiting for initial stream frame")),
      5_000,
    );
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolveSocket({ frame: JSON.parse(rawDataText(data)) as StreamFrame, socket });
    });
    socket.once("error", rejectSocket);
  });
}

function expectRejectedStream(
  server: HumanConsoleServerHandle,
  cookie: string,
  session: SessionResult,
): Promise<void> {
  return expectRejectedStreamResponse(server, cookie, session, {
    expectedStatus: 403,
  }).then(() => undefined);
}

function expectRejectedStreamResponse(
  server: HumanConsoleServerHandle,
  cookie: string,
  session: SessionResult,
  options: { readonly expectedStatus: number; readonly origin?: string },
): Promise<string> {
  const url = new URL(server.url);
  url.protocol = "ws:";
  url.pathname = `/api/sessions/${session.id}/stream`;
  url.searchParams.set("after", "0");
  url.searchParams.set("generation", session.generation.toString());
  return new Promise((resolveRejected, rejectRejected) => {
    const socket = new WebSocket(url, {
      headers: { cookie, ...(options.origin === undefined ? {} : { origin: options.origin }) },
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectRejected(new Error("Timed out waiting for rejected WebSocket upgrade"));
    }, 5_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      expect(response.statusCode).toBe(options.expectedStatus);
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolveRejected(Buffer.concat(chunks).toString("utf8")));
      response.resume();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      rejectRejected(new Error("WebSocket without Origin unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

function waitForSocketClose(socket: WebSocket): Promise<number> {
  return new Promise((resolveClose, rejectClose) => {
    const timeout = setTimeout(
      () => rejectClose(new Error("Timed out waiting for WebSocket close")),
      5_000,
    );
    socket.once("close", (code) => {
      clearTimeout(timeout);
      resolveClose(code);
    });
    socket.once("error", rejectClose);
  });
}

function rawHttpGet(
  server: HumanConsoleServerHandle,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly body: string; readonly status: number }> {
  const target = new URL(server.url);
  return new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(
      () => rejectResponse(new Error("Timed out waiting for raw HTTP response")),
      5_000,
    );
    const request = httpRequest(
      {
        headers,
        host: target.hostname,
        method: "GET",
        path,
        port: server.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          clearTimeout(timeout);
          resolveResponse({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.once("error", (error) => {
      clearTimeout(timeout);
      rejectResponse(error);
    });
    request.end();
  });
}

function dropHttpResponse(
  server: HumanConsoleServerHandle,
  cookie: string,
  path: string,
  body: unknown,
): Promise<void> {
  const target = new URL(server.url);
  const payload = JSON.stringify(body);
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const request = httpRequest(
      {
        headers: {
          "content-length": Buffer.byteLength(payload).toString(),
          "content-type": "application/json",
          cookie,
          origin: server.url,
          "x-iterminal-request": "console",
        },
        host: target.hostname,
        method: "POST",
        path,
        port: server.port,
      },
      (response) => {
        settled = true;
        response.destroy();
        resolveResponse();
      },
    );
    request.once("error", (error) => {
      if (!settled) rejectResponse(error);
    });
    request.end(payload);
  });
}

function runtimeGateway(daemon: RuntimeDaemonHandle): UnixRuntimeClient {
  return new UnixRuntimeClient(daemon.socketPath);
}

async function waitUntilRunning(runtime: UnixRuntimeClient, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await runtime.getExecution(executionId);
    if (execution.status === "RUNNING") return;
    await delay(10);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitUntilReady(runtime: UnixRuntimeClient, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await runtime.getSession(sessionId)).status === "READY") return;
    await delay(10);
  }
  throw new Error(`Session did not return to READY: ${sessionId}`);
}

async function waitForFileContent(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readFile(path, "utf8").catch(() => undefined)) === expected) return;
    await delay(10);
  }
  throw new Error(`Fixture file did not reach expected content: ${path}`);
}

async function waitUntilGuardReleased(
  runtime: UnixRuntimeClient,
  sessionId: string,
  generation: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await runtime.getInteractionState(sessionId, generation);
    if (state.guard === undefined) return;
    await delay(10);
  }
  throw new Error("Console disconnect did not release its Interaction Guard");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected fixture value");
  return value;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface CheckpointResult {
  readonly sourceStatus: string;
  readonly stale: boolean;
  readonly version: number;
}

interface ForkResult {
  readonly checkpoint: CheckpointResult;
  readonly replayed: boolean;
  readonly session: SessionResult & {
    readonly lineage?: {
      readonly checkpointVersion: number;
      readonly parentGeneration: number;
      readonly parentSessionId: string;
    };
    readonly status: string;
  };
}

interface StreamFrame {
  readonly screen?: { readonly columns: number; readonly rows: number };
  readonly type: string;
}
