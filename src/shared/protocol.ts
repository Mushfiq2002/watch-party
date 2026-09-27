export const ROOM_CAPACITY = 2;
export const PLAYBACK_IGNORE_MS = 300;
export const PLAYBACK_DRIFT_S = 0.4;
export const HEARTBEAT_MS = 5000;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}$/;
export const MAX_NAME_LENGTH = 32;
export const MAX_CHAT_LENGTH = 2000;
export const MAX_SUBTITLE_TEXT_LENGTH = 2000;
export const MAX_SUBTITLE_TRACK_NAME_LENGTH = 120;

export type PeerRole = "host" | "guest";
/**
 * file-share sends the original file to the guest, so both play a local copy.
 * file-stream re-encodes live over WebRTC, which is lower quality but instant.
 */
export type WatchMode = "idle" | "file-share" | "file-stream" | "url";
export type PlaybackAction = "play" | "pause" | "seek" | "heartbeat";

export type PeerInfo = {
  id: string;
  name: string;
  role: PeerRole;
};

export type MediaSource = "cam" | "movie";

export type MediaPublication = {
  source: MediaSource;
  sessionId: string;
  tracks: Array<{
    trackName: string;
    kind: "audio" | "video";
  }>;
};

export type PeerMedia = {
  from: string;
  publications: MediaPublication[];
};

export type PlaybackPayload = {
  action: PlaybackAction;
  t: number;
  at: number;
  /** Host duration in seconds, so a guest watching the stream can show a real timeline. */
  d?: number;
};

export type SubtitleState = {
  /** Empty means no subtitle file is loaded; an empty text means a gap between cues. */
  trackName: string;
  text: string;
  start: number;
  end: number;
};

export type ClientMessage =
  | { type: "hello" }
  | { type: "chat"; payload: { text: string } }
  | { type: "playback"; payload: PlaybackPayload }
  | { type: "subtitle"; payload: SubtitleState }
  | { type: "media"; payload: { publications: MediaPublication[] } }
  | { type: "mode"; payload: { mode: WatchMode; url?: string } };

export type ChatMessage = {
  from: string;
  name: string;
  text: string;
  at: number;
};

export type ServerMessage =
  | {
      type: "joined";
      payload: {
        you: PeerInfo;
        peers: PeerInfo[];
        roomCode: string;
        mode: WatchMode;
        url?: string;
        playback?: PlaybackPayload;
        subtitle?: SubtitleState;
        hostKey?: string;
        mediaToken: string;
        media: PeerMedia[];
      };
    }
  | { type: "roster"; payload: { peers: PeerInfo[] } }
  | { type: "peer-joined"; payload: PeerInfo }
  | { type: "peer-left"; payload: { id: string; name: string; role: PeerRole } }
  | { type: "role"; payload: PeerInfo }
  | { type: "host-key"; payload: { hostKey: string } }
  | { type: "chat"; payload: ChatMessage }
  | { type: "playback"; payload: PlaybackPayload & { from: string } }
  | { type: "subtitle"; payload: SubtitleState & { from: string } }
  | { type: "media"; payload: PeerMedia }
  | { type: "mode"; payload: { mode: WatchMode; url?: string; from: string } }
  | { type: "error"; payload: { code: string; message: string } };
