/** Owns exactly one socket and reconnect timer. Component unmount cancels both. */
export function connectConsoleStream(options: {
  sessionId: string;
  generation: number;
  resume(): { cursor: number; screenVersion: number | undefined };
  onSocket(socket: WebSocket | undefined): void;
  onState(state: "connecting" | "offline"): void;
  onFrame(value: unknown, socket: WebSocket): void;
  onError(error: unknown): void;
}): () => void {
  let disposed = false,
    attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  const connect = () => {
    if (disposed) return;
    options.onState("connecting");
    const resume = options.resume();
    const query = new URLSearchParams({
      after: String(resume.cursor),
      generation: String(options.generation),
      ...(resume.screenVersion === undefined
        ? {}
        : { afterScreenVersion: String(resume.screenVersion) }),
    });
    const next = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(options.sessionId)}/stream?${query}`,
    );
    socket = next;
    options.onSocket(next);
    next.onopen = () => {
      attempt = 0;
    };
    next.onmessage = (message) => {
      if (disposed || socket !== next) return;
      try {
        options.onFrame(JSON.parse(String(message.data)) as unknown, next);
      } catch (error) {
        options.onError(error);
      }
    };
    next.onclose = () => {
      if (disposed) return;
      options.onState("offline");
      timer = setTimeout(connect, Math.min(5_000, 250 * 2 ** attempt++));
    };
    next.onerror = () => {
      if (!disposed) options.onState("offline");
    };
  };
  connect();
  return () => {
    disposed = true;
    clearTimeout(timer);
    socket?.close(1000, "session changed");
    options.onSocket(undefined);
  };
}
