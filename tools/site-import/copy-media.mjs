// Copies the images and videos behind the old websites' prompts into Prompt
// Lab's R2 bucket, then writes the file the Dashboard imports
// (Library > Website import). Nothing is saved to the database here.
//
//   cd tools/site-import && npm install
//   node copy-media.mjs <photo_prompts.json> <video_prompts.json> [--limit N]
//
// The R2 keys come from supabase/.env.production and are never printed. Run it
// again to retry what failed: finished files are remembered in out/state.json,
// and every item keeps the same file names, so nothing is copied twice.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { AwsClient } from "aws4fetch";
import { BATCH, planItems } from "./plan.mjs";
import { IMAGE_TYPES, findContentBox, mp4Duration, sniff, uuidFor } from "./media.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
const statePath = path.join(outDir, "state.json");
const manifestPath = path.join(outDir, "prompt-lab-site-import.json");
const reportPath = path.join(outDir, "report.json");

const MB = 1024 * 1024;
const IMAGE_MAX = 15 * MB;
const VIDEO_MAX = 100 * MB;
const THUMB_MAX_WIDTH = 720;
const MARGIN_CHECK_SIZE = 480;
const WORKERS = 8;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const USER_AGENT = "Mozilla/5.0 (compatible; PromptLabImport/1.0)";

// ------------------------------------------------------------------ input

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const [photoPath, videoPath] = args.filter(
  (arg, i) => !arg.startsWith("--") && (limitAt < 0 || i !== limitAt + 1),
);
if (!photoPath || !videoPath) {
  console.error("Usage: node copy-media.mjs <photo_prompts.json> <video_prompts.json> [--limit N]");
  process.exit(1);
}

function readRows(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(rows)) throw new Error(`${file} has no list of prompts.`);
  return rows;
}

function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv(path.resolve(here, "../../supabase/.env.production"));
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
  if (!env[name]) {
    console.error(`${name} is missing from supabase/.env.production.`);
    process.exit(1);
  }
}
const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});
const r2Base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;

// ---------------------------------------------------------------- network

class Permanent extends Error {}
const deadHosts = new Set();

async function download(url, maxBytes, timeoutMs) {
  let address;
  try {
    address = new URL(url);
  } catch {
    throw new Permanent("The link is not valid.");
  }
  if (deadHosts.has(address.host)) throw new Permanent(`${address.host} does not exist any more.`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(address.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ([401, 403, 404, 410].includes(response.status)) {
        throw new Permanent(`The server answered ${response.status}.`);
      }
      if (!response.ok) throw new Error(`The server answered ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Permanent("The file is empty.");
      if (bytes.length > maxBytes) {
        throw new Permanent(`The file is larger than ${maxBytes / MB} MB.`);
      }
      return bytes;
    } catch (error) {
      if (error instanceof Permanent) throw error;
      const code = error?.cause?.code;
      if (code === "ENOTFOUND") {
        deadHosts.add(address.host);
        throw new Permanent(`${address.host} does not exist any more.`);
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(lastError?.name === "TimeoutError" ? "The download timed out." : String(lastError?.message ?? lastError));
}

async function upload(key, body, contentType) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await r2
      .fetch(`${r2Base}/${key}`, {
        method: "PUT",
        headers: { "Content-Type": contentType, "Cache-Control": CACHE_CONTROL },
        body,
      })
      .catch((error) => ({ ok: false, status: 0, text: async () => String(error.message) }));
    if (response.ok) return;
    const detail = (await response.text()).slice(0, 120);
    if (attempt === 3) throw new Error(`Storage refused the upload (${response.status}): ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

// ------------------------------------------------------------------ files

/** Where the picture sits inside its white or transparent margins, in its own pixels. */
async function margins(bytes) {
  const { width, height } = await sharp(bytes, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true }).then((r) => r.info);
  const scale = Math.min(1, MARGIN_CHECK_SIZE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { data } = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const box = findContentBox(data, w, h);
  if (!box) return { width, height, box: null };
  return {
    width,
    height,
    box: {
      left: Math.ceil(box.left / scale),
      top: Math.ceil(box.top / scale),
      width: Math.floor(box.right / scale) - Math.ceil(box.left / scale),
      height: Math.floor(box.bottom / scale) - Math.ceil(box.top / scale),
    },
  };
}

/** Like the Dashboard: margins cut, at most 720 wide, JPEG at 82. */
async function makeThumb(bytes) {
  const { box } = await margins(bytes);
  let image = sharp(bytes, { failOn: "none" }).rotate();
  if (box) image = image.extract(box);
  return image
    .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/** The image as uploaded: untouched when it has no margins, cut when it does. */
async function prepareImage(bytes) {
  let type = sniff(bytes);
  if (!IMAGE_TYPES[type]) {
    // Another picture format: stored as WebP, which every phone can show.
    bytes = await sharp(bytes, { failOn: "none" }).rotate().webp({ quality: 90 }).toBuffer();
    type = "webp";
  }
  const { box } = await margins(bytes);
  if (box) {
    const image = sharp(bytes, { failOn: "none" }).rotate().extract(box);
    bytes =
      type === "jpg"
        ? await image.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : type === "png"
          ? await image.png().toBuffer()
          : await image.webp({ quality: 92 }).toBuffer();
  }
  return { bytes, type, thumb: await makeThumb(bytes) };
}

async function copyItem(item) {
  const id = uuidFor(`${BATCH}:${item.key}`);
  if (item.contentType === "image") {
    const original = await download(item.mediaUrl, IMAGE_MAX, 60_000);
    const { bytes, type, thumb } = await prepareImage(original).catch((error) => {
      throw new Permanent(`The image cannot be read (${error.message}).`);
    });
    const mediaPath = `images/${id}.${type}`;
    const thumbPath = `thumbs/${id}.jpg`;
    await upload(mediaPath, bytes, IMAGE_TYPES[type]);
    await upload(thumbPath, thumb, "image/jpeg");
    return { media_path: mediaPath, thumb_path: thumbPath, media_bytes: bytes.length, duration_sec: null };
  }

  const video = await download(item.mediaUrl, VIDEO_MAX, 180_000);
  if (sniff(video) !== "mp4") throw new Permanent("The file is not an MP4 video.");
  const mediaPath = `videos/${id}.mp4`;
  await upload(mediaPath, video, "video/mp4");
  const result = {
    media_path: mediaPath,
    thumb_path: null,
    media_bytes: video.length,
    duration_sec: mp4Duration(video),
  };
  if (item.thumbUrl) {
    try {
      const thumb = await makeThumb(await download(item.thumbUrl, IMAGE_MAX, 60_000));
      const thumbPath = `thumbs/${id}.jpg`;
      await upload(thumbPath, thumb, "image/jpeg");
      result.thumb_path = thumbPath;
    } catch (error) {
      result.thumb_error = error.message;
    }
  }
  return result;
}

// ------------------------------------------------------------------- run

function save(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

fs.mkdirSync(outDir, { recursive: true });
const { items: allItems, skipped } = planItems(readRows(photoPath), readRows(videoPath));
const items = allItems.slice(0, limit);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

const todo = items.filter((item) => !state[item.key]?.media_path);
console.log(`${items.length} items, ${items.length - todo.length} already copied, ${todo.length} to copy.`);

let done = 0;
let failed = 0;
let bytes = 0;
const started = Date.now();
let next = 0;
async function worker() {
  while (next < todo.length) {
    const item = todo[next++];
    try {
      const result = await copyItem(item);
      state[item.key] = result;
      bytes += result.media_bytes;
    } catch (error) {
      state[item.key] = { error: error.message, permanent: error instanceof Permanent };
      failed++;
    }
    done++;
    if (done % 25 === 0) save(statePath, state);
    if (done % 100 === 0 || done === todo.length) {
      const minutes = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`${done}/${todo.length} done, ${failed} failed, ${(bytes / MB).toFixed(0)} MB, ${minutes} min`);
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
save(statePath, state);

// ---------------------------------------------------------------- outputs

const manifestItems = items.map((item) => {
  const copied = state[item.key] ?? {};
  return {
    source_name: `site-${item.key}`,
    title: item.title,
    content_type: item.contentType,
    category: item.category,
    tags: item.tags,
    prompt: item.prompt,
    media_path: copied.media_path ?? null,
    thumb_path: copied.thumb_path ?? null,
    duration_sec: copied.duration_sec ?? null,
    media_bytes: copied.media_bytes ?? null,
    created_at: item.createdAt,
  };
});
save(manifestPath, {
  format: "prompt-lab-site-import",
  version: 1,
  batch: BATCH,
  created: new Date().toISOString(),
  items: manifestItems,
});

const failures = items
  .filter((item) => state[item.key]?.error)
  .map((item) => ({ key: item.key, url: item.mediaUrl, error: state[item.key].error }));
const byReason = {};
for (const failure of failures) {
  const reason = failure.error.replace(/\d{3}\./, "NNN.");
  byReason[reason] = (byReason[reason] ?? 0) + 1;
}
const thumbFailures = items
  .filter((item) => state[item.key]?.thumb_error)
  .map((item) => ({ key: item.key, url: item.thumbUrl, error: state[item.key].thumb_error }));
save(reportPath, { skipped, failures, thumbFailures, byReason });

const withFile = manifestItems.filter((item) => item.media_path).length;
console.log(`Manifest: ${manifestItems.length} items, ${withFile} with a file, ${manifestItems.length - withFile} without.`);
console.log(`Left out before copying: ${skipped.length}. Failures by reason: ${JSON.stringify(byReason)}`);
console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`);
