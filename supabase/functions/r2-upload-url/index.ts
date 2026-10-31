// Gives a signed admin a short-lived link to upload one file straight to R2, so
// the R2 secret key never reaches the browser.
import { CACHE_CONTROL, presignUpload } from "../_shared/r2.ts";
import { corsHeaders, fail, json, requireAdmin } from "../_shared/http.ts";

const MB = 1024 * 1024;

const KINDS: Record<
  string,
  { folder: string; maxBytes: number; types: Record<string, string> }
> = {
  video: {
    folder: "videos",
    maxBytes: 100 * MB,
    types: { "video/mp4": "mp4" },
  },
  image: {
    folder: "images",
    maxBytes: 15 * MB,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
  thumb: {
    folder: "thumbs",
    maxBytes: 2 * MB,
    types: { "image/jpeg": "jpg", "image/webp": "webp" },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Use POST", 405);

  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const kind = KINDS[body?.kind];
  if (!kind) return fail("kind must be video, image or thumb", 400);

  const extension = kind.types[body?.contentType];
  if (!extension) {
    return fail(
      `File type must be one of: ${Object.keys(kind.types).join(", ")}`,
      400,
    );
  }

  const size = Number(body?.size);
  if (!Number.isFinite(size) || size <= 0) return fail("size is required", 400);
  if (size > kind.maxBytes) {
    return fail(`File is larger than ${kind.maxBytes / MB} MB`, 413);
  }

  const key = `${kind.folder}/${crypto.randomUUID()}.${extension}`;
  try {
    const url = await presignUpload(key, body.contentType);
    return json({
      url,
      key,
      headers: {
        "Content-Type": body.contentType,
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch (error) {
    console.error("presign failed", error);
    return fail("Storage is not configured", 500);
  }
});
