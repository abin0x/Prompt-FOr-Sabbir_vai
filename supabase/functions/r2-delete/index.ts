// Admin only. Two uses:
//   { "id": "<video id>" }  deletes the row and then its files.
//   { "keys": ["..."] }     removes files from an upload that was never saved.
import { deleteObject } from "../_shared/r2.ts";
import { corsHeaders, fail, json, requireAdmin } from "../_shared/http.ts";

const KEY_PATTERN = /^(videos|images|thumbs)\/[0-9a-f-]{36}\.[a-z0-9]+$/;

async function removeFiles(keys: string[]): Promise<boolean> {
  const results = await Promise.all(
    keys.map((key) => deleteObject(key).catch(() => false)),
  );
  return results.every(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Use POST", 405);

  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  const { client } = auth;

  const body = await req.json().catch(() => null);

  if (Array.isArray(body?.keys)) {
    const keys: string[] = body.keys;
    if (keys.length === 0 || keys.length > 10) {
      return fail("Send between 1 and 10 keys", 400);
    }
    if (!keys.every((key) => KEY_PATTERN.test(key))) {
      return fail("Invalid file key", 400);
    }
    // Never remove a file that a saved video still uses.
    const { count, error } = await client.from("videos")
      .select("id", { count: "exact", head: true })
      .or(`media_path.in.(${keys}),thumb_path.in.(${keys})`);
    if (error) return fail("Could not check file use", 500);
    if (count) return fail("A saved video still uses this file", 409);
    return json({ filesRemoved: await removeFiles(keys) });
  }

  if (typeof body?.id !== "string") return fail("id or keys is required", 400);

  const { data: video, error: readError } = await client.from("videos")
    .select("media_path, thumb_path").eq("id", body.id).maybeSingle();
  if (readError) return fail("Could not read the video", 500);
  if (!video) return fail("Video not found", 404);

  // Row first: leftover files only cost storage, but a row whose file is gone
  // would show as a broken video in the app.
  const { error: deleteError } = await client.from("videos")
    .delete().eq("id", body.id);
  if (deleteError) return fail("Could not delete the video", 500);

  const keys = [video.media_path, video.thumb_path].filter(Boolean);
  return json({ deleted: true, filesRemoved: await removeFiles(keys) });
});
