import type { MediaPublication, MediaSource } from "../../shared/protocol";

type SessionDescription = {
  sdp: string;
  type: "offer" | "answer";
};

type CallsTrack = {
  mid?: string;
  trackName?: string;
  errorCode?: string;
  errorDescription?: string;
};

type TrackResponse = {
  errorCode?: string;
  errorDescription?: string;
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: CallsTrack[];
};

type PublishedSource = {
  publication: MediaPublication;
  transceivers: RTCRtpTransceiver[];
  stream: MediaStream;
};

type CallsErrorBody = {
  error?: string;
  errorCode?: string;
  errorDescription?: string;
};

export class RealtimeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RealtimeRequestError";
    this.status = status;
  }
}

type RemoteSubscription = {
  source: MediaSource;
  mid?: string;
};

type IceServersResponse = {
  iceServers?: RTCIceServer[];
};

export type RealtimePeerHandlers = {
  onPublications: (publications: MediaPublication[]) => void;
  onRemoteStream: (source: MediaSource, stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onIceState: (state: RTCIceConnectionState) => void;
};

/** A single WebRTC connection from this browser to Cloudflare's nearest SFU edge. */
export class RealtimePeer {
  readonly pc: RTCPeerConnection;
  private readonly apiBase: string;
  private readonly token: string;
  private readonly handlers: RealtimePeerHandlers;
  private readonly published = new Map<MediaSource, PublishedSource>();
  private readonly subscribed = new Map<string, RemoteSubscription>();
  private readonly remoteSourceByMid = new Map<string, MediaSource>();
  private readonly remoteStreams: Record<MediaSource, MediaStream> = {
    cam: new MediaStream(),
    movie: new MediaStream(),
  };
  private sessionId: string | null = null;
  private operation: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(code: string, mediaToken: string, handlers: RealtimePeerHandlers) {
    this.apiBase = `/api/rooms/${encodeURIComponent(code)}/realtime`;
    this.token = mediaToken;
    this.handlers = handlers;
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });

    this.pc.onconnectionstatechange = () => this.handlers.onConnectionState(this.pc.connectionState);
    this.pc.oniceconnectionstatechange = () => this.handlers.onIceState(this.pc.iceConnectionState);
    this.pc.ontrack = (event) => {
      const mid = event.transceiver.mid;
      const source = mid ? this.remoteSourceByMid.get(mid) : undefined;
      if (!source) {
        return;
      }
      const stream = this.remoteStreams[source];
      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track);
      }
      event.track.onended = () => {
        stream.removeTrack(event.track);
        this.handlers.onRemoteStream(source, stream.getTracks().length > 0 ? stream : null);
      };
      this.handlers.onRemoteStream(source, stream);
    };
  }

  async start(): Promise<void> {
    if (this.sessionId || this.closed) {
      return;
    }
    // TURN is optional on the Worker. If it is configured, these short-lived
    // credentials let mobile and restricted networks relay to the SFU over
    // TCP/TLS when direct UDP connectivity is unavailable.
    try {
      const response = await this.request<IceServersResponse>("ice-servers", "POST");
      if (Array.isArray(response.iceServers) && response.iceServers.length > 0) {
        this.pc.setConfiguration({
          ...this.pc.getConfiguration(),
          iceServers: response.iceServers,
        });
      }
    } catch {
      // STUN remains configured as the baseline, so a temporary TURN
      // credential failure must not prevent otherwise viable connections.
    }
    const response = await this.request<{ sessionId: string }>("session", "POST");
    this.sessionId = response.sessionId;
  }

  async resetSession(): Promise<void> {
    await resetRealtimeSession(this.apiBase, this.token);
    this.sessionId = null;
    this.published.clear();
    this.subscribed.clear();
  }

  publish(source: MediaSource, stream: MediaStream): Promise<void> {
    return this.enqueue(async () => {
      await this.start();
      const current = this.published.get(source);
      const liveTracks = stream.getTracks().filter((track) => track.readyState === "live");
      if (
        current?.stream === stream &&
        liveTracks.length > 0 &&
        current.publication.tracks.length === liveTracks.length
      ) {
        return;
      }
      await this.unpublishNow(source);
      if (this.closed || !this.sessionId) {
        return;
      }

      const transceivers: RTCRtpTransceiver[] = [];
      let remoteApplied = false;
      try {
        for (const track of stream.getTracks()) {
          track.contentHint =
            source === "movie"
              ? track.kind === "video"
                ? "motion"
                : "music"
              : track.kind === "video"
                ? "detail"
                : "speech";
          const init: RTCRtpTransceiverInit = { direction: "sendonly" };
          if (track.kind === "video") {
            init.sendEncodings = [
              {
                maxBitrate: source === "movie" ? 4_000_000 : 250_000,
                maxFramerate: source === "movie" ? 30 : 15,
                priority: source === "movie" ? "high" : "low",
                networkPriority: source === "movie" ? "high" : "low",
              },
            ];
          }
          transceivers.push(this.pc.addTransceiver(track, init));
        }

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        const tracks = transceivers.map((transceiver) => {
          const mid = transceiver.mid;
          const trackName = transceiver.sender.track?.id;
          if (!mid || !trackName) {
            throw new Error("The browser did not assign a media id for this track.");
          }
          return { location: "local" as const, mid, trackName };
        });
        const response = await this.request<TrackResponse>("tracks/new", "POST", {
          sessionDescription: this.pc.localDescription,
          tracks,
        });
        this.assertCallsResponse(response);
        if (!response.sessionDescription) {
          throw new Error("Cloudflare did not answer the media offer.");
        }
        await this.pc.setRemoteDescription(response.sessionDescription);
        remoteApplied = true;

        const publication: MediaPublication = {
          source,
          sessionId: this.sessionId,
          tracks: transceivers.flatMap((transceiver, index) => {
            const track = transceiver.sender.track;
            const trackName = response.tracks?.[index]?.trackName ?? tracks[index]?.trackName;
            return track && trackName
              ? [{ trackName, kind: track.kind as "audio" | "video" }]
              : [];
          }),
        };
        this.published.set(source, { publication, transceivers, stream });
        this.emitPublications();
      } catch (error) {
        if (!remoteApplied) {
          this.rollbackTransceivers(transceivers);
        }
        throw error;
      }
    });
  }

  unpublish(source: MediaSource): Promise<void> {
    return this.enqueue(() => this.unpublishNow(source));
  }

  subscribe(publications: MediaPublication[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      const wanted = publications.flatMap((publication) =>
        publication.tracks.map((track) => ({
          ...track,
          source: publication.source,
          sessionId: publication.sessionId,
          key: `${publication.sessionId}:${track.trackName}`,
        })),
      );
      const wantedKeys = new Set(wanted.map((track) => track.key));
      const stale = [...this.subscribed.entries()]
        .filter(([key]) => !wantedKeys.has(key))
        .map(([key, value]) => ({ key, source: value.source, mid: value.mid }));
      await this.releaseRemoteTracks(stale);
      for (const source of ["cam", "movie"] as const) {
        if (wanted.some((track) => track.source === source)) {
          continue;
        }
        this.clearRemoteSource(source);
      }

      const fresh = wanted.filter((track) => !this.subscribed.has(track.key));
      if (fresh.length === 0 || this.closed) {
        return;
      }
      await this.start();
      if (this.closed || !this.sessionId) {
        return;
      }

      const response = await this.request<TrackResponse>("tracks/new", "POST", {
        tracks: fresh.map((track) => ({
          location: "remote",
          sessionId: track.sessionId,
          trackName: track.trackName,
        })),
      });
      this.assertCallsResponse(response);
      const refused: string[] = [];
      const pending: Array<{ key: string; source: MediaSource; mid: string }> = [];
      fresh.forEach((item, index) => {
        const result = response.tracks?.[index];
        if (result?.errorCode || !result?.mid) {
          const reason = result?.errorDescription || result?.errorCode || "no media id returned";
          refused.push(`${item.source} ${item.kind}: ${reason}`);
          return;
        }
        pending.push({ key: item.key, source: item.source, mid: result.mid });
      });
      for (const track of pending) {
        this.remoteSourceByMid.set(track.mid, track.source);
      }
      try {
        if (pending.length > 0 && response.requiresImmediateRenegotiation) {
          await this.answerServerOffer(response);
        }
      } catch (error) {
        this.detachPendingRemoteTracks(pending);
        throw error;
      }
      const missing = pending.filter(
        (track) => !this.pc.getTransceivers().some((transceiver) => transceiver.mid === track.mid),
      );
      for (const track of pending) {
        if (!missing.includes(track)) {
          this.subscribed.set(track.key, { source: track.source, mid: track.mid });
        }
      }
      if (missing.length > 0) {
        this.detachPendingRemoteTracks(missing);
        refused.push(...missing.map((track) => `${track.source}: Cloudflare sent no media for it`));
      }
      if (refused.length > 0) {
        throw new Error(`Cloudflare refused your friend's ${refused.join("; ")}.`);
      }
    });
  }

  close(): void {
    this.closed = true;
    this.subscribed.clear();
    this.remoteSourceByMid.clear();
    this.pc.close();
    for (const source of ["cam", "movie"] as const) {
      const stream = this.remoteStreams[source];
      stream.getTracks().forEach((track) => stream.removeTrack(track));
      this.handlers.onRemoteStream(source, null);
    }
  }

  private rollbackTransceivers(transceivers: RTCRtpTransceiver[]): void {
    if (this.closed || this.pc.connectionState === "closed") {
      return;
    }
    for (const transceiver of transceivers) {
      try {
        transceiver.stop();
      } catch {
        try {
          if (transceiver.sender.track) {
            this.pc.removeTrack(transceiver.sender);
          }
          transceiver.direction = "inactive";
        } catch {
          // Keep the original publish error if cleanup cannot finish.
        }
      }
    }
  }

  private async releaseRemoteTracks(
    stale: Array<{ key: string; source: MediaSource; mid?: string }>,
  ): Promise<void> {
    if (stale.length === 0 || this.closed) {
      return;
    }
    const mids = stale.flatMap((track) => (track.mid ? [track.mid] : []));
    try {
      if (mids.length > 0 && this.sessionId) {
        const response = await this.request<TrackResponse>("tracks/close", "PUT", {
          tracks: mids.map((mid) => ({ mid })),
        });
        this.assertCallsResponse(response);
        if (response.requiresImmediateRenegotiation) {
          await this.answerServerOffer(response);
        }
      }
    } catch (error) {
      if (this.closed || this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
        this.forgetRemoteTracks(stale);
        throw error;
      }
    }
    this.forgetRemoteTracks(stale);
  }

  private forgetRemoteTracks(stale: Array<{ key: string; source: MediaSource; mid?: string }>): void {
    const sources = new Set<MediaSource>();
    for (const track of stale) {
      this.subscribed.delete(track.key);
      sources.add(track.source);
      if (!track.mid) {
        continue;
      }
      this.remoteSourceByMid.delete(track.mid);
      const transceiver = this.pc.getTransceivers().find((item) => item.mid === track.mid);
      const mediaTrack = transceiver?.receiver.track;
      if (mediaTrack) {
        this.remoteStreams[track.source].removeTrack(mediaTrack);
      }
    }
    for (const source of sources) {
      const stillSubscribed = [...this.subscribed.values()].some((item) => item.source === source);
      const stream = this.remoteStreams[source];
      if (!stillSubscribed) {
        for (const track of stream.getTracks()) {
          stream.removeTrack(track);
        }
        this.handlers.onRemoteStream(source, null);
      } else {
        this.handlers.onRemoteStream(source, stream.getTracks().length > 0 ? stream : null);
      }
    }
  }

  private detachPendingRemoteTracks(
    pending: Array<{ key: string; source: MediaSource; mid?: string }>,
  ): void {
    for (const track of pending) {
      if (!track.mid) {
        continue;
      }
      this.remoteSourceByMid.delete(track.mid);
      const transceiver = this.pc.getTransceivers().find((item) => item.mid === track.mid);
      const mediaTrack = transceiver?.receiver.track;
      if (mediaTrack) {
        this.remoteStreams[track.source].removeTrack(mediaTrack);
      }
    }
    for (const source of new Set(pending.map((track) => track.source))) {
      const stream = this.remoteStreams[source];
      if (stream.getTracks().length === 0) {
        this.handlers.onRemoteStream(source, null);
      }
    }
  }

  private clearRemoteSource(source: MediaSource): void {
    const stream = this.remoteStreams[source];
    let removed = false;
    for (const track of stream.getTracks()) {
      stream.removeTrack(track);
      removed = true;
    }
    for (const [mid, mapped] of this.remoteSourceByMid) {
      if (mapped === source) {
        this.remoteSourceByMid.delete(mid);
        removed = true;
      }
    }
    for (const [key, value] of this.subscribed) {
      if (value.source === source) {
        this.subscribed.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.handlers.onRemoteStream(source, null);
    }
  }

  private async unpublishNow(source: MediaSource): Promise<void> {
    const current = this.published.get(source);
    if (!current || !this.sessionId || this.closed) {
      return;
    }
    const tracks = current.transceivers.flatMap((transceiver) =>
      transceiver.mid ? [{ mid: transceiver.mid }] : [],
    );
    if (tracks.length > 0) {
      const response = await this.request<TrackResponse>("tracks/close", "PUT", { tracks });
      this.assertCallsResponse(response);
      if (response.requiresImmediateRenegotiation) {
        await this.answerServerOffer(response);
      }
    }
    for (const transceiver of current.transceivers) {
      this.pc.removeTrack(transceiver.sender);
      transceiver.direction = "inactive";
    }
    this.published.delete(source);
    this.emitPublications();
  }

  private async answerServerOffer(response: TrackResponse): Promise<void> {
    if (!response.sessionDescription) {
      throw new Error("Cloudflare requested renegotiation without an offer.");
    }
    await this.pc.setRemoteDescription(response.sessionDescription);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const renegotiated = await this.request<TrackResponse>("renegotiate", "PUT", {
      sessionDescription: this.pc.localDescription,
    });
    this.assertCallsResponse(renegotiated);
  }

  private emitPublications(): void {
    this.handlers.onPublications([...this.published.values()].map((item) => item.publication));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private assertCallsResponse(response: TrackResponse): void {
    if (response.errorCode) {
      throw new Error(
        response.errorDescription
          ? `${response.errorDescription} (${response.errorCode})`
          : `Cloudflare Realtime error ${response.errorCode}`,
      );
    }
  }

  private async request<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as (T & CallsErrorBody) | null;
    if (!response.ok) {
      throw new RealtimeRequestError(response.status, callsErrorMessage(payload, response.status));
    }
    if (!payload) {
      throw new Error("Realtime returned an empty response.");
    }
    return payload;
  }
}

function callsErrorMessage(payload: CallsErrorBody | null, status: number): string {
  const description = payload?.errorDescription || payload?.error;
  const code = payload?.errorCode;
  if (description && code) {
    return `${description} (${code})`;
  }
  if (description) {
    return description;
  }
  if (code) {
    return `Cloudflare Realtime error ${code}`;
  }
  return `Realtime request failed (${status}).`;
}

export async function resetRealtimeSession(codeOrApiBase: string, mediaToken: string): Promise<void> {
  const apiBase = codeOrApiBase.startsWith("/")
    ? codeOrApiBase
    : `/api/rooms/${encodeURIComponent(codeOrApiBase)}/realtime`;
  const response = await fetch(`${apiBase}/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${mediaToken}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Realtime session reset failed (${response.status}).`);
  }
}

export async function getCameraStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return null;
  }
}
