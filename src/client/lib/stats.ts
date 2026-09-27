type AnyStat = Record<string, unknown> & { id: string; type: string; timestamp: number };

export type AudioProbe = {
  read: () => AudioProbeReading | null;
  close: () => void;
};

export type AudioProbeReading = {
  channels: number;
  rmsL: number;
  rmsR: number;
  rmsDiff: number;
  rmsSum: number;
  verdict: string;
};

/**
 * Compares the left and right channels of a stream.
 * Identical channels mean something downmixed to mono; opposite channels cancel
 * centre-panned dialogue, which is what makes vocals disappear.
 */
export function createAudioProbe(stream: MediaStream): AudioProbe | null {
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor || stream.getAudioTracks().length === 0) {
    return null;
  }
  const ctx = new AudioCtor();
  void ctx.resume().catch(() => undefined);
  const source = ctx.createMediaStreamSource(stream);
  const splitter = ctx.createChannelSplitter(2);
  source.connect(splitter);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = 2048;
  right.fftSize = 2048;
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  const bufL = new Float32Array(left.fftSize);
  const bufR = new Float32Array(right.fftSize);

  return {
    read() {
      left.getFloatTimeDomainData(bufL);
      right.getFloatTimeDomainData(bufR);
      let sl = 0;
      let sr = 0;
      let sd = 0;
      let ss = 0;
      for (let i = 0; i < bufL.length; i += 1) {
        const l = bufL[i];
        const r = bufR[i];
        sl += l * l;
        sr += r * r;
        sd += (l - r) * (l - r);
        ss += (l + r) * (l + r);
      }
      const n = bufL.length;
      const rmsL = Math.sqrt(sl / n);
      const rmsR = Math.sqrt(sr / n);
      const rmsDiff = Math.sqrt(sd / n);
      const rmsSum = Math.sqrt(ss / n);
      const peak = Math.max(rmsL, rmsR);
      let verdict = "silent";
      if (peak > 0.0015) {
        const diffRatio = rmsDiff / peak;
        const sumRatio = rmsSum / peak;
        if (diffRatio < 0.03) {
          verdict = "MONO (both channels identical)";
        } else if (sumRatio < 0.1) {
          verdict = "INVERTED (L and R cancel - kills centre dialogue)";
        } else {
          verdict = `stereo (difference ${(diffRatio * 100).toFixed(0)}%)`;
        }
      }
      return {
        channels: source.channelCount,
        rmsL,
        rmsR,
        rmsDiff,
        rmsSum,
        verdict,
      };
    },
    close() {
      void ctx.close().catch(() => undefined);
    },
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rate(current: AnyStat | null, previous: AnyStat | undefined, field: string): string {
  if (!current || !previous) {
    return "…";
  }
  const seconds = (current.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) {
    return "…";
  }
  const delta = num(current[field]) - num(previous[field]);
  return `${Math.round((delta * 8) / seconds / 1000)} kbps`;
}

export async function buildReport(
  pc: RTCPeerConnection,
  previous: Map<string, AnyStat>,
  header: Record<string, string>,
  probe: AudioProbeReading | null,
): Promise<{ text: string; snapshot: Map<string, AnyStat> }> {
  const report = await pc.getStats();
  const snapshot = new Map<string, AnyStat>();
  const byId = new Map<string, AnyStat>();
  report.forEach((entry) => {
    const stat = entry as unknown as AnyStat;
    snapshot.set(stat.id, stat);
    byId.set(stat.id, stat);
  });

  const lines: string[] = [];
  for (const [key, value] of Object.entries(header)) {
    lines.push(`${key}: ${value}`);
  }

  const pair = [...byId.values()].find(
    (stat) => stat.type === "candidate-pair" && (stat.nominated === true || stat.state === "succeeded"),
  );
  if (pair) {
    const local = byId.get(str(pair.localCandidateId));
    const remote = byId.get(str(pair.remoteCandidateId));
    lines.push(
      `path: ${str(local?.candidateType) || "?"} -> ${str(remote?.candidateType) || "?"} over ${str(local?.protocol) || "?"}`,
    );
    lines.push(`rtt: ${Math.round(num(pair.currentRoundTripTime) * 1000)} ms`);
    if (pair.availableOutgoingBitrate) {
      lines.push(`available up: ${Math.round(num(pair.availableOutgoingBitrate) / 1000)} kbps`);
    }
  }

  const outbound = [...byId.values()].filter((stat) => stat.type === "outbound-rtp");
  for (const stat of outbound) {
    const codec = byId.get(str(stat.codecId));
    const prev = previous.get(stat.id);
    const kind = str(stat.kind);
    const base = `send ${kind}: ${str(codec?.mimeType) || "?"} ${rate(stat, prev, "bytesSent")}`;
    if (kind === "video") {
      lines.push(
        `${base} ${num(stat.frameWidth)}x${num(stat.frameHeight)} @${Math.round(num(stat.framesPerSecond))}fps limited=${str(stat.qualityLimitationReason) || "none"} encoder=${str(stat.encoderImplementation) || "?"}`,
      );
    } else {
      lines.push(`${base} fmtp=${str(codec?.sdpFmtpLine) || "-"}`);
    }
  }

  const inbound = [...byId.values()].filter((stat) => stat.type === "inbound-rtp");
  for (const stat of inbound) {
    const codec = byId.get(str(stat.codecId));
    const prev = previous.get(stat.id);
    const kind = str(stat.kind);
    const base = `recv ${kind}: ${str(codec?.mimeType) || "?"} ${rate(stat, prev, "bytesReceived")}`;
    if (kind === "video") {
      lines.push(
        `${base} ${num(stat.frameWidth)}x${num(stat.frameHeight)} @${Math.round(num(stat.framesPerSecond))}fps lost=${num(stat.packetsLost)} freezes=${num(stat.freezeCount)} decoder=${str(stat.decoderImplementation) || "?"}`,
      );
    } else {
      lines.push(
        `${base} lost=${num(stat.packetsLost)} jitter=${num(stat.jitter).toFixed(3)} fmtp=${str(codec?.sdpFmtpLine) || "-"}`,
      );
    }
  }

  if (probe) {
    lines.push(
      `audio channels: ${probe.channels} L=${probe.rmsL.toFixed(4)} R=${probe.rmsR.toFixed(4)} L-R=${probe.rmsDiff.toFixed(4)} L+R=${probe.rmsSum.toFixed(4)}`,
    );
    lines.push(`audio verdict: ${probe.verdict}`);
  }

  for (const [label, sdp] of [
    ["local", pc.localDescription?.sdp ?? ""],
    ["remote", pc.remoteDescription?.sdp ?? ""],
  ] as const) {
    const opusFmtp = sdp.split(/\r?\n/).find((line) => /^a=fmtp:\d+ .*(stereo|minptime)/i.test(line));
    if (opusFmtp) {
      lines.push(`${label} opus line: ${opusFmtp.replace("a=fmtp:", "")}`);
    }
  }

  return { text: lines.join("\n"), snapshot };
}
