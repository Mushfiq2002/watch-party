export type MediaNote = {
  tone: "block" | "warn" | "ok";
  text: string;
};

export type MediaReport = {
  ready: boolean;
  notes: MediaNote[];
};

const MOOV_LIMIT_BYTES = 40_000_000;

export async function inspectVideoFile(file: File): Promise<MediaReport> {
  const sniffed = await sniffContainer(file);
  const container = sniffed ?? containerLabel(file);
  if (container) {
    return blocked(
      `This is ${container}. This player starts MP4 files. Convert it locally, then drop the new file here.`,
    );
  }

  try {
    const moov = await readMoov(file);
    if (!moov) {
      return blocked("This file's details could not be read. Use an MP4, then drop it here again.");
    }
    return reportFromMoov(moov);
  } catch {
    return blocked("This file's details could not be read. Use an MP4, then drop it here again.");
  }
}

export function reportFromMoov(moov: Uint8Array): MediaReport {
  const moovBox = readTopBox(moov);
  if (!moovBox || moovBox.type !== "moov") {
    return blocked("This file's details could not be read. Use an MP4, then drop it here again.");
  }

  const tracks = childBoxes(moov, moovBox.contentStart, moovBox.end)
    .filter((box) => box.type === "trak")
    .map((box) => readTrack(moov, box))
    .filter((track) => track.enabled);

  const video = tracks.find((track) => track.kind === "video");
  const audio = tracks.filter((track) => track.kind === "audio");
  const subtitles = tracks.filter((track) => track.kind === "subtitle");
  const notes: MediaNote[] = [];

  if (!video) {
    notes.push({ tone: "block", text: "No video track was found. This player needs an H.264 picture." });
  } else if (video.codec !== "h264") {
    notes.push({
      tone: "block",
      text: `The video is ${video.codecLabel}. This player needs H.264. Convert the video locally, then drop the new file here.`,
    });
  } else {
    const size = video.width && video.height ? ` (${video.width}×${video.height})` : "";
    notes.push({ tone: "ok", text: `Video is H.264${size}.` });
    if ((video.width ?? 0) > 1920 || (video.height ?? 0) > 1080) {
      notes.push({
        tone: "warn",
        text: "The picture is larger than 1080p. Your friend will see a softer picture than you do. You can still start.",
      });
    }
  }

  const firstAudio = audio[0];
  if (!firstAudio) {
    notes.push({ tone: "block", text: "No audio track was found. This player needs AAC or MP3 audio." });
  } else if (firstAudio.codec !== "aac" && firstAudio.codec !== "mp3") {
    notes.push({
      tone: "block",
      text: `The audio is ${firstAudio.codecLabel}. This player needs AAC or MP3. Convert the audio locally, then drop the new file here.`,
    });
  } else {
    const channels = channelLabel(firstAudio.channels);
    notes.push({
      tone: "ok",
      text: `Audio is ${firstAudio.codecLabel}${channels ? `, ${channels}` : ""}.`,
    });
    if ((firstAudio.channels ?? 0) > 2) {
      notes.push({
        tone: "warn",
        text: `The audio is ${channelLabel(firstAudio.channels)}. Your friend will hear a stereo mix. You can start.`,
      });
    }
  }

  if (audio.length > 1 && firstAudio) {
    const language = firstAudio.language ? ` It is ${firstAudio.language}.` : "";
    notes.push({
      tone: "warn",
      text: `Only the first audio track will play.${language} The other ${audio.length - 1} will not. If that is the wrong language, put the right track first locally, then drop the new file here. You can still start.`,
    });
  }

  if (subtitles.length > 0) {
    const count = subtitles.length === 1 ? "a subtitle stream" : `${subtitles.length} subtitle streams`;
    notes.push({
      tone: "warn",
      text: `This file includes ${count}. Subtitles inside the video will not appear. Add a separate .srt or .vtt below if you want captions. You can still start.`,
    });
  }

  return { ready: notes.every((note) => note.tone !== "block"), notes };
}

function blocked(text: string): MediaReport {
  return { ready: false, notes: [{ tone: "block", text }] };
}

async function sniffContainer(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return file.name.toLowerCase().endsWith(".webm") ? "a WebM file" : "an MKV file";
  }
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
    return "an AVI file";
  }
  return null;
}

function containerLabel(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".mkv")) return "an MKV file";
  if (name.endsWith(".webm")) return "a WebM file";
  if (name.endsWith(".avi")) return "an AVI file";
  if (name.endsWith(".wmv")) return "a WMV file";
  if (name.endsWith(".flv")) return "an FLV file";
  if (name.endsWith(".ts") || name.endsWith(".m2ts")) return "a transport-stream file";
  if (name.endsWith(".hevc") || name.endsWith(".h265")) return "a raw H.265 file";
  if (
    name.endsWith(".mp4") ||
    name.endsWith(".m4v") ||
    name.endsWith(".mov") ||
    file.type === "video/mp4" ||
    file.type === "video/quicktime"
  ) {
    return null;
  }
  if (file.type.startsWith("video/")) return "a video this player does not start from directly";
  return "not an MP4 file";
}

async function readMoov(file: File): Promise<Uint8Array | null> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const headerBytes = await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer();
    const header = new DataView(headerBytes);
    const size32 = header.getUint32(0);
    const type = fourcc(header, 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (headerBytes.byteLength < 16) return null;
      size = header.getUint32(8) * 2 ** 32 + header.getUint32(12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = file.size - offset;
    }
    if (!Number.isFinite(size) || size < headerSize) return null;
    if (type === "moov") {
      if (size > MOOV_LIMIT_BYTES) return null;
      const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
      return bytes.byteLength === size ? bytes : null;
    }
    offset += size;
  }
  return null;
}

type Kind = "video" | "audio" | "subtitle" | "other";

type TrackInfo = {
  kind: Kind;
  enabled: boolean;
  codec: string;
  codecLabel: string;
  channels?: number;
  width?: number;
  height?: number;
  language?: string;
};

type Box = {
  type: string;
  contentStart: number;
  end: number;
};

function readTrack(bytes: Uint8Array, trak: Box): TrackInfo {
  const tkhd = findChild(bytes, trak, "tkhd");
  const mdia = findChild(bytes, trak, "mdia");
  const hdlr = mdia ? findChild(bytes, mdia, "hdlr") : undefined;
  const mdhd = mdia ? findChild(bytes, mdia, "mdhd") : undefined;
  const stsd = findNested(bytes, mdia, ["minf", "stbl", "stsd"]);
  const handler = hdlr ? fourccAt(bytes, hdlr.contentStart + 8) : "";
  const kind = kindFromHandler(handler);
  const sample = stsd ? firstSample(bytes, stsd) : undefined;
  const codecFourcc = sample?.type ?? "";
  const audioMeta = sample && kind === "audio" ? readAudio(bytes, sample) : undefined;
  const dimensions = tkhd && kind === "video" ? readDimensions(bytes, tkhd) : undefined;
  const identified = identifyCodec(codecFourcc, audioMeta?.objectType);
  return {
    kind: kind === "other" && identified.kind !== "other" ? identified.kind : kind,
    enabled: tkhd ? (new DataView(bytes.buffer, bytes.byteOffset + tkhd.contentStart, 4).getUint32(0) & 1) === 1 : true,
    codec: identified.codec,
    codecLabel: identified.label,
    channels: audioMeta?.channels,
    width: dimensions?.width,
    height: dimensions?.height,
    language: mdhd ? readLanguage(bytes, mdhd) : undefined,
  };
}

function identifyCodec(fourccName: string, objectType?: number): { kind: Kind; codec: string; label: string } {
  const name = fourccName.toLowerCase();
  if (name === "avc1" || name === "avc3" || name === "avc4") return { kind: "video", codec: "h264", label: "H.264" };
  if (name === "hvc1" || name === "hev1" || name === "dvh1" || name === "dvhe") {
    return { kind: "video", codec: "h265", label: "H.265" };
  }
  if (name === "vp08") return { kind: "video", codec: "vp8", label: "VP8" };
  if (name === "vp09") return { kind: "video", codec: "vp9", label: "VP9" };
  if (name === "av01") return { kind: "video", codec: "av1", label: "AV1" };
  if (name === "mp4v") return { kind: "video", codec: "mpeg4", label: "MPEG-4" };
  if (objectType === 0x69 || objectType === 0x6b || name === "mp3" || name === ".mp3") {
    return { kind: "audio", codec: "mp3", label: "MP3" };
  }
  if (name === "mp4a") return { kind: "audio", codec: "aac", label: "AAC" };
  if (name === "ac-3" || name === "dac3") return { kind: "audio", codec: "ac3", label: "AC-3" };
  if (name === "ec-3" || name === "dec3") return { kind: "audio", codec: "eac3", label: "E-AC-3" };
  if (name.startsWith("dts")) return { kind: "audio", codec: "dts", label: "DTS" };
  if (name === "tx3g" || name === "text" || name === "subt" || name === "sbtl" || name === "wvtt" || name === "c608") {
    return { kind: "subtitle", codec: name, label: "subtitles" };
  }
  return { kind: "other", codec: name || "unknown", label: fourccName || "an unknown codec" };
}

function kindFromHandler(handler: string): Kind {
  if (handler === "vide") return "video";
  if (handler === "soun") return "audio";
  if (handler === "sbtl" || handler === "subt" || handler === "text" || handler === "subp" || handler === "clcp") {
    return "subtitle";
  }
  return "other";
}

function readAudio(bytes: Uint8Array, sample: Box): { channels?: number; objectType?: number } {
  const bodyLength = sample.end - sample.contentStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset + sample.contentStart, bodyLength);
  let channels = view.byteLength >= 18 ? view.getUint16(16) : undefined;
  const childStart = sample.contentStart + 28;
  const esds =
    childStart < sample.end ? childBoxes(bytes, childStart, sample.end).find((box) => box.type === "esds") : undefined;
  const specific = esds ? readEsds(bytes, esds) : undefined;
  if (specific?.channels) channels = specific.channels;
  return { channels, objectType: specific?.objectType };
}

function readEsds(bytes: Uint8Array, esds: Box): { channels?: number; objectType?: number } | undefined {
  let cursor = esds.contentStart + 4;
  const end = esds.end;
  if (cursor >= end || bytes[cursor] !== 0x03) return undefined;
  cursor += 1 + descriptorSize(bytes, cursor + 1).bytesRead;
  cursor += 3;
  if (bytes[cursor] !== 0x04) return undefined;
  const config = descriptorSize(bytes, cursor + 1);
  const configStart = cursor + 1 + config.bytesRead;
  const objectType = bytes[configStart];
  let nested = configStart + 13;
  const configEnd = Math.min(end, configStart + config.size);
  while (nested < configEnd && bytes[nested] !== 0x05) {
    const skipped = descriptorSize(bytes, nested + 1);
    nested += 1 + skipped.bytesRead + skipped.size;
  }
  if (nested >= configEnd || bytes[nested] !== 0x05) return { objectType };
  const specific = descriptorSize(bytes, nested + 1);
  const dataStart = nested + 1 + specific.bytesRead;
  if (dataStart >= end) return { objectType };
  const objectAndFreq = (bytes[dataStart] << 8) | (bytes[dataStart + 1] ?? 0);
  const channelConfig = (objectAndFreq >> 3) & 0x0f;
  const channels = channelConfig === 7 ? 8 : channelConfig >= 1 && channelConfig <= 6 ? channelConfig : undefined;
  return { objectType, channels };
}

function descriptorSize(bytes: Uint8Array, offset: number): { size: number; bytesRead: number } {
  let size = 0;
  let bytesRead = 0;
  while (bytesRead < 4 && offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead += 1;
    size = (size << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { size, bytesRead };
}

function readDimensions(bytes: Uint8Array, tkhd: Box): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset + tkhd.contentStart, tkhd.end - tkhd.contentStart);
  const version = view.getUint8(0);
  const widthAt = version === 1 ? 88 : 76;
  if (view.byteLength < widthAt + 8) return undefined;
  return {
    width: view.getUint32(widthAt) >> 16,
    height: view.getUint32(widthAt + 4) >> 16,
  };
}

function readLanguage(bytes: Uint8Array, mdhd: Box): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset + mdhd.contentStart, mdhd.end - mdhd.contentStart);
  const version = view.getUint8(0);
  const languageAt = version === 1 ? 32 : 20;
  if (view.byteLength < languageAt + 2) return undefined;
  const packed = view.getUint16(languageAt) & 0x7fff;
  if (packed === 0) return undefined;
  const language = String.fromCharCode(((packed >> 10) & 0x1f) + 0x60, ((packed >> 5) & 0x1f) + 0x60, (packed & 0x1f) + 0x60);
  if (language === "und" || language.trim() === "") return undefined;
  return languageLabel(language);
}

function languageLabel(code: string): string {
  const names: Record<string, string> = {
    eng: "English",
    hin: "Hindi",
    ben: "Bengali",
    tam: "Tamil",
    tel: "Telugu",
    mar: "Marathi",
    urd: "Urdu",
    ara: "Arabic",
    spa: "Spanish",
    fra: "French",
    fre: "French",
    deu: "German",
    ger: "German",
    por: "Portuguese",
    rus: "Russian",
    jpn: "Japanese",
    kor: "Korean",
    zho: "Chinese",
    chi: "Chinese",
    ita: "Italian",
    tur: "Turkish",
  };
  return names[code] ?? code;
}

function channelLabel(channels?: number): string {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  if (channels && channels > 2) return `${channels} channels`;
  return "";
}

function firstSample(bytes: Uint8Array, stsd: Box): Box | undefined {
  const start = stsd.contentStart + 8;
  return start < stsd.end ? readBox(bytes, start, stsd.end) : undefined;
}

function findNested(bytes: Uint8Array, parent: Box | undefined, path: string[]): Box | undefined {
  let current = parent;
  for (const type of path) {
    if (!current) return undefined;
    current = findChild(bytes, current, type);
  }
  return current;
}

function findChild(bytes: Uint8Array, parent: Box, type: string): Box | undefined {
  return childBoxes(bytes, parent.contentStart, parent.end).find((box) => box.type === type);
}

function childBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const box = readBox(bytes, cursor, end);
    if (!box) break;
    boxes.push(box);
    cursor = box.end;
  }
  return boxes;
}

function readTopBox(bytes: Uint8Array): Box | undefined {
  return readBox(bytes, 0, bytes.length);
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Box | undefined {
  if (offset + 8 > limit) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, limit - offset);
  const size32 = view.getUint32(0);
  const type = fourcc(view, 4);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (view.byteLength < 16) return undefined;
    size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return undefined;
  return { type, contentStart: offset + headerSize, end: offset + size };
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
