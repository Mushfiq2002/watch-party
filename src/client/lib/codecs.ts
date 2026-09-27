export function warnForFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (
    name.endsWith(".mkv") ||
    name.endsWith(".avi") ||
    name.endsWith(".wmv") ||
    name.endsWith(".flv") ||
    name.endsWith(".ts") ||
    name.endsWith(".m2ts") ||
    name.endsWith(".hevc") ||
    name.endsWith(".h265") ||
    type.includes("matroska") ||
    type.includes("x-msvideo")
  ) {
    return `${file.name} is likely to fail in the browser. Use MP4 with H.264 video and AAC audio.`;
  }

  if (name.endsWith(".mov") || type === "video/quicktime") {
    return "QuickTime files only play when they contain H.264 + AAC. If this fails, remux to MP4.";
  }

  if (!name.endsWith(".mp4") && !name.endsWith(".m4v") && !name.endsWith(".webm") && !type.startsWith("video/")) {
    return "This file may not be a browser-playable video. MP4 (H.264 + AAC) is the supported codec.";
  }

  return null;
}

export function httpMixedContentWarning(url: string): string | null {
  if (url.startsWith("http://") && window.location.protocol === "https:") {
    return "This page is HTTPS, so browsers often block plain HTTP video (mixed content). If it fails, download the file and stream it as a local file instead.";
  }
  return null;
}

export function captureVideoStream(video: HTMLVideoElement): MediaStream {
  let captured: MediaStream;
  if (typeof video.captureStream === "function") {
    captured = video.captureStream();
  } else if (typeof video.webkitCaptureStream === "function") {
    captured = video.webkitCaptureStream();
  } else {
    throw new Error(
      "This browser cannot stream a local file to your friend (captureStream is missing). Host from desktop Chrome, Firefox, or Edge. iPhone as a viewer still works.",
    );
  }

  const stereoTrack = getStereoMovieTrack(video);
  if (!stereoTrack) {
    return captured;
  }
  return new MediaStream([...captured.getVideoTracks(), stereoTrack]);
}

type MovieAudioRoute = {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  localGain: GainNode;
};

const movieAudioRoutes = new WeakMap<HTMLVideoElement, MovieAudioRoute>();

/**
 * Once an element feeds Web Audio, its own volume and mute also silence the copy
 * sent to the guest. Keep the element at full level and apply the host's volume
 * only to what the host hears.
 */
export function setMovieVolume(video: HTMLVideoElement, volume: number, muted: boolean): void {
  const route = movieAudioRoutes.get(video);
  if (!route) {
    video.volume = volume;
    video.muted = muted;
    return;
  }
  video.volume = 1;
  video.muted = false;
  route.localGain.gain.value = muted ? 0 : volume;
  void route.context.resume().catch(() => undefined);
}

export function resumeMovieAudio(video: HTMLVideoElement): void {
  void movieAudioRoutes.get(video)?.context.resume().catch(() => undefined);
}

/**
 * captureStream() can expose only the front L/R pair of a 5.1 movie, dropping
 * centre-channel dialogue. A Web Audio stereo speaker destination performs the
 * standard 5.1 → 2.0 downmix before the track is encoded as Opus for the SFU.
 */
function getStereoMovieTrack(video: HTMLVideoElement): MediaStreamTrack | null {
  const existing = movieAudioRoutes.get(video);
  if (existing) {
    void existing.context.resume().catch(() => undefined);
    return existing.destination.stream.getAudioTracks()[0] ?? null;
  }

  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    return null;
  }

  try {
    const context = new AudioCtor();
    const source = context.createMediaElementSource(video);
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    destination.channelCountMode = "explicit";
    destination.channelInterpretation = "speakers";

    // The media element's sound is rerouted through the graph once a source node
    // exists, so keep a local output as well as the SFU stereo output.
    const localGain = context.createGain();
    localGain.gain.value = video.muted ? 0 : video.volume;
    source.connect(localGain);
    localGain.connect(context.destination);
    source.connect(destination);
    movieAudioRoutes.set(video, { context, destination, localGain });
    video.volume = 1;
    video.muted = false;
    void context.resume().catch(() => undefined);
    return destination.stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}
