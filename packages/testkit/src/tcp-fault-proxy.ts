import { createConnection, createServer, type Server, type Socket } from "node:net";

export type TcpFaultMode = "BLACKHOLE" | "CUT" | "FORWARD";

export interface TcpFaultProxy {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  mode(): TcpFaultMode;
  setMode(mode: TcpFaultMode): void;
}

export async function startTcpFaultProxy(options: {
  readonly listenHost?: string;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
}): Promise<TcpFaultProxy> {
  validatePort(options.upstreamPort, "upstreamPort");
  const listenHost = options.listenHost ?? "127.0.0.1";
  const connections = new Set<SocketPair>();
  let currentMode: TcpFaultMode = "FORWARD";
  let closed = false;
  const server = createServer((downstream) => {
    downstream.on("error", () => undefined);
    if (closed || currentMode === "CUT") {
      downstream.destroy();
      return;
    }
    downstream.pause();
    const upstream = createConnection({ host: options.upstreamHost, port: options.upstreamPort });
    upstream.on("error", () => undefined);
    const pair: SocketPair = { downstream, upstream };
    connections.add(pair);
    const remove = (): void => {
      connections.delete(pair);
      downstream.destroy();
      upstream.destroy();
    };
    downstream.once("close", remove);
    upstream.once("close", remove);
    upstream.once("connect", () => applyMode(pair, currentMode));
  });
  await listen(server, listenHost);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("TCP fault proxy did not bind an IP socket");
  }
  return {
    host: listenHost,
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      currentMode = "CUT";
      for (const pair of connections) applyMode(pair, "CUT");
      connections.clear();
      await closeServer(server);
    },
    mode: () => currentMode,
    setMode: (mode) => {
      if (closed) throw new Error("TCP fault proxy is closed");
      currentMode = mode;
      for (const pair of connections) applyMode(pair, mode);
    },
  };
}

interface SocketPair {
  readonly downstream: Socket;
  readonly upstream: Socket;
}

const discard = (): void => undefined;

function applyMode(pair: SocketPair, mode: TcpFaultMode): void {
  pair.downstream.unpipe(pair.upstream);
  pair.upstream.unpipe(pair.downstream);
  pair.downstream.off("data", discard);
  pair.upstream.off("data", discard);
  if (mode === "CUT") {
    pair.downstream.destroy();
    pair.upstream.destroy();
    return;
  }
  if (mode === "BLACKHOLE") {
    pair.downstream.on("data", discard);
    pair.upstream.on("data", discard);
    pair.downstream.resume();
    pair.upstream.resume();
    return;
  }
  pair.downstream.pause();
  pair.upstream.pause();
  pair.downstream.pipe(pair.upstream);
  pair.upstream.pipe(pair.downstream);
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

function validatePort(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}
