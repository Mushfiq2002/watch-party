import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  HEARTBEAT_MS,
  PLAYBACK_DRIFT_S,
  PLAYBACK_IGNORE_MS,
  type PlaybackPayload,
  type PeerRole,
  type SubtitleState,
  type WatchMode,
} from "../../shared/protocol";
import {
  captureVideoStream,
  httpMixedContentWarning,
  resumeMovieAudio,
  setMovieVolume,
  warnForFile,
} from "../lib/codecs";
import { inspectVideoFile, type MediaReport } from "../lib/inspect";
import type { RoomStart } from "../lib/start";
import { parseSubtitleFile, subtitleCueAt, type SubtitleCue } from "../lib/subtitles";

const SKIP_SECONDS = 10;

type MovieStageProps = {
  role: PeerRole;
  mode: WatchMode;
  url: string;
  remoteMovie: MediaStream | null;
  incomingPlayback: PlaybackPayload | null;
  incomingSubtitle: SubtitleState | null;
  onMode: (mode: WatchMode, url?: string) => void;
  onPlayback: (payload: PlaybackPayload) => void;
  onSubtitle: (subtitle: SubtitleState) => void;
  onMovieStream: (stream: MediaStream | null) => void;
  initialStart?: RoomStart | null;
};

export function MovieStage({
  role,
  mode,
  url,
  remoteMovie,
  incomingPlayback,
  incomingSubtitle,
  onMode,
  onPlayback,
  onSubtitle,
  onMovieStream,
  initialStart = null,
}: MovieStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const fileUrlRef = useRef<string | null>(null);
  const ignoreUntilRef = useRef(0);
  const lastSubtitleRef = useRef("");
  const [warning, setWarning] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hostTime, setHostTime] = useState(0);
  const [hostDuration, setHostDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleFileName, setSubtitleFileName] = useState<string | null>(null);
  const [subtitlesVisible, setSubtitlesVisible] = useState(true);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [draftReport, setDraftReport] = useState<MediaReport | null>(null);
  const [draftSubtitle, setDraftSubtitle] = useState<File | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const inspectIdRef = useRef(0);
  const pendingStartRef = useRef(initialStart);
  const [awaitingStart, setAwaitingStart] = useState(Boolean(initialStart));
  const isHost = role === "host";
  const guestFileViewer = mode === "file-stream" && !isHost;
  const shownTime = guestFileViewer ? hostTime : currentTime;
  const shownDuration = guestFileViewer ? hostDuration : duration;
  const sourceOpen = isHost && (mode === "idle" || showSource);
  const hasSubtitleTrack = Boolean(isHost ? subtitleFileName : incomingSubtitle?.trackName);
  const subtitleText = subtitlesVisible ? incomingSubtitle?.text ?? "" : "";

  useEffect(() => {
    const video = videoRef.current;
    video?.setAttribute("playsinline", "true");
    video?.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => {
    if (!isHost || !pendingStartRef.current) {
      return;
    }
    const start = pendingStartRef.current;
    pendingStartRef.current = null;
    setAwaitingStart(false);
    if (start.kind === "url") {
      clearSubtitleTrack();
      onMovieStream(null);
      setFileName(null);
      setShowSource(false);
      setWarning(httpMixedContentWarning(start.url));
      onMode("url", start.url);
      return;
    }
    attachHostFile(start.file);
    if (start.subtitle) {
      void attachSubtitleFile(start.subtitle);
    }
    // The chosen file is applied once, when this browser becomes the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setMovieVolume(video, volume, muted);
  }, [volume, muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (mode === "file-stream" && !isHost && remoteMovie) {
      video.srcObject = remoteMovie;
      void video.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
      return;
    }
    setNeedsTap(false);
    if (mode === "url" && url) {
      video.srcObject = null;
      video.src = url;
      return;
    }
  }, [mode, url, remoteMovie, isHost]);

  useEffect(() => {
    const video = videoRef.current;
    if (!incomingPlayback) {
      return;
    }
    if (guestFileViewer) {
      // A live stream never reports paused, so the host's messages are the only truth.
      setHostTime(incomingPlayback.t);
      if (typeof incomingPlayback.d === "number" && Number.isFinite(incomingPlayback.d)) {
        setHostDuration(incomingPlayback.d);
      }
      setPlaying(incomingPlayback.action !== "pause");
      return;
    }
    if (!video) {
      return;
    }
    ignoreUntilRef.current = Date.now() + PLAYBACK_IGNORE_MS;
    if (mode === "file-stream" && incomingPlayback.action !== "seek") {
      if (incomingPlayback.action === "pause") {
        video.pause();
      } else if (incomingPlayback.action === "play") {
        void video.play().catch(() => undefined);
      }
      return;
    }
    const elapsed =
      incomingPlayback.action === "play" || incomingPlayback.action === "heartbeat"
        ? (Date.now() - incomingPlayback.at) / 1000
        : 0;
    const target = incomingPlayback.t + elapsed;
    if (
      incomingPlayback.action === "seek" ||
      Math.abs(video.currentTime - target) > PLAYBACK_DRIFT_S
    ) {
      video.currentTime = target;
    }
    if (incomingPlayback.action === "pause") {
      video.pause();
    } else {
      void video.play().catch(() => undefined);
    }
  }, [incomingPlayback, guestFileViewer, mode]);

  // Runs while paused too, so a guest who joins late lands on the right frame.
  useEffect(() => {
    if (!isHost || mode === "idle") {
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      onPlayback({
        action: video.paused ? "pause" : "heartbeat",
        t: video.currentTime,
        at: Date.now(),
        d: video.duration,
      });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [isHost, mode, onPlayback]);

  useEffect(() => {
    if (!guestFileViewer || !playing) {
      return;
    }
    const timer = window.setInterval(() => {
      setHostTime((current) => current + 0.5);
    }, 500);
    return () => window.clearInterval(timer);
  }, [guestFileViewer, playing]);

  useEffect(() => {
    if (!isHost || !subtitleFileName) {
      return;
    }
    const cue = subtitleCueAt(subtitleCues, currentTime);
    const next: SubtitleState = {
      trackName: subtitleFileName,
      text: cue?.text ?? "",
      start: cue?.start ?? 0,
      end: cue?.end ?? 0,
    };
    const key = `${next.trackName}\u0000${next.start}\u0000${next.end}\u0000${next.text}`;
    if (key === lastSubtitleRef.current) {
      return;
    }
    lastSubtitleRef.current = key;
    onSubtitle(next);
  }, [currentTime, isHost, onSubtitle, subtitleCues, subtitleFileName]);

  useEffect(() => {
    return () => {
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
      }
    };
  }, []);

  function emit(action: PlaybackPayload["action"]) {
    const video = videoRef.current;
    if (!video || Date.now() < ignoreUntilRef.current) {
      return;
    }
    onPlayback({ action, t: video.currentTime, at: Date.now(), d: video.duration });
  }

  function attachHostFile(file: File) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const codecWarning = warnForFile(file);
    clearSubtitleTrack();
    setWarning(codecWarning);
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
    }
    const blobUrl = URL.createObjectURL(file);
    fileUrlRef.current = blobUrl;
    setFileName(file.name);
    setShowSource(false);
    video.srcObject = null;
    video.src = blobUrl;
    onMode("file-stream");
    const startCapture = () => {
      void video
        .play()
        .catch(() => undefined)
        .finally(() => {
          try {
            const stream = captureVideoStream(video);
            setMovieVolume(video, volume, muted);
            if (stream.getAudioTracks().length === 0) {
              setWarning(
                `${file.name} gave picture but no sound to stream. Its audio track is probably not one the browser can decode (AC3, EAC3, DTS). Remux to MP4 with AAC audio.`,
              );
            }
            onMovieStream(stream);
          } catch (error) {
            setWarning(error instanceof Error ? error.message : "Could not capture this video.");
            onMovieStream(null);
          }
        });
    };
    video.addEventListener("loadedmetadata", startCapture, { once: true });
  }

  function queueVideo(file: File) {
    const id = inspectIdRef.current + 1;
    inspectIdRef.current = id;
    setDraftFile(file);
    setDraftReport(null);
    setInspecting(true);
    setShowSource(false);
    void inspectVideoFile(file).then((report) => {
      if (inspectIdRef.current !== id) {
        return;
      }
      setDraftReport(report);
      setInspecting(false);
    });
  }

  function queueSubtitle(file: File) {
    if (!/\.(srt|vtt)$/i.test(file.name)) {
      setWarning("Choose an .srt or .vtt subtitle file.");
      return;
    }
    setDraftSubtitle(file);
    setWarning(null);
  }

  async function startDraft() {
    if (!draftFile || !draftReport?.ready) {
      return;
    }
    if (draftSubtitle) {
      try {
        await parseSubtitleFile(draftSubtitle);
      } catch (error) {
        setWarning(error instanceof Error ? error.message : "Could not read this subtitle file.");
        return;
      }
    }
    const file = draftFile;
    const subtitle = draftSubtitle;
    inspectIdRef.current += 1;
    setDraftFile(null);
    setDraftReport(null);
    setDraftSubtitle(null);
    setInspecting(false);
    attachHostFile(file);
    if (subtitle) {
      await attachSubtitleFile(subtitle);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!isHost) {
      return;
    }
    const files = [...event.dataTransfer.files];
    const subtitle = files.find((file) => /\.(srt|vtt)$/i.test(file.name));
    const video = files.find((file) => file !== subtitle);
    if (subtitle && (video || draftFile || mode === "idle")) {
      queueSubtitle(subtitle);
    } else if (subtitle) {
      void attachSubtitleFile(subtitle);
    }
    if (video) {
      queueVideo(video);
    }
  }

  async function attachSubtitleFile(file: File) {
    if (!isHost) {
      return;
    }
    try {
      const cues = await parseSubtitleFile(file);
      setSubtitleCues(cues);
      setSubtitleFileName(file.name);
      setSubtitlesVisible(true);
      lastSubtitleRef.current = "";
      const cue = subtitleCueAt(cues, videoRef.current?.currentTime ?? 0);
      onSubtitle({
        trackName: file.name,
        text: cue?.text ?? "",
        start: cue?.start ?? 0,
        end: cue?.end ?? 0,
      });
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "Could not read this subtitle file.");
    }
  }

  function clearSubtitleTrack() {
    if (!subtitleFileName && subtitleCues.length === 0) {
      return;
    }
    setSubtitleCues([]);
    setSubtitleFileName(null);
    lastSubtitleRef.current = "";
    onSubtitle({ trackName: "", text: "", start: 0, end: 0 });
  }

  function togglePlay() {
    const video = videoRef.current;
    if (guestFileViewer) {
      const next = playing ? "pause" : "play";
      setPlaying(!playing);
      onPlayback({ action: next, t: hostTime, at: Date.now(), d: hostDuration });
      return;
    }
    if (!video) {
      return;
    }
    resumeMovieAudio(video);
    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  function seek(next: number) {
    const target = Math.max(0, shownDuration > 0 ? Math.min(next, shownDuration) : next);
    const video = videoRef.current;
    if (guestFileViewer) {
      setHostTime(target);
      onPlayback({ action: "seek", t: target, at: Date.now(), d: hostDuration });
      return;
    }
    if (!video) {
      return;
    }
    video.currentTime = target;
    emit("seek");
  }

  function toggleFullscreen() {
    const screen = screenRef.current;
    if (!screen) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void screen.requestFullscreen?.().catch(() => undefined);
  }

  return (
    <section className="stage">
      <div
        ref={screenRef}
        className={`screen ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          if (!isHost) {
            return;
          }
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <video
          ref={videoRef}
          playsInline
          autoPlay={guestFileViewer}
          onClick={togglePlay}
          onPlay={() => {
            if (guestFileViewer) {
              return;
            }
            setPlaying(true);
            emit("play");
          }}
          onPause={() => {
            if (guestFileViewer) {
              return;
            }
            setPlaying(false);
            emit("pause");
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onError={() => {
            if (mode === "url") {
              const mixed = url ? httpMixedContentWarning(url) : null;
              setWarning(
                mixed ??
                  "This URL could not be played here. Direct MP4/WebM links work best. If it is an ISP HTTP link, download it and stream the local file.",
              );
            }
          }}
        />

        {subtitleText ? (
          <div className="subtitle-overlay" role="status" aria-live="polite">
            <span>{subtitleText}</span>
          </div>
        ) : null}

        {mode !== "idle" && !needsTap ? (
          <div className="controls">
            <div className="scrub">
              <input
                type="range"
                min={0}
                max={Number.isFinite(shownDuration) && shownDuration > 0 ? shownDuration : 0}
                step={0.1}
                value={shownTime}
                onChange={(event) => seek(Number(event.target.value))}
                aria-label="Seek"
              />
            </div>
            <div className="buttons">
              <button type="button" className="ctrl" onClick={() => seek(shownTime - SKIP_SECONDS)} aria-label="Back 10 seconds">
                ⟲ 10
              </button>
              <button type="button" className="ctrl play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button type="button" className="ctrl" onClick={() => seek(shownTime + SKIP_SECONDS)} aria-label="Forward 10 seconds">
                10 ⟳
              </button>
              <span className="time">
                {formatTime(shownTime)} / {formatTime(shownDuration)}
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="ctrl"
                onClick={() => setMuted((current) => !current)}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted || volume === 0 ? "🔇" : "🔊"}
              </button>
              <input
                className="volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
                aria-label="Volume"
              />
              {isHost ? (
                <button type="button" className="ctrl" onClick={() => setShowSource((current) => !current)}>
                  Source
                </button>
              ) : null}
              {hasSubtitleTrack ? (
                <button
                  type="button"
                  className={subtitlesVisible ? "ctrl cc-on" : "ctrl"}
                  onClick={() => setSubtitlesVisible((current) => !current)}
                  aria-label={subtitlesVisible ? "Hide subtitles" : "Show subtitles"}
                  title={incomingSubtitle?.trackName || subtitleFileName || "Subtitles"}
                >
                  CC
                </button>
              ) : null}
              <button type="button" className="ctrl" onClick={toggleFullscreen} aria-label="Fullscreen">
                ⤢
              </button>
            </div>
          </div>
        ) : null}

        {needsTap ? (
          <div className="poster">
            <p>Tap to start the picture and sound. Phones often block autoplay.</p>
            <button
              type="button"
              className="file-button"
              onClick={() => {
                const video = videoRef.current;
                if (!video) {
                  return;
                }
                void video.play().then(() => setNeedsTap(false)).catch(() => undefined);
              }}
            >
              Tap to watch
            </button>
          </div>
        ) : null}

        {awaitingStart ? (
          <div className="poster">
            <p>Starting the movie…</p>
          </div>
        ) : isHost && (mode === "idle" || draftFile) ? (
          <div className="prepare">
            <p className="eyebrow">Before you start</p>
            <h2>{draftFile ? draftFile.name : "Choose a video"}</h2>
            {!draftFile ? (
              <p className="lede">
                Drop an MP4 here. This page reads the file and names anything that has to be changed on your computer
                before it will play for both of you.
              </p>
            ) : null}
            <label className="file-button">
              {draftFile ? "Choose a different video" : "Choose a video"}
              <input
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.m4v,.mov"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    queueVideo(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {inspecting ? <p className="lede">Reading the file…</p> : null}
            {draftReport ? (
              <ul className="prepare-notes">
                {draftReport.notes.map((note) => (
                  <li key={note.text} className={note.tone}>
                    {note.text}
                  </li>
                ))}
              </ul>
            ) : null}
            {draftReport && !draftReport.notes.some((note) => note.text.includes("subtitle")) ? (
              <p className="lede">
                Subtitles inside the video will not appear. Add a separate .srt or .vtt if you want captions.
              </p>
            ) : null}
            <label className="file-button ghost">
              {draftSubtitle ? draftSubtitle.name : "Add subtitles"}
              <input
                type="file"
                accept=".srt,.vtt,text/vtt,application/x-subrip"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    queueSubtitle(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {draftSubtitle ? (
              <button type="button" className="chip" onClick={() => setDraftSubtitle(null)}>
                Remove subtitle
              </button>
            ) : null}
            {draftFile ? (
              <button type="button" className="primary" disabled={!draftReport?.ready || inspecting} onClick={() => void startDraft()}>
                Start watching
              </button>
            ) : null}
            {draftFile && mode !== "idle" ? (
              <button
                type="button"
                className="chip"
                onClick={() => {
                  inspectIdRef.current += 1;
                  setDraftFile(null);
                  setDraftReport(null);
                  setDraftSubtitle(null);
                  setInspecting(false);
                }}
              >
                Keep the current movie
              </button>
            ) : null}
          </div>
        ) : mode === "idle" ? (
          <div className="poster">
            <p>Waiting for the host to start a movie.</p>
          </div>
        ) : null}
      </div>

      {sourceOpen && mode !== "idle" && !draftFile ? (
        <div className="host-tools">
          <label className="file-button" title={fileName ?? "Play a file from this device"}>
            <span>{fileName ?? "Play file now"}</span>
            <input
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.m4v,.mov"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  queueVideo(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label
            className="file-button ghost"
            title={subtitleFileName ? `CC ${subtitleFileName}` : "SRT or WebVTT; synchronized to your friend"}
          >
            <span>{subtitleFileName ? `CC ${subtitleFileName}` : "Add subtitles"}</span>
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void attachSubtitleFile(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          {subtitleFileName ? (
            <button type="button" className="chip" onClick={clearSubtitleTrack}>
              Remove CC
            </button>
          ) : null}
        </div>
      ) : null}

      {warning ? <p className="banner warn">{warning}</p> : null}
    </section>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const whole = Math.floor(seconds);
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
