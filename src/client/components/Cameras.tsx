import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PeerInfo } from "../../shared/protocol";

type Corner = { x: number; y: number };

export function Cameras({
  you,
  localStream,
  remoteStream,
  remotePeer,
  camOn,
}: {
  you: PeerInfo | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remotePeer: PeerInfo | null;
  camOn: boolean;
}) {
  return (
    <>
      {/* A huge x parks both bubbles against the right edge once clamped to the stage. */}
      <CamBubble
        stream={remoteStream}
        label={remotePeer ? remotePeer.name : "Waiting"}
        muted={false}
        mirrored={false}
        start={{ x: 9999, y: 16 }}
      />
      <CamBubble
        stream={camOn ? localStream : null}
        label={you ? you.name : "You"}
        muted
        mirrored
        start={{ x: 9999, y: 222 }}
      />
    </>
  );
}

function CamBubble({
  stream,
  label,
  muted,
  mirrored,
  start,
}: {
  stream: MediaStream | null;
  label: string;
  muted: boolean;
  mirrored: boolean;
  start: Corner;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<Corner | null>(null);
  const [pos, setPos] = useState(start);
  const [big, setBig] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      void video.play().catch(() => undefined);
    }
  }, [stream]);

  // Keep the bubble inside the stage when the window or its size changes.
  useEffect(() => {
    const clampToStage = () => {
      const bubble = bubbleRef.current;
      const stage = bubble?.offsetParent as HTMLElement | null;
      if (!bubble || !stage) {
        return;
      }
      setPos((current) => ({
        x: clamp(current.x, 0, stage.clientWidth - bubble.offsetWidth),
        y: clamp(current.y, 0, stage.clientHeight - bubble.offsetHeight),
      }));
    };
    clampToStage();
    window.addEventListener("resize", clampToStage);
    return () => window.removeEventListener("resize", clampToStage);
  }, [big]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const bubble = bubbleRef.current;
    if (!bubble) {
      return;
    }
    const rect = bubble.getBoundingClientRect();
    grabRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    try {
      bubble.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; dragging still tracks over the bubble.
    }
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const grab = grabRef.current;
    const bubble = bubbleRef.current;
    const stage = bubble?.offsetParent as HTMLElement | null;
    if (!grab || !bubble || !stage) {
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    setPos({
      x: clamp(event.clientX - stageRect.left - grab.x, 0, stage.clientWidth - bubble.offsetWidth),
      y: clamp(event.clientY - stageRect.top - grab.y, 0, stage.clientHeight - bubble.offsetHeight),
    });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    grabRef.current = null;
    try {
      bubbleRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may never have been granted.
    }
    setDragging(false);
  }

  return (
    <div
      ref={bubbleRef}
      className={`bubble ${big ? "big" : ""} ${dragging ? "dragging" : ""} ${stream ? "live" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setBig((current) => !current)}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        style={mirrored ? { transform: "scaleX(-1)" } : undefined}
      />
      {stream ? null : <span className="bubble-empty">{label.slice(0, 1).toUpperCase()}</span>}
      <span className="bubble-name">{label}</span>
      <button
        type="button"
        className="bubble-size"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setBig((current) => !current)}
        aria-label={big ? "Shrink camera" : "Enlarge camera"}
      >
        {big ? "–" : "+"}
      </button>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
