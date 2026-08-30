import { createConnection, createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startTcpFaultProxy, type TcpFaultProxy } from "./tcp-fault-proxy.js";

describe("TCP fault proxy", () => {
  const sockets: Socket[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("drops bytes without closing the connection and can restore forwarding", async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    await listen(upstream);
    cleanups.push(() => closeServer(upstream));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("Missing upstream port");
    const proxy = await startTcpFaultProxy({
      upstreamHost: "127.0.0.1",
      upstreamPort: address.port,
    });
    cleanups.push(() => proxy.close());
    const client = await connect(proxy);
    sockets.push(client);
    const received: string[] = [];
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => received.push(chunk));

    client.write("before");
    await waitFor(() => received.join("").includes("before"));
    proxy.setMode("BLACKHOLE");
    client.write("dropped");
    await delay(50);
    expect(received.join("")).not.toContain("dropped");
    expect(client.destroyed).toBe(false);

    proxy.setMode("FORWARD");
    client.write("after");
    await waitFor(() => received.join("").includes("after"));
    expect(received.join("")).toBe("beforeafter");
  });
});

function connect(proxy: TcpFaultProxy): Promise<Socket> {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = createConnection({ host: proxy.host, port: proxy.port });
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", rejectConnect);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("listening", () => resolveListen());
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for TCP proxy condition");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
