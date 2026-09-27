import assert from "node:assert/strict";
import { reportFromMoov } from "../src/client/lib/inspect.ts";

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tkhd(): Uint8Array {
  const payload = new Uint8Array(84);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0x00000003);
  view.setUint32(76, 3840 << 16);
  view.setUint32(80, 2160 << 16);
  return box("tkhd", payload);
}

function mdhd(language: string): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  const packed =
    ((language.charCodeAt(0) - 0x60) << 10) |
    ((language.charCodeAt(1) - 0x60) << 5) |
    (language.charCodeAt(2) - 0x60);
  view.setUint16(20, packed);
  return box("mdhd", payload);
}

function hdlr(kind: string): Uint8Array {
  const payload = new Uint8Array(24);
  payload[8] = kind.charCodeAt(0);
  payload[9] = kind.charCodeAt(1);
  payload[10] = kind.charCodeAt(2);
  payload[11] = kind.charCodeAt(3);
  return box("hdlr", payload);
}

function videoTrack(codec: string): Uint8Array {
  const stsd = box("stsd", concat(new Uint8Array(8), box(codec, new Uint8Array(0))));
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", concat(mdhd("und"), hdlr("vide"), minf));
  return box("trak", concat(tkhd(), mdia));
}

function audioTrack(language: string, channels: number): Uint8Array {
  const specific = new Uint8Array([0x05, 0x02, 0x11, channels === 6 ? 0xb0 : 0x90]);
  const configBody = new Uint8Array(13 + specific.length);
  configBody[0] = 0x40;
  configBody.set(specific, 13);
  const config = concat(new Uint8Array([0x04, configBody.length]), configBody);
  const esBody = concat(new Uint8Array([0x00, 0x01, 0x00]), config);
  const esds = box("esds", concat(new Uint8Array(4), new Uint8Array([0x03, esBody.length]), esBody));
  const sampleBody = new Uint8Array(28);
  const sampleView = new DataView(sampleBody.buffer);
  sampleView.setUint16(16, 2);
  const mp4a = box("mp4a", concat(sampleBody, esds));
  const stsd = box("stsd", concat(new Uint8Array(8), mp4a));
  const mdia = box("mdia", concat(mdhd(language), hdlr("soun"), box("minf", box("stbl", stsd))));
  return box("trak", concat(tkhd(), mdia));
}

function moov(...traks: Uint8Array[]): Uint8Array {
  return box("moov", concat(...traks));
}

const ready = reportFromMoov(moov(videoTrack("avc1"), audioTrack("eng", 6), audioTrack("hin", 2)));
assert.equal(ready.ready, true);
assert.ok(ready.notes.some((note) => note.tone === "ok" && note.text.includes("H.264")));
assert.ok(ready.notes.some((note) => note.tone === "ok" && note.text.includes("AAC") && note.text.includes("5.1")));
assert.ok(ready.notes.some((note) => note.tone === "warn" && note.text.includes("English")));
assert.ok(ready.notes.some((note) => note.tone === "warn" && note.text.includes("softer picture")));

const hevc = reportFromMoov(moov(videoTrack("hvc1"), audioTrack("eng", 2)));
assert.equal(hevc.ready, false);
assert.ok(hevc.notes.some((note) => note.tone === "block" && note.text.includes("H.265")));

const ac3Sample = box("ac-3", new Uint8Array(28));
const ac3 = reportFromMoov(
  moov(
    videoTrack("avc1"),
    box(
      "trak",
      concat(
        tkhd(),
        box("mdia", concat(mdhd("eng"), hdlr("soun"), box("minf", box("stbl", box("stsd", concat(new Uint8Array(8), ac3Sample)))))),
      ),
    ),
  ),
);
assert.equal(ac3.ready, false);
assert.ok(ac3.notes.some((note) => note.tone === "block" && note.text.includes("AC-3")));

console.log("inspect-media: ok");
