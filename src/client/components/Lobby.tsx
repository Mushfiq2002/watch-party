import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { ROOM_CODE_PATTERN } from "../../shared/protocol";
import { inspectVideoFile, type MediaReport } from "../lib/inspect";
import type { RoomStart } from "../lib/start";
import { parseSubtitleFile } from "../lib/subtitles";
import { newHostKey, saveHostKey, saveName } from "../lib/storage";

type LobbyProps = {
  initialName: string;
  onEnter: (code: string, start: RoomStart | null) => void;
};

export function Lobby({ initialName, onEnter }: LobbyProps) {
  const [hostName, setHostName] = useState(initialName);
  const [guestName, setGuestName] = useState(initialName);
  const [guestCode, setGuestCode] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<MediaReport | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [subtitle, setSubtitle] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inspectIdRef = useRef(0);

  const link = urlDraft.trim();
  const fileReady = Boolean(report?.ready);
  const askName = fileReady || link.length > 0;

  function queueVideo(next: File) {
    const id = inspectIdRef.current + 1;
    inspectIdRef.current = id;
    setFile(next);
    setReport(null);
    setInspecting(true);
    setError(null);
    void inspectVideoFile(next).then((nextReport) => {
      if (inspectIdRef.current !== id) {
        return;
      }
      setReport(nextReport);
      setInspecting(false);
    });
  }

  function queueSubtitle(next: File) {
    if (!/\.(srt|vtt)$/i.test(next.name)) {
      setError("Choose an .srt or .vtt subtitle file.");
      return;
    }
    setSubtitle(next);
    setError(null);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    const nextSubtitle = files.find((item) => /\.(srt|vtt)$/i.test(item.name));
    const nextVideo = files.find((item) => item !== nextSubtitle);
    if (nextSubtitle) {
      queueSubtitle(nextSubtitle);
    }
    if (nextVideo) {
      queueVideo(nextVideo);
    }
  }

  async function createRoom(start: RoomStart) {
    const trimmed = hostName.trim();
    if (!trimmed) {
      setError("Add a display name so your friend knows who you are.");
      return;
    }
    if (start.kind === "file" && start.subtitle) {
      try {
        await parseSubtitleFile(start.subtitle);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read this subtitle file.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) {
        throw new Error("Could not create a room.");
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || typeof (data as { code?: unknown }).code !== "string") {
        throw new Error("Could not create a room.");
      }
      const roomCode = (data as { code: string }).code;
      saveName(trimmed);
      saveHostKey(roomCode, newHostKey());
      onEnter(roomCode, start);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a room.");
      setBusy(false);
    }
  }

  function startFile(event: FormEvent) {
    event.preventDefault();
    if (!file || !report?.ready) {
      return;
    }
    void createRoom({ kind: "file", file, subtitle });
  }

  function startUrl(event: FormEvent) {
    event.preventDefault();
    if (!link) {
      return;
    }
    void createRoom({ kind: "url", url: link });
  }

  function joinRoom(event: FormEvent) {
    event.preventDefault();
    const trimmedName = guestName.trim();
    const trimmedCode = guestCode.trim().toUpperCase();
    if (!trimmedName) {
      setError("Add a display name so your friend knows who you are.");
      return;
    }
    if (!ROOM_CODE_PATTERN.test(trimmedCode)) {
      setError("Room codes are five characters, like AB3K9.");
      return;
    }
    saveName(trimmedName);
    onEnter(trimmedCode, null);
  }

  return (
    <main className="setup">
      <section
        className={`setup-main ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="eyebrow">Before the room</p>
        <h1>{file ? file.name : "Choose a video"}</h1>
        {!file ? (
          <p className="lede">
            Drop an MP4 here. This page reads the file and names anything that has to be changed on your computer
            before both of you can watch.
          </p>
        ) : null}
        <label className="file-button">
          {file ? "Choose a different video" : "Choose a video"}
          <input
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.m4v,.mov"
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (next) {
                queueVideo(next);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
        {inspecting ? <p className="lede">Reading the file…</p> : null}
        {report ? (
          <ul className="prepare-notes">
            {report.notes.map((note) => (
              <li key={note.text} className={note.tone}>
                {note.text}
              </li>
            ))}
          </ul>
        ) : null}
        {report && !report.notes.some((note) => note.text.includes("subtitle")) ? (
          <p className="lede">Subtitles inside the video will not appear. Add a separate .srt or .vtt if you want captions.</p>
        ) : null}
        <label className="file-button ghost">
          {subtitle ? subtitle.name : "Add subtitles"}
          <input
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (next) {
                queueSubtitle(next);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
        {subtitle ? (
          <button type="button" className="chip" onClick={() => setSubtitle(null)}>
            Remove subtitle
          </button>
        ) : null}

        {askName ? (
          <form className="stack" onSubmit={fileReady ? startFile : startUrl}>
            <label className="field">
              <span>Your name</span>
              <input
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
                maxLength={32}
                placeholder="Alex"
                autoComplete="nickname"
              />
            </label>
            {fileReady ? (
              <button className="primary" type="submit" disabled={busy || !hostName.trim()}>
                {busy ? "Opening room…" : "Start watching"}
              </button>
            ) : null}
          </form>
        ) : null}

        <form className="url-form" onSubmit={startUrl}>
          <input
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="Or paste a direct https://…/movie.mp4 URL"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !link || !hostName.trim()}>
            Load
          </button>
        </form>
        <p className="hint">A direct video link skips the file check. Add your name above, then load it.</p>
        {error ? <p className="banner warn">{error}</p> : null}
      </section>

      <aside className="setup-guest">
        <p className="eyebrow">Already invited</p>
        <h2>Watch as a guest</h2>
        <p className="lede">Put your name and the room code. You do not need the video file.</p>
        <form className="stack" onSubmit={joinRoom}>
          <label className="field">
            <span>Your name</span>
            <input
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
              maxLength={32}
              placeholder="Alex"
              autoComplete="nickname"
            />
          </label>
          <label className="field">
            <span>Room code</span>
            <input
              value={guestCode}
              onChange={(event) => setGuestCode(event.target.value.toUpperCase())}
              maxLength={5}
              placeholder="AB3K9"
              spellCheck={false}
              autoCapitalize="characters"
            />
          </label>
          <button className="secondary" type="submit">
            Join
          </button>
        </form>
      </aside>
    </main>
  );
}
