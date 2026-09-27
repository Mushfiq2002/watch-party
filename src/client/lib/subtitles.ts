const MAX_SUBTITLE_FILE_BYTES = 2_000_000;
const MAX_SUBTITLE_CUES = 20_000;

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export async function parseSubtitleFile(file: File): Promise<SubtitleCue[]> {
  if (file.size > MAX_SUBTITLE_FILE_BYTES) {
    throw new Error("Subtitle files must be smaller than 2 MB.");
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith(".srt") && !name.endsWith(".vtt")) {
    throw new Error("Choose an .srt or .vtt subtitle file.");
  }
  return parseSubtitleText(await file.text());
}

export function parseSubtitleText(raw: string): SubtitleCue[] {
  const normalized = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) {
    throw new Error("The subtitle file is empty.");
  }

  const cues: SubtitleCue[] = [];
  const blocks = normalized.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }
    const timing = lines[timingIndex].match(
      /((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!timing) {
      continue;
    }
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    const text = cleanCueText(lines.slice(timingIndex + 1).join("\n"));
    if (start === null || end === null || end <= start || !text) {
      continue;
    }
    cues.push({ start, end, text });
    if (cues.length >= MAX_SUBTITLE_CUES) {
      break;
    }
  }

  cues.sort((left, right) => left.start - right.start || left.end - right.end);
  if (cues.length === 0) {
    throw new Error("No readable subtitle cues were found. Use standard SRT or WebVTT timing.");
  }
  return cues;
}

export function subtitleTextAt(cues: SubtitleCue[], seconds: number): string {
  return subtitleCueAt(cues, seconds)?.text ?? "";
}

export function subtitleCueAt(cues: SubtitleCue[], seconds: number): SubtitleCue | null {
  if (cues.length === 0 || !Number.isFinite(seconds)) {
    return null;
  }
  let low = 0;
  let high = cues.length - 1;
  let lastStarted = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= seconds) {
      lastStarted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (lastStarted === -1) {
    return null;
  }

  const active: SubtitleCue[] = [];
  for (let index = lastStarted; index >= 0 && index >= lastStarted - 20; index -= 1) {
    const cue = cues[index];
    if (cue.start <= seconds && seconds < cue.end) {
      active.unshift(cue);
    }
  }
  if (active.length === 0) {
    return null;
  }
  return {
    start: Math.min(...active.map((cue) => cue.start)),
    end: Math.max(...active.map((cue) => cue.end)),
    text: active.map((cue) => cue.text).join("\n"),
  };
}

function parseTimestamp(raw: string): number | null {
  const parts = raw.replace(",", ".").split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite) || seconds >= 60 || minutes >= 60) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanCueText(raw: string): string {
  return raw
    .replace(/<\/?(?:b|i|u|ruby|rt|c(?:\.[^>]*)?|v(?:\s+[^>]*)?|lang(?:\s+[^>]*)?)>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, 2_000);
}
