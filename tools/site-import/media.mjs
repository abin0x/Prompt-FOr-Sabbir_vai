// File checks shared by the copy step, written to match what the Dashboard does
// to an upload (admin-panel/src/lib/media.ts).

import crypto from "node:crypto";

/** The real type of a file from its first bytes; servers often send the wrong one. */
export function sniff(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "webp";
  }
  if (bytes.toString("latin1", 4, 8) === "ftyp") return "mp4";
  return null;
}

export const IMAGE_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Same thresholds as the Dashboard's findContentBox. */
const NEAR_WHITE = 235;
const NEAR_CLEAR = 16;
const EMPTY_SHARE = 0.98;
const MIN_KEPT_SHARE = 0.5;

/**
 * The part of an RGBA picture inside its white or transparent margins, or null
 * when there is nothing to cut or cutting would remove too much.
 */
export function findContentBox(pixels, width, height) {
  const empty = (x, y) => {
    const i = (y * width + x) * 4;
    return (
      pixels[i + 3] < NEAR_CLEAR ||
      (pixels[i] >= NEAR_WHITE && pixels[i + 1] >= NEAR_WHITE && pixels[i + 2] >= NEAR_WHITE)
    );
  };
  const rowEmpty = (y, from, to) => {
    let count = 0;
    for (let x = from; x < to; x++) if (empty(x, y)) count++;
    return count >= (to - from) * EMPTY_SHARE;
  };
  const columnEmpty = (x, from, to) => {
    let count = 0;
    for (let y = from; y < to; y++) if (empty(x, y)) count++;
    return count >= (to - from) * EMPTY_SHARE;
  };
  let top = 0;
  let bottom = height;
  while (top < bottom && rowEmpty(top, 0, width)) top++;
  while (bottom > top && rowEmpty(bottom - 1, 0, width)) bottom--;
  let left = 0;
  let right = width;
  while (left < right && columnEmpty(left, top, bottom)) left++;
  while (right > left && columnEmpty(right - 1, top, bottom)) right--;
  const nothingToCut = top === 0 && left === 0 && bottom === height && right === width;
  const tooMuch =
    right - left < width * MIN_KEPT_SHARE || bottom - top < height * MIN_KEPT_SHARE;
  return nothingToCut || tooMuch ? null : { left, top, right, bottom };
}

/** Seconds of an MP4, read from its movie header; null when it cannot be found. */
export function mp4Duration(bytes) {
  const find = (start, end, type) => {
    let at = start;
    while (at + 8 <= end) {
      let size = bytes.readUInt32BE(at);
      const name = bytes.toString("latin1", at + 4, at + 8);
      let header = 8;
      if (size === 1) {
        if (at + 16 > end) return null;
        size = Number(bytes.readBigUInt64BE(at + 8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header) return null;
      if (name === type) return { start: at + header, end: Math.min(at + size, end) };
      at += size;
    }
    return null;
  };
  const moov = find(0, bytes.length, "moov");
  if (!moov) return null;
  const mvhd = find(moov.start, moov.end, "mvhd");
  if (!mvhd) return null;
  const version = bytes[mvhd.start];
  const scaleAt = mvhd.start + (version === 1 ? 20 : 12);
  const timescale = bytes.readUInt32BE(scaleAt);
  const duration =
    version === 1 ? Number(bytes.readBigUInt64BE(scaleAt + 4)) : bytes.readUInt32BE(scaleAt + 4);
  if (!timescale) return null;
  return Math.round(duration / timescale);
}

/**
 * A UUID made from a name, so the same item always gets the same file names
 * and running the copy again never makes a second copy.
 */
export function uuidFor(name) {
  const hash = crypto.createHash("sha1").update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
