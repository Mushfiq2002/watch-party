import { DurableObject } from "cloudflare:workers";
import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SUBTITLE_TEXT_LENGTH,
  MAX_SUBTITLE_TRACK_NAME_LENGTH,
  type MediaPublication,
  ROOM_CAPACITY,
  type ClientMessage,
  type PlaybackPayload,
  type PeerInfo,
  type ServerMessage,
  type SubtitleState,
  type WatchMode,
} from "../shared/protocol";
import { isRecord, type PeerAttachment } from "./types";

type RealtimeEnv = Env & {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
};

type IceServerConfig = {
  urls: string[];
  username?: string;
  credential?: string;
};

const META = {
  hostKey: "hostKey",
  mode: "mode",
  url: "url",
  playback: "playback",
  subtitle: "subtitle",
} as const;

export class Room extends DurableObject<RealtimeEnv> {
  constructor(ctx: DurableObjectState, env: RealtimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const currentVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
      )
      .one().version;

    if (currentVersion < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.includes("/realtime/")) {
      return this.handleRealtime(request, url);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "Expected WebSocket" }, { status: 426 });
    }

    const name = sanitizeName(url.searchParams.get("name"));
    const hostKey = url.searchParams.get("hostKey") ?? "";
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const sockets = this.liveSockets();
    const others = sockets.filter((socket) => readAttachment(socket)?.clientId !== clientId);
    if (others.length >= ROOM_CAPACITY) {
      server.accept();
      safeSend(server, {
        type: "error",
        payload: {
          code: "room-full",
          message: "This room already has two people.",
        },
      });
      server.close(4000, "Room is full");
      return new Response(null, { status: 101, webSocket: client });
    }

    for (const socket of sockets) {
      if (readAttachment(socket)?.clientId === clientId) {
        safeSend(socket, {
          type: "error",
          payload: {
            code: "replaced",
            message: "This room was opened in another tab.",
          },
        });
        socket.close(4001, "replaced");
      }
    }

    const storedHostKey = this.getMeta(META.hostKey);
    let role: PeerAttachment["role"] = "guest";
    let assignedHostKey = storedHostKey;
    if (!storedHostKey || sockets.length === 0) {
      assignedHostKey = hostKey || crypto.randomUUID();
      this.putMeta(META.hostKey, assignedHostKey);
      role = "host";
    } else if (hostKey && hostKey === storedHostKey) {
      role = "host";
      this.demoteOtherHosts(others);
    }

    const attachment: PeerAttachment = {
      id: crypto.randomUUID(),
      name,
      role,
      clientId,
      hostKey: role === "host" ? assignedHostKey : undefined,
      mediaToken: crypto.randomUUID(),
      publications: [],
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    const you = toPeerInfo(attachment);
    const peers = this.liveSockets()
      .map(readAttachment)
      .filter((peer): peer is PeerAttachment => peer !== null && peer.clientId !== clientId)
      .map(toPeerInfo);
    const mode = parseMode(this.getMeta(META.mode));
    const videoUrl = this.getMeta(META.url) || undefined;
    const playback = parsePlayback(this.getMeta(META.playback));
    const subtitle = parseStoredSubtitle(this.getMeta(META.subtitle));
    const media = this.liveSockets()
      .map(readAttachment)
      .filter(
        (peer): peer is PeerAttachment =>
          peer !== null && peer.clientId !== clientId && Boolean(peer.publications?.length),
      )
      .map((peer) => ({ from: peer.id, publications: peer.publications ?? [] }));

    safeSend(server, {
      type: "joined",
      payload: {
        you,
        peers,
        roomCode: url.pathname.split("/").pop()?.toUpperCase() ?? "",
        mode,
        url: videoUrl,
        playback,
        subtitle,
        hostKey: role === "host" ? assignedHostKey : undefined,
        mediaToken: attachment.mediaToken,
        media,
      },
    });

    this.broadcastExcept(server, { type: "peer-joined", payload: you });
    this.broadcastRoster();
    await this.ctx.storage.setAlarm(Date.now() + 800);
    console.log(
      JSON.stringify({
        level: "info",
        msg: "room_join",
        peers: peers.length + 1,
        role,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed) {
      safeSend(ws, {
        type: "error",
        payload: { code: "bad-message", message: "Unrecognized message." },
      });
      return;
    }

    const self = readAttachment(ws);
    if (!self) {
      return;
    }

    switch (parsed.type) {
      case "hello": {
        this.broadcastRoster();
        return;
      }
      case "chat": {
        const text = parsed.payload.text.trim().slice(0, MAX_CHAT_LENGTH);
        if (!text) {
          return;
        }
        this.broadcast({
          type: "chat",
          payload: { from: self.id, name: self.name, text, at: Date.now() },
        });
        return;
      }
      case "playback": {
        this.putMeta(META.playback, JSON.stringify(parsed.payload));
        this.broadcastExcept(ws, {
          type: "playback",
          payload: { ...parsed.payload, from: self.id },
        });
        return;
      }
      case "subtitle": {
        if (self.role !== "host") {
          safeSend(ws, {
            type: "error",
            payload: { code: "host-only", message: "Only the host can change subtitles." },
          });
          return;
        }
        const subtitle = parsed.payload;
        if (subtitle.trackName) {
          this.putMeta(META.subtitle, JSON.stringify(subtitle));
        } else {
          this.deleteMeta(META.subtitle);
        }
        this.broadcast({
          type: "subtitle",
          payload: { ...subtitle, from: self.id },
        });
        return;
      }
      case "mode": {
        const mode = parsed.payload.mode;
        const videoUrl = parsed.payload.url?.trim() ?? "";
        this.putMeta(META.mode, mode);
        if (mode === "url" && videoUrl) {
          this.putMeta(META.url, videoUrl);
        } else {
          this.deleteMeta(META.url);
        }
        this.broadcast({
          type: "mode",
          payload: { mode, url: videoUrl || undefined, from: self.id },
        });
        return;
      }
      case "media": {
        const publications = parsed.payload.publications.filter(
          (publication) => publication.sessionId === self.sfuSessionId,
        );
        const updated: PeerAttachment = { ...self, publications };
        ws.serializeAttachment(updated);
        this.broadcastExcept(ws, {
          type: "media",
          payload: { from: self.id, publications },
        });
        return;
      }
    }
  }

  private async handleRealtime(request: Request, url: URL): Promise<Response> {
    if (!this.env.CALLS_APP_ID || this.env.CALLS_APP_ID === "your-app-id" || !this.env.CALLS_APP_SECRET) {
      return Response.json({ error: "Realtime SFU is not configured" }, { status: 503 });
    }

    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const socket = await this.findSocketByMediaToken(token);
    const peer = socket ? readAttachment(socket) : null;
    if (!socket || !peer) {
      return Response.json({ error: "Your live room seat could not be verified" }, { status: 401 });
    }

    const action = url.pathname.split("/realtime/")[1];
    if (action === "ice-servers") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return this.getIceServers();
    }

    if (action === "session") {
      if (request.method === "DELETE") {
        if (peer.sfuSessionId) {
          const closed = await this.callsFetch(`/sessions/${peer.sfuSessionId}`, { method: "DELETE" });
          // 404/410 means Cloudflare has already dropped the session. Forget the
          // local seat anyway so the next POST can create a new one.
          if (!closed.ok && closed.status !== 404 && closed.status !== 410) {
            return closed;
          }
          await closed.body?.cancel().catch(() => undefined);
        }
        const resetPeer: PeerAttachment = {
          id: peer.id,
          name: peer.name,
          role: peer.role,
          clientId: peer.clientId,
          hostKey: peer.hostKey,
          mediaToken: peer.mediaToken,
          publications: [],
        };
        socket.serializeAttachment(resetPeer);
        this.broadcastExcept(socket, {
          type: "media",
          payload: { from: peer.id, publications: [] },
        });
        console.log(JSON.stringify({ level: "info", msg: "realtime_session_reset" }));
        return new Response(null, { status: 204 });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (peer.sfuSessionId) {
        return Response.json({ sessionId: peer.sfuSessionId });
      }
      const response = await this.callsFetch("/sessions/new", { method: "POST" });
      if (!response.ok) {
        return response;
      }
      const body = (await response.json()) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string") {
        return Response.json({ error: "Cloudflare did not return a session ID" }, { status: 502 });
      }
      socket.serializeAttachment({ ...peer, sfuSessionId: body.sessionId });
      return Response.json({ sessionId: body.sessionId });
    }

    if (!peer.sfuSessionId) {
      return Response.json({ error: "Create a media session first" }, { status: 409 });
    }

    const allowed =
      (action === "tracks/new" && request.method === "POST") ||
      (action === "renegotiate" && request.method === "PUT") ||
      (action === "tracks/close" && request.method === "PUT");
    if (!allowed) {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) {
      return Response.json({ error: "Realtime request is too large" }, { status: 413 });
    }
    return this.callsFetch(`/sessions/${peer.sfuSessionId}/${action}`, {
      method: request.method,
      body: rawBody,
    });
  }

  private async getIceServers(): Promise<Response> {
    const fallback = [{ urls: "stun:stun.cloudflare.com:3478" }];
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) {
      return Response.json({ iceServers: fallback });
    }

    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 86_400 }),
        },
      );
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "turn_credentials_failed",
            status: response.status,
          }),
        );
        return Response.json({ iceServers: fallback });
      }
      const payload = (await response.json()) as { iceServers?: unknown };
      const iceServers = sanitizeIceServers(payload.iceServers);
      return Response.json({ iceServers: iceServers.length > 0 ? iceServers : fallback });
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "turn_credentials_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json({ iceServers: fallback });
    }
  }

  private async callsFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${this.env.CALLS_APP_ID}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.env.CALLS_APP_SECRET}`,
            "Content-Type": "application/json",
          },
        },
      );
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "realtime_sfu_request_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json({ error: "Cloudflare Realtime could not be reached" }, { status: 502 });
    }
  }

  private async findSocketByMediaToken(provided: string): Promise<WebSocket | undefined> {
    const encoder = new TextEncoder();
    const providedHash = await crypto.subtle.digest("SHA-256", encoder.encode(provided));
    for (const socket of this.liveSockets()) {
      const expected = readAttachment(socket)?.mediaToken ?? "";
      const expectedHash = await crypto.subtle.digest("SHA-256", encoder.encode(expected));
      if (crypto.subtle.timingSafeEqual(providedHash, expectedHash)) {
        return socket;
      }
    }
    return undefined;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const self = readAttachment(ws);
    if (!self) {
      return;
    }
    const replaced = this.ctx
      .getWebSockets()
      .some((socket) => socket !== ws && readAttachment(socket)?.clientId === self.clientId);
    if (replaced) {
      this.broadcastRoster(ws);
      return;
    }
    this.broadcast({
      type: "peer-left",
      payload: { id: self.id, name: self.name, role: self.role },
    });

    if (self.role === "host") {
      this.deleteMeta(META.subtitle);
      this.broadcast({
        type: "subtitle",
        payload: { trackName: "", text: "", start: 0, end: 0, from: self.id },
      });
      const remaining = this.liveSockets().filter((socket) => socket !== ws);
      const next = remaining[0];
      if (next) {
        const attachment = readAttachment(next);
        if (attachment) {
          const nextHostKey = crypto.randomUUID();
          this.putMeta(META.hostKey, nextHostKey);
          const promoted: PeerAttachment = {
            ...attachment,
            role: "host",
            hostKey: nextHostKey,
          };
          next.serializeAttachment(promoted);
          this.broadcast({ type: "role", payload: toPeerInfo(promoted) });
          safeSend(next, { type: "host-key", payload: { hostKey: nextHostKey } });
        }
      } else {
        this.deleteMeta(META.hostKey);
      }
    }

    this.broadcastRoster(ws);
    await this.ctx.storage.setAlarm(Date.now() + 800);

    console.log(
      JSON.stringify({
        level: "info",
        msg: "room_leave",
        remaining: Math.max(this.ctx.getWebSockets().length - 1, 0),
      }),
    );
  }

  async alarm(): Promise<void> {
    this.broadcastRoster();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "ws_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await this.webSocketClose(ws);
  }

  private demoteOtherHosts(sockets: WebSocket[]): void {
    for (const socket of sockets) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "host") {
        const guest: PeerAttachment = { ...attachment, role: "guest" };
        socket.serializeAttachment(guest);
        this.broadcast({ type: "role", payload: toPeerInfo(guest) });
      }
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      safeSend(socket, message);
    }
  }

  private broadcastExcept(except: WebSocket, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) {
        safeSend(socket, message);
      }
    }
  }

  /** Closing sockets linger in getWebSockets(), which used to show a phantom third person. */
  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === 1);
  }

  private broadcastRoster(except?: WebSocket): void {
    const sockets = this.liveSockets().filter((socket) => socket !== except);
    const seen = new Set<string>();
    const roster = sockets
      .map(readAttachment)
      .filter((peer): peer is PeerAttachment => {
        if (peer === null || seen.has(peer.clientId)) {
          return false;
        }
        seen.add(peer.clientId);
        return true;
      })
      .map(toPeerInfo);
    for (const socket of sockets) {
      const self = readAttachment(socket);
      if (!self) {
        continue;
      }
      safeSend(socket, {
        type: "roster",
        payload: { peers: roster.filter((peer) => peer.id !== self.id) },
      });
    }
  }

  private getMeta(key: string): string {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM room_state WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? "";
  }

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO room_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private deleteMeta(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM room_state WHERE key = ?", key);
  }
}

function sanitizeName(raw: string | null): string {
  const name = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return name || "Friend";
}

function toPeerInfo(peer: PeerAttachment): PeerInfo {
  return { id: peer.id, name: peer.name, role: peer.role };
}

function readAttachment(ws: WebSocket): PeerAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (value.role !== "host" && value.role !== "guest") {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    clientId: typeof value.clientId === "string" ? value.clientId : "",
    hostKey: typeof value.hostKey === "string" ? value.hostKey : undefined,
    mediaToken: typeof value.mediaToken === "string" ? value.mediaToken : "",
    sfuSessionId: typeof value.sfuSessionId === "string" ? value.sfuSessionId : undefined,
    publications: parsePublications(value.publications),
  };
}

function safeSend(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "ws_send_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function parseMode(value: string): WatchMode {
  if (value === "file-share" || value === "file-stream" || value === "url" || value === "idle") {
    return value;
  }
  return "idle";
}

function parsePlayback(raw: string): PlaybackPayload | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) {
      return undefined;
    }
    if (
      (value.action === "play" ||
        value.action === "pause" ||
        value.action === "seek" ||
        value.action === "heartbeat") &&
      typeof value.t === "number" &&
      typeof value.at === "number"
    ) {
      return {
        action: value.action,
        t: value.t,
        at: value.at,
        d: typeof value.d === "number" ? value.d : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseStoredSubtitle(raw: string): SubtitleState | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return parseSubtitleState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 20_000) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "hello": {
      return { type: "hello" };
    }
    case "chat": {
      if (!isRecord(value.payload) || typeof value.payload.text !== "string") {
        return null;
      }
      return { type: "chat", payload: { text: value.payload.text } };
    }
    case "playback": {
      const payload = value.payload;
      if (!isRecord(payload) || typeof payload.t !== "number" || typeof payload.at !== "number") {
        return null;
      }
      if (
        payload.action !== "play" &&
        payload.action !== "pause" &&
        payload.action !== "seek" &&
        payload.action !== "heartbeat"
      ) {
        return null;
      }
      return {
        type: "playback",
        payload: {
          action: payload.action,
          t: payload.t,
          at: payload.at,
          d: typeof payload.d === "number" ? payload.d : undefined,
        },
      };
    }
    case "subtitle": {
      const payload = parseSubtitleState(value.payload);
      return payload ? { type: "subtitle", payload } : null;
    }
    case "mode": {
      if (!isRecord(value.payload)) {
        return null;
      }
      const mode = value.payload.mode;
      if (mode !== "idle" && mode !== "file-share" && mode !== "file-stream" && mode !== "url") {
        return null;
      }
      const url = value.payload.url;
      return {
        type: "mode",
        payload: { mode, url: typeof url === "string" ? url : undefined },
      };
    }
    case "media": {
      if (!isRecord(value.payload)) {
        return null;
      }
      const publications = parsePublications(value.payload.publications);
      if (!publications) {
        return null;
      }
      return { type: "media", payload: { publications } };
    }
    default:
      return null;
  }
}

function parseSubtitleState(value: unknown): SubtitleState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.trackName !== "string" ||
    typeof value.text !== "string" ||
    typeof value.start !== "number" ||
    typeof value.end !== "number" ||
    !Number.isFinite(value.start) ||
    !Number.isFinite(value.end) ||
    value.start < 0 ||
    value.end < value.start ||
    value.end > 172_800
  ) {
    return undefined;
  }
  const trackName = value.trackName.trim().slice(0, MAX_SUBTITLE_TRACK_NAME_LENGTH);
  return {
    trackName,
    text: trackName ? value.text.trim().slice(0, MAX_SUBTITLE_TEXT_LENGTH) : "",
    start: trackName ? value.start : 0,
    end: trackName ? value.end : 0,
  };
}

function parsePublications(value: unknown): MediaPublication[] | undefined {
  if (!Array.isArray(value) || value.length > 2) {
    return undefined;
  }
  const publications: MediaPublication[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.source !== "cam" && item.source !== "movie")) {
      return undefined;
    }
    if (typeof item.sessionId !== "string" || item.sessionId.length > 128 || !Array.isArray(item.tracks)) {
      return undefined;
    }
    if (item.tracks.length > 2) {
      return undefined;
    }
    const tracks: MediaPublication["tracks"] = [];
    for (const track of item.tracks) {
      if (
        !isRecord(track) ||
        typeof track.trackName !== "string" ||
        track.trackName.length > 256 ||
        (track.kind !== "audio" && track.kind !== "video")
      ) {
        return undefined;
      }
      tracks.push({ trackName: track.trackName, kind: track.kind });
    }
    publications.push({ source: item.source, sessionId: item.sessionId, tracks });
  }
  return publications;
}

function sanitizeIceServers(value: unknown): IceServerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const servers: IceServerConfig[] = [];
  for (const item of value.slice(0, 4)) {
    if (!isRecord(item)) {
      continue;
    }
    const rawUrls = typeof item.urls === "string" ? [item.urls] : item.urls;
    if (!Array.isArray(rawUrls)) {
      continue;
    }
    const urls = rawUrls.filter(
      (url): url is string =>
        typeof url === "string" &&
        url.length <= 256 &&
        /^(stun|turn|turns):/.test(url) &&
        !/:53(?:\?|$)/.test(url),
    );
    if (urls.length === 0) {
      continue;
    }
    servers.push({
      urls,
      username: typeof item.username === "string" ? item.username.slice(0, 512) : undefined,
      credential: typeof item.credential === "string" ? item.credential.slice(0, 512) : undefined,
    });
  }
  return servers;
}
