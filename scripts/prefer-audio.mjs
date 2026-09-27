#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

const [, , inputPath, preference, explicitOutput] = process.argv;

if (!inputPath) {
  usage();
  process.exitCode = 1;
} else {
  try {
    await main(inputPath, preference, explicitOutput);
  } catch (error) {
    console.error(`\nAudio preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function main(input, preferred, outputArgument) {
  requireCommand("ffprobe");
  requireCommand("ffmpeg");
  await access(input);

  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,channels,channel_layout:stream_tags=language,title",
      "-of",
      "json",
      input,
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    throw new Error(probe.stderr.trim() || "ffprobe could not inspect this movie.");
  }

  const streams = JSON.parse(probe.stdout).streams ?? [];
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  if (audio.length === 0) {
    throw new Error("No audio streams were found.");
  }

  console.log("Audio tracks:");
  audio.forEach((stream, audioIndex) => {
    const language = stream.tags?.language || "und";
    const title = stream.tags?.title ? ` · ${stream.tags.title}` : "";
    const layout = stream.channel_layout || `${stream.channels ?? "?"} channels`;
    console.log(
      `  ${audioIndex + 1}. ${language} · ${stream.codec_name ?? "unknown"} · ${layout}${title}`,
    );
  });

  if (!preferred) {
    console.log("\nNothing changed. Add a language code or track number to create a browser-ready copy.");
    console.log(`Example: npm run audio:prefer -- ${quote(input)} eng`);
    return;
  }

  const normalized = preferred.toLowerCase();
  const requestedNumber = Number.parseInt(preferred, 10);
  const selected = Number.isFinite(requestedNumber) && String(requestedNumber) === preferred
    ? audio[requestedNumber - 1]
    : audio.find((stream) => (stream.tags?.language || "und").toLowerCase() === normalized);
  if (!selected) {
    throw new Error(`No audio track matches ${quote(preferred)}.`);
  }

  const language = selected.tags?.language || `track-${audio.indexOf(selected) + 1}`;
  const extension = extname(input) || ".mp4";
  const stem = basename(input, extension);
  const output = outputArgument || join(dirname(input), `${stem}.${language}-first${extension}`);
  const orderedAudio = [selected, ...audio.filter((stream) => stream !== selected)];

  const args = ["-n", "-i", input, "-map", "0:v?"];
  for (const stream of orderedAudio) {
    args.push("-map", `0:${stream.index}`);
  }
  args.push("-map", "0:s?", "-map_metadata", "0", "-map_chapters", "0", "-c", "copy");
  orderedAudio.forEach((_, index) => {
    args.push(`-disposition:a:${index}`, index === 0 ? "default" : "0");
  });
  if ([".mp4", ".m4v", ".mov"].includes(extension.toLowerCase())) {
    args.push("-movflags", "+faststart");
  }
  args.push(output);

  console.log(`\nCreating ${output}`);
  console.log(`Preferred track: ${language} (original stream ${selected.index})`);
  console.log("Video and audio are copied without re-encoding or quality loss.\n");

  const ffmpeg = spawn("ffmpeg", args, { stdio: "inherit" });
  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.once("error", reject);
    ffmpeg.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with status ${exitCode}.`);
  }
  console.log(`\nReady: ${output}`);
}

function requireCommand(command) {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} is required. Install it with: brew install ffmpeg`);
  }
}

function quote(value) {
  return JSON.stringify(value);
}

function usage() {
  console.log("Usage: npm run audio:prefer -- <movie> [language-or-track-number] [output]");
  console.log("Omit the preference to list the movie's audio tracks without changing anything.");
}
