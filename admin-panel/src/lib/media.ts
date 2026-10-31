/** Browser-side checks and helpers for files before they are uploaded. */

export const MB = 1024 * 1024;

/** Above this a clip is likely not compressed for the app (target: 0.5-1.5 MB). */
export const VIDEO_WARN_BYTES = 5 * MB;
export const VIDEO_MAX_BYTES = 100 * MB;
export const IMAGE_MAX_BYTES = 15 * MB;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type ContentType = "video" | "image";

export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(n / 1000)}K`;
}

export type ItemStatus = "live" | "scheduled" | "hidden";

export function itemStatus(
  row: { is_published: boolean; publish_at: string | null },
  now = Date.now(),
): ItemStatus {
  if (!row.is_published) return "hidden";
  return row.publish_at && new Date(row.publish_at).getTime() > now
    ? "scheduled"
    : "live";
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  live: "Live",
  scheduled: "Scheduled",
  hidden: "Hidden",
};

/** A title from a file name: my_clip-01.mp4 becomes "my clip 01". */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .slice(0, 120);
}

export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  return tags;
}

/** Returns why this file cannot be used, or null if it is fine. */
export function validateFile(
  file: { type: string; size: number },
  contentType: ContentType,
): string | null {
  if (contentType === "video") {
    if (file.type !== "video/mp4") return "Video must be an MP4 file.";
    if (file.size > VIDEO_MAX_BYTES) return "Video must be under 100 MB.";
  } else {
    if (!IMAGE_TYPES.includes(file.type)) {
      return "Image must be JPG, PNG or WebP.";
    }
    if (file.size > IMAGE_MAX_BYTES) return "Image must be under 15 MB.";
  }
  return null;
}

/**
 * Whether an MP4 can start playing before it finishes downloading, which needs
 * the `moov` box ahead of `mdat` (ffmpeg's -movflags +faststart). Returns null
 * if the file's structure cannot be read.
 */
export function isFaststart(bytes: Uint8Array): boolean | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (name === "moov") return true;
    if (name === "mdat") return false;
    if (size === 1) {
      if (offset + 16 > bytes.length) return null;
      const high = view.getUint32(offset + 8);
      if (high !== 0) return null;
      size = view.getUint32(offset + 12);
    }
    if (size < 8) return null;
    offset += size;
  }
  return null;
}

export async function checkFaststart(file: File): Promise<boolean | null> {
  // Boxes before moov/mdat are small, so the start of the file is enough.
  const head = await file.slice(0, 256 * 1024).arrayBuffer();
  return isFaststart(new Uint8Array(head));
}

export interface VideoInfo {
  durationSec: number;
  thumb: Blob;
}

const THUMB_MAX_WIDTH = 720;

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No thumbnail"))),
      "image/jpeg",
      0.82,
    ),
  );
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A pixel this close to white, or this see-through, counts as empty margin. */
const NEAR_WHITE = 235;
const NEAR_CLEAR = 16;
/** A few stray pixels do not stop a row or column counting as empty. */
const EMPTY_SHARE = 0.98;
/** Mostly white pictures are left alone: their white is the picture. */
const MIN_KEPT_SHARE = 0.5;

/**
 * The part of an RGBA picture inside its white or transparent margins, so cards
 * are filled by the picture rather than its background. Null means there is
 * nothing to cut, or cutting would remove too much.
 */
export function findContentBox(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): Box | null {
  const empty = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return (
      pixels[i + 3] < NEAR_CLEAR ||
      (pixels[i] >= NEAR_WHITE &&
        pixels[i + 1] >= NEAR_WHITE &&
        pixels[i + 2] >= NEAR_WHITE)
    );
  };
  const rowEmpty = (y: number, from: number, to: number) => {
    let count = 0;
    for (let x = from; x < to; x++) if (empty(x, y)) count++;
    return count >= (to - from) * EMPTY_SHARE;
  };
  const columnEmpty = (x: number, from: number, to: number) => {
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

/** Large enough to find margins accurately, small enough to be instant. */
const MARGIN_CHECK_SIZE = 480;

/** The margins of a picture of any size, in its own pixels. */
function findMargins(
  source: CanvasImageSource,
  width: number,
  height: number,
): Box | null {
  const scale = Math.min(1, MARGIN_CHECK_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const box = findContentBox(data, canvas.width, canvas.height);
  if (!box) return null;
  // Rounded inward, so no sliver of the margin survives the scaling.
  return {
    left: Math.ceil(box.left / scale),
    top: Math.ceil(box.top / scale),
    right: Math.floor(box.right / scale),
    bottom: Math.floor(box.bottom / scale),
  };
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const box = findMargins(source, width, height) ?? {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
  };
  const cutWidth = box.right - box.left;
  const cutHeight = box.bottom - box.top;
  const scale = Math.min(1, THUMB_MAX_WIDTH / cutWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cutWidth * scale);
  canvas.height = Math.round(cutHeight * scale);
  canvas
    .getContext("2d")!
    .drawImage(
      source,
      box.left,
      box.top,
      cutWidth,
      cutHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  return canvas;
}

/** The frame a video is showing now, as a thumbnail. */
export function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  return canvasToJpeg(drawScaled(video, video.videoWidth, video.videoHeight));
}

/** Reads the length of a video and grabs a thumbnail from just after the start. */
export function readVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const done = (action: () => void) => {
      URL.revokeObjectURL(url);
      action();
    };
    video.onerror = () =>
      done(() => reject(new Error("This browser cannot read this video.")));
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, video.duration / 2);
    };
    video.onseeked = async () => {
      try {
        const canvas = drawScaled(video, video.videoWidth, video.videoHeight);
        const thumb = await canvasToJpeg(canvas);
        const durationSec = Math.round(video.duration);
        done(() => resolve({ durationSec, thumb }));
      } catch (error) {
        done(() => reject(error));
      }
    };
    video.src = url;
  });
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; done: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const done = () => URL.revokeObjectURL(url);
    image.onerror = () => {
      done();
      reject(new Error("This image cannot be read."));
    };
    image.onload = () => resolve({ image, done });
    image.src = url;
  });
}

/**
 * Cuts white or transparent margins off an image. The same file is returned
 * when there are none, so a clean image is uploaded untouched.
 */
export async function trimImageFile(file: File): Promise<File> {
  const { image, done } = await loadImage(file);
  try {
    const box = findMargins(image, image.naturalWidth, image.naturalHeight);
    if (!box) return file;
    const canvas = document.createElement("canvas");
    canvas.width = box.right - box.left;
    canvas.height = box.bottom - box.top;
    canvas
      .getContext("2d")!
      .drawImage(image, -box.left, -box.top);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, 0.92),
    );
    return blob ? new File([blob], file.name, { type: file.type }) : file;
  } finally {
    done();
  }
}

export interface PreparedFile {
  file: File;
  thumb: Blob;
  durationSec: number | null;
  warnings: string[];
}

/** Everything done to a chosen file before upload. Throws if it cannot be read. */
export async function prepareFile(
  chosen: File,
  contentType: ContentType,
): Promise<PreparedFile> {
  const warnings: string[] = [];
  if (contentType === "image") {
    const file = await trimImageFile(chosen);
    if (file !== chosen) {
      warnings.push(
        "White edges around this image were removed, so it fills the card in the app.",
      );
    }
    return { file, thumb: await makeImageThumb(file), durationSec: null, warnings };
  }
  const info = await readVideo(chosen);
  if (chosen.size > VIDEO_WARN_BYTES) {
    warnings.push(
      `This video is ${formatBytes(chosen.size)}. Clips of 0.5 to 1.5 MB start much faster in the app.`,
    );
  }
  if ((await checkFaststart(chosen)) === false) {
    warnings.push(
      "This video is not optimized for streaming and will start slowly. Re-export it with ffmpeg using -movflags +faststart.",
    );
  }
  return { file: chosen, thumb: info.thumb, durationSec: info.durationSec, warnings };
}

export function makeImageThumb(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image cannot be read."));
    };
    image.onload = async () => {
      try {
        const canvas = drawScaled(image, image.naturalWidth, image.naturalHeight);
        resolve(await canvasToJpeg(canvas));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.src = url;
  });
}
