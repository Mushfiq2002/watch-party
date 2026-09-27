import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ClientMessage,
  MediaPublication,
  PeerInfo,
  PlaybackPayload,
  SubtitleState,
  WatchMode,
} from "../../shared/protocol";
import type { RoomStart } from "../lib/start";
import { loadClientId, loadHostKey, loadName, saveHostKey, saveName } from "../lib/storage";
import { openRoomSocket, type RoomSocket } from "../lib/socket";
import { getCameraStream, RealtimePeer, RealtimeRequestError, resetRealtimeSession } from "../lib/realtime";
import { Cameras } from "./Cameras";
import { Chat } from "./Chat";
import { Diagnostics } from "./Diagnostics";
import { MovieStage } from "./MovieStage";

const DISCONNECT_REBUILD_MS = 8_000;

function connectionIsUp(peer: RealtimePeer): boolean {
  const state = peer.pc.connectionState;
  return state === "new" || state === "connecting" || state === "connected";
}

function mediaFailureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

function retryMedia(peer: RealtimePeer, error: unknown): boolean {
  if (!connectionIsUp(peer)) {
    return false;
  }
  return !(error instanceof RealtimeRequestError && error.status >= 400 && error.status < 500);
}

async function publishSource(peer: RealtimePeer, source: "cam" | "movie", stream: MediaStream): Promise<void> {
  try {
    await peer.publish(source, stream);
  } catch (error) {
    if (!retryMedia(peer, error)) {
      throw error;
    }
    await peer.publish(source, stream);
  }
}

async function unpublishSource(peer: RealtimePeer, source: "cam" | "movie"): Promise<void> {
  try {
    await peer.unpublish(source);
  } catch (error) {
    if (!retryMedia(peer, error)) {
      throw error;
    }
    await peer.unpublish(source);
  }
}

async function subscribeSources(peer: RealtimePeer, publications: MediaPublication[]): Promise<void> {
  try {
    await peer.subscribe(publications);
  } catch (error) {
    if (!retryMedia(peer, error)) {
      throw error;
    }
    // A track the host has just published can be refused for a moment.
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    await peer.subscribe(publications);
  }
}

export function RoomView({ code, start = null }: { code: string; start?: RoomStart | null }) {
  const [name, setName] = useState(() => loadName());
  const [nameDraft, setNameDraft] = useState(name);
  const [you, setYou] = useState<PeerInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<WatchMode>("idle");
  const [url, setUrl] = useState("");
  const [playback, setPlayback] = useState<PlaybackPayload | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleState | null>(null);
  const [wsStatus, setWsStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState>("new");
  const [iceState, setIceState] = useState<RTCIceConnectionState>("new");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteCam, setRemoteCam] = useState<MediaStream | null>(null);
  const [remoteMovie, setRemoteMovie] = useState<MediaStream | null>(null);
  // The mic starts muted so it cannot echo or fight the movie soundtrack.
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [peer, setPeer] = useState<RealtimePeer | null>(null);
  const [movieStream, setMovieStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaRecovering, setMediaRecovering] = useState(false);

  const socketRef = useRef<RoomSocket | null>(null);
  const peerRef = useRef<RealtimePeer | null>(null);
  const peerSetupRef = useRef<Promise<RealtimePeer> | null>(null);
  const roleRef = useRef<"host" | "guest">("guest");
  const youIdRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const movieStreamRef = useRef<MediaStream | null>(null);
  const mediaTokenRef = useRef<string | null>(null);
  const remotePublicationsRef = useRef<Map<string, MediaPublication[]>>(new Map());
  const leftRef = useRef(false);
  const recoveryTimerRef = useRef<number | null>(null);
  const isolatedMediaErrorRef = useRef<string | null>(null);
  const recoveryAttemptRef = useRef(0);
  const recoveryRunningRef = useRef(false);
  const scheduleRecoveryRef = useRef<((reason: string, immediate?: boolean, graceMs?: number) => void) | null>(
    null,
  );
  const recoverPeerRef = useRef<((reason: string) => Promise<void>) | null>(null);

  const remotePeer = useMemo(
    () => peers.find((peer) => peer.id !== you?.id) ?? peers[0] ?? null,
    [peers, you],
  );

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(message);
  }, []);

  const teardownPeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    peerSetupRef.current = null;
    setPeer(null);
    setRemoteCam(null);
    setRemoteMovie(null);
    setRtcState("new");
    setIceState("new");
  }, []);

  const ensurePeer = useCallback(async () => {
    if (peerRef.current) {
      return peerRef.current;
    }
    if (peerSetupRef.current) {
      return peerSetupRef.current;
    }
    const mediaToken = mediaTokenRef.current;
    if (!mediaToken) {
      throw new Error("The room has not issued a media seat yet.");
    }
    const setup = (async () => {
      if (peerRef.current) {
        return peerRef.current;
      }
      isolatedMediaErrorRef.current = null;
      let nextPeer: RealtimePeer;
      nextPeer = new RealtimePeer(code, mediaToken, {
        onPublications: (publications) => send({ type: "media", payload: { publications } }),
        onRemoteStream: (kind, stream) => {
          if (peerRef.current !== nextPeer) {
            return;
          }
          if (kind === "movie") {
            setRemoteMovie(stream);
          } else {
            setRemoteCam(stream);
          }
        },
        onConnectionState: (state) => {
          if (peerRef.current !== nextPeer) {
            return;
          }
          setRtcState(state);
          if (state === "connected") {
            if (recoveryTimerRef.current !== null) {
              window.clearTimeout(recoveryTimerRef.current);
              recoveryTimerRef.current = null;
              setMediaError(isolatedMediaErrorRef.current);
            }
            recoveryAttemptRef.current = 0;
            setMediaRecovering(false);
          } else if (state === "failed") {
            scheduleRecoveryRef.current?.("The SFU connection failed.");
          } else if (state === "disconnected") {
            scheduleRecoveryRef.current?.(
              "The SFU connection was interrupted.",
              false,
              DISCONNECT_REBUILD_MS,
            );
          }
        },
        onIceState: (state) => {
          if (peerRef.current !== nextPeer) {
            return;
          }
          setIceState(state);
          if (state === "failed") {
            scheduleRecoveryRef.current?.("The network path to Cloudflare failed.");
          }
        },
      });
      peerRef.current = nextPeer;
      setPeer(nextPeer);
      Object.assign(window, { __watchParty: nextPeer });
      try {
        await nextPeer.start();
      } catch (error) {
        if (peerRef.current === nextPeer) {
          nextPeer.close();
          peerRef.current = null;
          setPeer(null);
        }
        throw error;
      }

      let fatal: unknown = null;
      if (localStreamRef.current) {
        try {
          await publishSource(nextPeer, "cam", localStreamRef.current);
        } catch (error) {
          const message = mediaFailureMessage(error, "Camera could not start.");
          if (connectionIsUp(nextPeer)) {
            isolatedMediaErrorRef.current = message;
            setMediaError(message);
          } else {
            fatal = error;
          }
        }
      }
      if (movieStreamRef.current && roleRef.current === "host") {
        try {
          await publishSource(nextPeer, "movie", movieStreamRef.current);
        } catch (error) {
          const message = mediaFailureMessage(error, "Movie stream could not start.");
          if (connectionIsUp(nextPeer)) {
            isolatedMediaErrorRef.current = message;
            setMediaError(message);
          } else if (!fatal) {
            fatal = error;
          }
        }
      }
      try {
        await subscribeSources(nextPeer, [...remotePublicationsRef.current.values()].flat());
      } catch (error) {
        const message = mediaFailureMessage(error, "Your friend's Cloudflare media could not be attached.");
        if (connectionIsUp(nextPeer)) {
          isolatedMediaErrorRef.current = message;
          setMediaError(message);
        } else if (!fatal) {
          fatal = error;
        }
      }
      if (fatal && peerRef.current === nextPeer) {
        const state = nextPeer.pc.connectionState;
        if (state === "failed" || state === "closed") {
          nextPeer.close();
          peerRef.current = null;
          setPeer(null);
          throw fatal;
        }
        const message = mediaFailureMessage(fatal, "Cloudflare media could not start.");
        isolatedMediaErrorRef.current = message;
        setMediaError(message);
      }
      return nextPeer;
    })();
    peerSetupRef.current = setup;
    try {
      return await setup;
    } finally {
      if (peerSetupRef.current === setup) {
        peerSetupRef.current = null;
      }
    }
  }, [code, send]);

  const schedulePeerRecovery = useCallback((reason: string, immediate = false, graceMs?: number) => {
    if (leftRef.current || document.visibilityState !== "visible" || recoveryRunningRef.current) {
      return;
    }
    if (recoveryTimerRef.current !== null) {
      if (graceMs !== undefined) {
        return;
      }
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    setMediaRecovering(true);
    setMediaError(`${reason} Reconnecting automatically…`);
    const delay = immediate ? 0 : graceMs ?? Math.min(1_000 * 2 ** recoveryAttemptRef.current, 15_000);
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      const state = peerRef.current?.pc.connectionState;
      if (graceMs !== undefined && (state === "connected" || state === "connecting")) {
        if (state === "connected") {
          setMediaRecovering(false);
          setMediaError(isolatedMediaErrorRef.current);
        }
        return;
      }
      void recoverPeerRef.current?.(reason);
    }, delay);
  }, []);

  const recoverPeer = useCallback(
    async (reason: string) => {
      if (leftRef.current || recoveryRunningRef.current) {
        return;
      }
      recoveryRunningRef.current = true;
      const failedPeer = peerRef.current;
      let recovered = false;
      try {
        const mediaToken = mediaTokenRef.current;
        if (!mediaToken) {
          throw new Error("The room has not issued a media seat yet.");
        }
        await resetRealtimeSession(code, mediaToken);
        if (peerRef.current === failedPeer) {
          teardownPeer();
        }
        await ensurePeer();
        recovered = true;
        recoveryAttemptRef.current = 0;
        setMediaError(isolatedMediaErrorRef.current);
        setMediaRecovering(false);
      } catch (mediaFailure: unknown) {
        recoveryAttemptRef.current += 1;
        setMediaError(
          mediaFailure instanceof Error
            ? `${mediaFailure.message} Retrying…`
            : `${reason} Retrying…`,
        );
      } finally {
        recoveryRunningRef.current = false;
      }
      if (!recovered) {
        schedulePeerRecovery(reason);
      }
    },
    [code, ensurePeer, schedulePeerRecovery, teardownPeer],
  );

  scheduleRecoveryRef.current = schedulePeerRecovery;
  recoverPeerRef.current = recoverPeer;

  const connect = useCallback(() => {
    socketRef.current?.close();
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryAttemptRef.current = 0;
    recoveryRunningRef.current = false;
    setMediaRecovering(false);
    teardownPeer();
    mediaTokenRef.current = null;
    remotePublicationsRef.current.clear();
    leftRef.current = false;
    setError(null);
    setMessages([]);
    const socket = openRoomSocket({
      code,
      name: name.trim() || "Friend",
      hostKey: loadHostKey(code),
      clientId: loadClientId(code),
      onStatus: (status) => {
        if (status === "closed" && leftRef.current) {
          return;
        }
        setWsStatus(status);
      },
      onMessage: (message) => {
        switch (message.type) {
          case "joined": {
            const seatChanged =
              mediaTokenRef.current !== null && mediaTokenRef.current !== message.payload.mediaToken;
            if (seatChanged) {
              teardownPeer();
            }
            setYou(message.payload.you);
            setPeers(message.payload.peers);
            youIdRef.current = message.payload.you.id;
            roleRef.current = message.payload.you.role;
            mediaTokenRef.current = message.payload.mediaToken;
            remotePublicationsRef.current = new Map(
              message.payload.media.map((item) => [item.from, item.publications]),
            );
            setMode(message.payload.mode);
            setUrl(message.payload.url ?? "");
            if (message.payload.hostKey) {
              saveHostKey(code, message.payload.hostKey);
            }
            if (message.payload.playback) {
              setPlayback(message.payload.playback);
            }
            setSubtitle(message.payload.subtitle ?? null);
            setMediaError(null);
            void ensurePeer().catch((mediaFailure: unknown) => {
              const message =
                mediaFailure instanceof Error ? mediaFailure.message : "Cloudflare media could not start.";
              setMediaError(message);
              scheduleRecoveryRef.current?.(message);
            });
            return;
          }
          case "roster": {
            setPeers(message.payload.peers);
            return;
          }
          case "peer-joined": {
            setPeers((current) => [...current.filter((peer) => peer.id !== message.payload.id), message.payload]);
            return;
          }
          case "peer-left": {
            setPeers((current) => current.filter((peer) => peer.id !== message.payload.id));
            remotePublicationsRef.current.delete(message.payload.id);
            setRemoteCam(null);
            setRemoteMovie(null);
            return;
          }
          case "role": {
            setYou((current) => (current && current.id === message.payload.id ? message.payload : current));
            setPeers((current) =>
              current.map((peer) => (peer.id === message.payload.id ? message.payload : peer)),
            );
            if (youIdRef.current === message.payload.id) {
              roleRef.current = message.payload.role;
            }
            return;
          }
          case "host-key": {
            saveHostKey(code, message.payload.hostKey);
            return;
          }
          case "chat": {
            setMessages((current) => [...current, message.payload]);
            return;
          }
          case "playback": {
            setPlayback(message.payload);
            return;
          }
          case "subtitle": {
            setSubtitle({
              trackName: message.payload.trackName,
              text: message.payload.text,
              start: message.payload.start,
              end: message.payload.end,
            });
            return;
          }
          case "mode": {
            setMode(message.payload.mode);
            setUrl(message.payload.url ?? "");
            if (message.payload.mode !== "file-stream") {
              setRemoteMovie(null);
            }
            return;
          }
          case "media": {
            remotePublicationsRef.current.set(message.payload.from, message.payload.publications);
            void ensurePeer()
              .then((mediaPeer) => subscribeSources(mediaPeer, message.payload.publications))
              .catch((mediaFailure: unknown) => {
                const message = mediaFailureMessage(
                  mediaFailure,
                  "Your friend's Cloudflare media could not be attached.",
                );
                const state = peerRef.current?.pc.connectionState;
                if (!peerRef.current || state === "failed" || state === "closed") {
                  setMediaError(message);
                  scheduleRecoveryRef.current?.(message);
                  return;
                }
                isolatedMediaErrorRef.current = message;
                setMediaError(message);
              });
            return;
          }
          case "error": {
            setError(message.payload.message);
            if (message.payload.code === "room-full") {
              leftRef.current = true;
              socket.close();
            }
          }
        }
      },
    });
    socketRef.current = socket;
  }, [code, name, ensurePeer, teardownPeer]);

  useEffect(() => {
    if (!name) {
      return;
    }
    connect();
    return () => {
      leftRef.current = true;
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      socketRef.current?.close();
      teardownPeer();
    };
  }, [name, connect, teardownPeer]);

  useEffect(() => {
    let cancelled = false;
    void getCameraStream().then((stream) => {
      if (!stream) {
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      const mediaPeer = peerRef.current;
      if (mediaPeer) {
        void publishSource(mediaPeer, "cam", stream).catch((mediaFailure: unknown) => {
          const message = mediaFailureMessage(mediaFailure, "Camera could not start.");
          const state = peerRef.current?.pc.connectionState;
          if (!peerRef.current || state === "failed" || state === "closed") {
            setMediaError(message);
            scheduleRecoveryRef.current?.(message);
            return;
          }
          isolatedMediaErrorRef.current = message;
          setMediaError(message);
        });
      }
    });
    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [ensurePeer]);

  useEffect(() => {
    if (wsStatus !== "open") {
      return;
    }
    send({ type: "hello" });
  }, [wsStatus, send]);

  useEffect(() => {
    const recoverAfterNetworkChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (rtcState === "failed" || iceState === "failed") {
        schedulePeerRecovery("The browser or network connection changed.", true);
      } else if (rtcState === "disconnected") {
        schedulePeerRecovery("The SFU connection was interrupted.", false, DISCONNECT_REBUILD_MS);
      }
    };
    window.addEventListener("online", recoverAfterNetworkChange);
    document.addEventListener("visibilitychange", recoverAfterNetworkChange);
    return () => {
      window.removeEventListener("online", recoverAfterNetworkChange);
      document.removeEventListener("visibilitychange", recoverAfterNetworkChange);
    };
  }, [iceState, rtcState, schedulePeerRecovery]);

  const toggleMic = useCallback(() => {
    setMicOn((current) => {
      const next = !current;
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  const toggleCam = useCallback(() => {
    setCamOn((current) => {
      const next = !current;
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  const handlePlayback = useCallback(
    (payload: PlaybackPayload) => {
      send({ type: "playback", payload });
    },
    [send],
  );

  const handleMode = useCallback(
    (nextMode: WatchMode, nextUrl?: string) => {
      setMode(nextMode);
      setUrl(nextUrl ?? "");
      send({ type: "mode", payload: { mode: nextMode, url: nextUrl } });
    },
    [send],
  );

  const handleSubtitle = useCallback(
    (nextSubtitle: SubtitleState) => {
      setSubtitle(nextSubtitle);
      send({ type: "subtitle", payload: nextSubtitle });
    },
    [send],
  );

  const handleMovieStream = useCallback(
    (stream: MediaStream | null) => {
      const peerAlreadyUp = peerRef.current !== null || peerSetupRef.current !== null;
      movieStreamRef.current = stream;
      setMovieStream(stream);
      if (!stream) {
        const mediaPeer = peerRef.current;
        if (!mediaPeer) {
          return;
        }
        void unpublishSource(mediaPeer, "movie").catch((mediaFailure: unknown) => {
          const message = mediaFailureMessage(mediaFailure, "Movie stream could not stop.");
          const state = peerRef.current?.pc.connectionState;
          if (!peerRef.current || state === "failed" || state === "closed") {
            setMediaError(message);
            scheduleRecoveryRef.current?.(message);
            return;
          }
          isolatedMediaErrorRef.current = message;
          setMediaError(message);
        });
        return;
      }
      void ensurePeer()
        .then((mediaPeer) => {
          if (peerAlreadyUp && movieStreamRef.current === stream) {
            return publishSource(mediaPeer, "movie", stream);
          }
        })
        .catch((mediaFailure: unknown) => {
          const message = mediaFailureMessage(mediaFailure, "Movie stream could not start.");
          const state = peerRef.current?.pc.connectionState;
          if (!peerRef.current || state === "failed" || state === "closed") {
            setMediaError(message);
            scheduleRecoveryRef.current?.(message);
            return;
          }
          isolatedMediaErrorRef.current = message;
          setMediaError(message);
        });
    },
    [ensurePeer],
  );

  if (!name) {
    return (
      <main className="lobby">
        <div className="lobby-card">
          <h1>Name for this room</h1>
          <p className="lede">
            Room <strong>{code}</strong> is ready. Add a display name, then jump in.
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const next = nameDraft.trim();
              if (!next) {
                return;
              }
              saveName(next);
              setName(next);
            }}
          >
            <label className="field">
              <span>Your name</span>
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={32} />
            </label>
            <button className="primary" type="submit">
              Enter room
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="lobby">
        <div className="lobby-card">
          <h1>Could not join</h1>
          <p className="lede">{error}</p>
          <a className="primary" href="/">
            Back to lobby
          </a>
        </div>
      </main>
    );
  }

  async function copyLink() {
    const invite = `${window.location.origin}/r/${code}`;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt("Copy this invite link", invite);
    }
  }

  return (
    <div className="room">
      <header className="room-bar">
        <h1>{code}</h1>
        <div className="status-pills">
          <span className={`pill ${wsStatus === "open" ? "ok" : ""}`}>
            {wsStatus === "open" ? "Live" : wsStatus === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
          <span className={`pill ${rtcState === "connected" ? "ok" : rtcState === "failed" ? "bad" : ""}`}>
            SFU {mediaRecovering ? "recovering" : rtcState === "new" ? "starting" : rtcState}
          </span>
          {rtcState !== "connected" && rtcState !== "new" ? (
            <span className="pill">ICE {iceState}</span>
          ) : null}
          <span className="pill">
            {1 + peers.length}/2
          </span>
        </div>
        <div className="bar-actions">
          <button type="button" className={micOn ? "chip on" : "chip"} onClick={toggleMic}>
            {micOn ? "Mic on" : "Mic off"}
          </button>
          <button type="button" className={camOn ? "chip on" : "chip"} onClick={toggleCam}>
            {camOn ? "Cam on" : "Cam off"}
          </button>
          <button
            type="button"
            className={showStats ? "chip on" : "chip"}
            onClick={() => setShowStats((current) => !current)}
          >
            Stats
          </button>
          {mediaRecovering || rtcState === "failed" || iceState === "failed" || mediaError ? (
            <button
              type="button"
              className="chip"
              disabled={mediaRecovering}
              onClick={() => schedulePeerRecovery("Manual media reconnect requested.", true)}
            >
              {mediaRecovering ? "Recovering…" : "Reconnect media"}
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={() => void copyLink()}>
            {copied ? "Copied" : "Invite"}
          </button>
          <a
            className="ghost"
            href="/"
            onClick={() => {
              leftRef.current = true;
              socketRef.current?.close();
            }}
          >
            Leave
          </a>
        </div>
      </header>

      {mediaError ? (
        <p className="banner warn strip">
          Cloudflare media: {mediaError}
        </p>
      ) : null}

      <main className="stage-area">
        <MovieStage
          role={you?.role ?? "guest"}
          mode={mode}
          url={url}
          remoteMovie={remoteMovie}
          incomingPlayback={playback}
          incomingSubtitle={subtitle}
          onMode={handleMode}
          onPlayback={handlePlayback}
          onSubtitle={handleSubtitle}
          onMovieStream={handleMovieStream}
          initialStart={start}
        />
        <Cameras
          you={you}
          localStream={localStream}
          remoteStream={remoteCam}
          remotePeer={remotePeer}
          camOn={camOn}
        />
        {showStats && !peer ? (
          <div className="diagnostics">
            <header>
              <strong>Diagnostics</strong>
              <div className="diag-actions">
                <button type="button" className="chip" onClick={() => setShowStats(false)}>
                  Close
                </button>
              </div>
            </header>
            <pre>Waiting for your friend to join. Stats appear once the video link is up.</pre>
          </div>
        ) : null}
        {showStats && peer ? (
          <Diagnostics
            pc={peer.pc}
            probeStream={you?.role === "host" ? movieStream : remoteMovie}
            header={{
              seat: you?.role ?? "guest",
              mode,
              webrtc: rtcState,
              ice: iceState,
              route: "Cloudflare Realtime SFU",
              browser: navigator.userAgent.slice(0, 80),
            }}
            onClose={() => setShowStats(false)}
          />
        ) : null}
      </main>

      <aside className="rail">
        <Chat
          messages={messages}
          disabled={wsStatus !== "open"}
          onSend={(text) => send({ type: "chat", payload: { text } })}
        />
      </aside>
    </div>
  );
}
