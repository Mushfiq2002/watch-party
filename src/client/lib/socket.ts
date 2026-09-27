import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export type RoomSocket = {
  send: (message: ClientMessage) => void;
  close: () => void;
};

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;

export function openRoomSocket(options: {
  code: string;
  name: string;
  hostKey?: string | null;
  clientId?: string | null;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: "connecting" | "open" | "closed") => void;
}): RoomSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ name: options.name });
  if (options.hostKey) {
    params.set("hostKey", options.hostKey);
  }
  if (options.clientId) {
    params.set("clientId", options.clientId);
  }
  const url = `${protocol}//${window.location.host}/ws/${options.code}?${params.toString()}`;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let manuallyClosed = false;

  function connect() {
    if (manuallyClosed) {
      return;
    }
    options.onStatus("connecting");
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener("open", () => {
      if (socket !== ws || manuallyClosed) {
        return;
      }
      reconnectAttempt = 0;
      options.onStatus("open");
    });

    socket.addEventListener("message", (event) => {
      if (socket !== ws || typeof event.data !== "string") {
        return;
      }
      const parsed = parseServerMessage(event.data);
      if (parsed) {
        options.onMessage(parsed);
      }
    });

    socket.addEventListener("close", (event) => {
      if (socket !== ws || manuallyClosed) {
        return;
      }
      ws = null;
      options.onStatus("closed");
      // These are deliberate server rejections. Reconnecting would either hammer a
      // full room or make two tabs continuously replace each other.
      if (event.code === 4000 || event.code === 4001) {
        manuallyClosed = true;
        return;
      }
      const backoff = Math.min(INITIAL_RECONNECT_MS * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
      const jitter = Math.floor(Math.random() * 250);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, backoff + jitter);
    });
  }

  connect();

  return {
    send(message) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    close() {
      manuallyClosed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close(1000, "leave");
      ws = null;
    },
  };
}

function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("type" in value)) {
      return null;
    }
    return value as ServerMessage;
  } catch {
    return null;
  }
}
