import { useEffect, useRef, useState } from "react";
import { buildReport, createAudioProbe, type AudioProbe } from "../lib/stats";

type AnyStat = Record<string, unknown> & { id: string; type: string; timestamp: number };

export function Diagnostics({
  pc,
  probeStream,
  header,
  onClose,
}: {
  pc: RTCPeerConnection;
  probeStream: MediaStream | null;
  header: Record<string, string>;
  onClose: () => void;
}) {
  const [text, setText] = useState("collecting…");
  const [copied, setCopied] = useState(false);
  const previousRef = useRef<Map<string, AnyStat>>(new Map());
  const probeRef = useRef<AudioProbe | null>(null);

  useEffect(() => {
    probeRef.current?.close();
    probeRef.current = probeStream ? createAudioProbe(probeStream) : null;
    return () => {
      probeRef.current?.close();
      probeRef.current = null;
    };
  }, [probeStream]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const reading = probeRef.current?.read() ?? null;
      const { text: next, snapshot } = await buildReport(pc, previousRef.current, header, reading);
      if (cancelled) {
        return;
      }
      previousRef.current = snapshot;
      setText(next);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pc, header]);

  return (
    <div className="diagnostics">
      <header>
        <strong>Diagnostics</strong>
        <div className="diag-actions">
          <button
            type="button"
            className="chip"
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => undefined);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="chip" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <pre>{text}</pre>
    </div>
  );
}
