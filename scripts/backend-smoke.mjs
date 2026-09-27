import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:5173");
const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

class TestClient {
  constructor(label, socket) {
    this.label = label;
    this.socket = socket;
    this.messages = [];
    this.waiters = new Set();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.messages.push(message);
      for (const waiter of this.waiters) {
        waiter();
      }
    });
  }

  async waitFor(type, predicate = () => true, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(
        (message) => message.type === type && predicate(message.payload),
      );
      if (index !== -1) {
        return this.messages.splice(index, 1)[0];
      }

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`${this.label} did not receive ${type}`));
        }, Math.max(1, deadline - Date.now()));
        const wake = () => {
          clearTimeout(timeout);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
    throw new Error(`${this.label} did not receive ${type}`);
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close(1000, "test complete");
  }
}

async function connect(code, label, options = {}) {
  const url = new URL(`/ws/${code}`, baseUrl);
  url.protocol = wsProtocol;
  url.searchParams.set("name", label);
  url.searchParams.set("clientId", options.clientId ?? crypto.randomUUID());
  if (options.hostKey) {
    url.searchParams.set("hostKey", options.hostKey);
  }

  const socket = new WebSocket(url);
  const client = new TestClient(label, socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`${label} WebSocket failed to open`)),
      { once: true },
    );
  });
  return client;
}

async function run() {
  const roomResponse = await fetch(new URL("/api/rooms", baseUrl), { method: "POST" });
  assert.equal(roomResponse.status, 200);
  const { code } = await roomResponse.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);

  const hostKey = crypto.randomUUID();
  const host = await connect(code, "Host", { hostKey });
  const hostJoined = await host.waitFor("joined");
  assert.equal(hostJoined.payload.you.role, "host");
  assert.equal(hostJoined.payload.hostKey, hostKey);
  assert.match(hostJoined.payload.mediaToken, /^[0-9a-f-]{36}$/i);

  const guest = await connect(code, "Guest");
  const guestJoined = await guest.waitFor("joined");
  assert.equal(guestJoined.payload.you.role, "guest");
  assert.equal(guestJoined.payload.peers.length, 1);
  await host.waitFor("peer-joined", (peer) => peer.name === "Guest");

  const mediaSessionResponse = await fetch(
    new URL(`/api/rooms/${code}/realtime/session`, baseUrl),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${hostJoined.payload.mediaToken}` },
    },
  );
  if (baseUrl.protocol === "https:") {
    assert.equal(mediaSessionResponse.status, 200);
    const mediaSession = await mediaSessionResponse.json();
    assert.equal(typeof mediaSession.sessionId, "string");
    host.send({
      type: "media",
      payload: {
        publications: [
          {
            source: "cam",
            sessionId: mediaSession.sessionId,
            tracks: [{ trackName: "smoke-video-track", kind: "video" }],
          },
        ],
      },
    });
    await guest.waitFor(
      "media",
      (media) => media.publications[0]?.tracks[0]?.trackName === "smoke-video-track",
    );

    const resetResponse = await fetch(
      new URL(`/api/rooms/${code}/realtime/session`, baseUrl),
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${hostJoined.payload.mediaToken}` },
      },
    );
    assert.equal(resetResponse.status, 204);
    await guest.waitFor(
      "media",
      (media) => media.from === hostJoined.payload.you.id && media.publications.length === 0,
    );

    const replacementResponse = await fetch(
      new URL(`/api/rooms/${code}/realtime/session`, baseUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostJoined.payload.mediaToken}` },
      },
    );
    assert.equal(replacementResponse.status, 200);
    const replacementSession = await replacementResponse.json();
    assert.equal(typeof replacementSession.sessionId, "string");
    assert.notEqual(replacementSession.sessionId, mediaSession.sessionId);
  } else {
    assert.equal(mediaSessionResponse.status, 503);
  }

  guest.send({ type: "chat", payload: { text: "hello from guest" } });
  await Promise.all([
    host.waitFor("chat", (chat) => chat.text === "hello from guest"),
    guest.waitFor("chat", (chat) => chat.text === "hello from guest"),
  ]);

  const movieUrl = "https://example.com/movie.mp4";
  host.send({ type: "mode", payload: { mode: "url", url: movieUrl } });
  await Promise.all([
    host.waitFor("mode", (mode) => mode.url === movieUrl),
    guest.waitFor("mode", (mode) => mode.url === movieUrl),
  ]);

  host.send({
    type: "playback",
    payload: { action: "play", t: 12.5, at: Date.now(), d: 120 },
  });
  await guest.waitFor("playback", (playback) => playback.t === 12.5);

  const subtitle = {
    trackName: "English.srt",
    text: "A synchronized subtitle cue.",
    start: 12,
    end: 15,
  };
  host.send({ type: "subtitle", payload: subtitle });
  await Promise.all([
    host.waitFor("subtitle", (cue) => cue.text === subtitle.text),
    guest.waitFor("subtitle", (cue) => cue.text === subtitle.text),
  ]);

  const third = await connect(code, "Third");
  const roomFull = await third.waitFor("error");
  assert.equal(roomFull.payload.code, "room-full");
  third.close();

  guest.close();
  await host.waitFor("peer-left", (peer) => peer.name === "Guest");

  const lateGuest = await connect(code, "Late guest");
  const lateJoined = await lateGuest.waitFor("joined");
  assert.equal(lateJoined.payload.mode, "url");
  assert.equal(lateJoined.payload.url, movieUrl);
  assert.equal(lateJoined.payload.playback.t, 12.5);
  assert.equal(lateJoined.payload.subtitle.trackName, "English.srt");
  assert.equal(lateJoined.payload.subtitle.text, subtitle.text);

  host.close();
  const [promoted] = await Promise.all([
    lateGuest.waitFor("role", (peer) => peer.name === "Late guest"),
    lateGuest.waitFor("subtitle", (cue) => cue.trackName === ""),
  ]);
  assert.equal(promoted.payload.role, "host");
  const promotedKey = await lateGuest.waitFor("host-key");
  assert.match(promotedKey.payload.hostKey, /^[0-9a-f-]{36}$/i);

  lateGuest.close();
  console.log(`backend smoke test passed for ${baseUrl.origin} (room ${code})`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
