import { ROOM_CODE_PATTERN } from "../shared/protocol";
import { Room } from "./room";

export { Room };

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomRoomCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return Response.json({ code: randomRoomCode() });
    }

    const realtimeMatch = url.pathname.match(
      /^\/api\/rooms\/([A-Za-z0-9]+)\/realtime\/(session|tracks\/new|renegotiate|tracks\/close)$/i,
    );
    if (realtimeMatch) {
      const code = realtimeMatch[1].toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) {
        return Response.json({ error: "Invalid room code" }, { status: 400 });
      }
      return env.ROOM.getByName(code).fetch(request);
    }

    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/i);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) {
        return Response.json({ error: "Invalid room code" }, { status: 400 });
      }
      const stub = env.ROOM.getByName(code);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
