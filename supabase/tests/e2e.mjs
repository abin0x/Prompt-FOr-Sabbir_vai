// End-to-end check of the backend against a local Supabase and a local
// S3-compatible server standing in for R2. See supabase/tests/README.md.
//
// Run from admin-panel/ so @supabase/supabase-js resolves:
//   node ../supabase/tests/e2e.mjs
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY.");
  process.exit(2);
}

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, noSession);
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, noSession);

async function makeUser(email) {
  const password = `Pw-${crypto.randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, noSession);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { client, id: data.user.id, token: signIn.data.session.access_token };
}

// Signed links name the host the functions container uses for the test server.
// Windows cannot reach that name, so connect to localhost but keep the signed
// Host header. Real R2 links need none of this.
function putSigned(url, headers, body) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        method: "PUT",
        headers: { ...headers, Host: target.host, "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const stamp = Date.now();
const admin = await makeUser(`admin-${stamp}@test.local`);
const outsider = await makeUser(`outsider-${stamp}@test.local`);
await service.from("admins").insert({ user_id: admin.id });

async function callFunction(name, body, token) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function upload(kind, contentType, bytes) {
  const res = await callFunction(
    "r2-upload-url",
    { kind, contentType, size: bytes.length },
    admin.token,
  );
  if (res.status !== 200) throw new Error(`presign ${res.status} ${JSON.stringify(res.body)}`);
  const put = await putSigned(res.body.url, res.body.headers, bytes);
  return { key: res.body.key, status: put.status, url: res.body.url, headers: res.body.headers };
}

const objectUrl = (key) => `${process.env.S3_PUBLIC_BASE}/${key}`;

console.log("\nUpload access");
const smallVideo = new Uint8Array(2048).fill(7);
{
  const noAuth = await callFunction("r2-upload-url", { kind: "video", contentType: "video/mp4", size: 10 });
  check("signed-out caller is refused", noAuth.status === 401, `got ${noAuth.status}`);
  const notAdmin = await callFunction("r2-upload-url", { kind: "video", contentType: "video/mp4", size: 10 }, outsider.token);
  check("signed-in non-admin is refused", notAdmin.status === 403, `got ${notAdmin.status}`);
  const anonKey = await callFunction("r2-upload-url", { kind: "video", contentType: "video/mp4", size: 10 }, SUPABASE_ANON_KEY);
  check("the anon key alone is refused", anonKey.status === 401, `got ${anonKey.status}`);
  const badType = await callFunction("r2-upload-url", { kind: "video", contentType: "text/html", size: 10 }, admin.token);
  check("wrong file type is refused", badType.status === 400, `got ${badType.status}`);
  const tooBig = await callFunction("r2-upload-url", { kind: "video", contentType: "video/mp4", size: 101 * 1024 * 1024 }, admin.token);
  check("oversized file is refused", tooBig.status === 413, `got ${tooBig.status}`);
  const badKind = await callFunction("r2-upload-url", { kind: "exe", contentType: "video/mp4", size: 10 }, admin.token);
  check("unknown kind is refused", badKind.status === 400, `got ${badKind.status}`);
}

console.log("\nUpload to storage");
const media = await upload("video", "video/mp4", smallVideo);
const thumb = await upload("thumb", "image/jpeg", new Uint8Array(512).fill(3));
check("video reaches storage", media.status === 200, `got ${media.status}`);
check("thumbnail reaches storage", thumb.status === 200, `got ${thumb.status}`);
check("file key is a fresh id in the right folder", /^videos\/[0-9a-f-]{36}\.mp4$/.test(media.key), media.key);
{
  const swapped = await putSigned(
    media.url,
    { ...media.headers, "Content-Type": "text/html" },
    "<script>",
  );
  check("signed link cannot be reused for another file type", swapped.status >= 400, `got ${swapped.status}`);
  const signedUrl = new URL(media.url);
  const unsigned = await putSigned(signedUrl.origin + signedUrl.pathname, media.headers, "x");
  check("storage refuses an upload with no signature", unsigned.status >= 400, `got ${unsigned.status}`);
  const tampered = new URL(media.url);
  tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
  const forged = await putSigned(tampered.href, media.headers, "x");
  check("storage refuses a forged signature", forged.status >= 400, `got ${forged.status}`);
  const otherCache = await putSigned(media.url, { ...media.headers, "Cache-Control": "no-store" }, "x");
  check("signed link cannot change the cache header", otherCache.status >= 400, `got ${otherCache.status}`);
  const stored = await fetch(objectUrl(media.key));
  check("uploaded file can be read back", stored.status === 200 && (await stored.arrayBuffer()).byteLength === smallVideo.length, `got ${stored.status}`);
  check("file has the long cache header", (stored.headers.get("cache-control") ?? "").includes("immutable"), stored.headers.get("cache-control"));
}

console.log("\nSaving");
const { data: categories } = await anon.from("categories").select("id,name").order("sort_order");
check("seed categories are public", categories?.length === 6, `got ${categories?.length}`);
const prompt = `A secret test prompt ${stamp}`;
const saveArgs = (id, published) => ({
  p_id: id,
  p_title: `E2E ${stamp}`,
  p_content_type: "video",
  p_category_id: categories[0].id,
  p_tags: ["Test"],
  p_media_path: media.key,
  p_thumb_path: thumb.key,
  p_duration_sec: 12,
  p_prompt_text: prompt,
  p_is_published: published,
  p_media_bytes: smallVideo.length,
});
{
  const outsiderSave = await outsider.client.rpc("save_video", saveArgs(null, true));
  check("non-admin cannot save", Boolean(outsiderSave.error));
  const anonSave = await anon.rpc("save_video", saveArgs(null, true));
  check("anon cannot save", Boolean(anonSave.error));
  const empty = await admin.client.rpc("save_video", { ...saveArgs(null, true), p_prompt_text: "   " });
  check("empty prompt is refused", Boolean(empty.error));
  const { count } = await service.from("videos").select("id", { count: "exact", head: true }).eq("title", `E2E ${stamp}`);
  check("failed save left no video behind", count === 0, `found ${count}`);
}
const saved = await admin.client.rpc("save_video", saveArgs(null, false));
check("admin can save", !saved.error, saved.error?.message);
const videoId = saved.data;

console.log("\nHidden items");
{
  const { data } = await anon.from("videos").select("id").eq("id", videoId);
  check("hidden item is not in the public feed", data?.length === 0);
  const hiddenPrompt = await anon.rpc("get_prompt", { vid: videoId });
  check("hidden item's prompt is not available", hiddenPrompt.data === null, JSON.stringify(hiddenPrompt.data));
  const adminView = await admin.client.from("videos").select("id").eq("id", videoId);
  check("admin still sees it", adminView.data?.length === 1);
}

console.log("\nPublish: what the app does");
{
  const publish = await admin.client.rpc("save_video", saveArgs(videoId, true));
  check("publish works", !publish.error, publish.error?.message);
  const { data } = await anon
    .from("videos")
    .select("id,title,content_type,tags,media_path,thumb_path,duration_sec,view_count,created_at,categories(name)")
    .eq("is_published", true)
    .order("created_at", { ascending: false })
    .range(0, 19);
  const row = data?.find((v) => v.id === videoId);
  check("item appears in the app's feed at once", Boolean(row));
  check("feed carries the category name", row?.categories?.name === categories[0].name, JSON.stringify(row?.categories));
  check("feed carries file paths", row?.media_path === media.key && row?.thumb_path === thumb.key);
  check("feed has no prompt", row && !JSON.stringify(row).includes(prompt));
  const file = await fetch(objectUrl(row.media_path));
  check("the app can download the video by its path", file.status === 200, `got ${file.status}`);
}

console.log("\nPrompt protection");
{
  const direct = await anon.from("prompts").select("prompt_text");
  check("anon cannot read the prompts table", Boolean(direct.error) || direct.data?.length === 0, JSON.stringify(direct.data));
  const outsiderRead = await outsider.client.from("prompts").select("prompt_text");
  check("non-admin cannot read the prompts table", outsiderRead.data?.length === 0, JSON.stringify(outsiderRead.data));
  const viaFunction = await anon.rpc("get_prompt", { vid: videoId });
  check("get_prompt returns it", viaFunction.data === prompt, JSON.stringify(viaFunction));
  const adminsTable = await anon.from("admins").select("user_id");
  check("anon cannot list admins", Boolean(adminsTable.error) || adminsTable.data?.length === 0);
}

console.log("\nRate limit");
{
  await service.from("app_config").update({ value: { prompt_per_minute_per_ip: 3 } }).eq("key", "limits");
  const ip = `203.0.113.${stamp % 200}`;
  const limited = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    ...noSession,
    global: { headers: { "cf-connecting-ip": ip } },
  });
  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = await limited.rpc("get_prompt", { vid: videoId });
    results.push(r.error?.message ?? "ok");
  }
  check("calls over the limit are refused", results.filter((r) => r === "rate_limited").length >= 1, results.join(","));
  check("calls within the limit work", results[0] === "ok", results.join(","));
  await service.from("app_config").update({ value: { prompt_per_minute_per_ip: 300 } }).eq("key", "limits");
  const stored = await service.from("prompt_rate_limits").select("ip_hash").limit(5);
  check("IP addresses are stored only as hashes", !JSON.stringify(stored.data).includes(ip));
}

console.log("\nViews and Trending");
{
  const views = await anon.rpc("record_views", { vids: [videoId, videoId, videoId] });
  check("app can record views", !views.error, views.error?.message);
  const { data: row } = await anon.from("videos").select("view_count").eq("id", videoId).single();
  check("batched views are counted", Number(row?.view_count) === 3, `got ${row?.view_count}`);
  const trending = await anon.rpc("get_trending", { p_type: "video", p_limit: 10 });
  const hit = trending.data?.find((t) => t.id === videoId);
  check("Trending returns it with this week's views", Number(hit?.week_views) === 3, JSON.stringify(hit));
  check("Trending has no prompt", !JSON.stringify(trending.data).includes(prompt));
  const tampering = await anon.from("videos").update({ view_count: 999999 }).eq("id", videoId).select();
  check("anon cannot edit videos directly", Boolean(tampering.error) || tampering.data?.length === 0);
}

console.log("\nAd rules");
{
  const read = await anon.from("app_config").select("value").eq("key", "ads").single();
  check("app can read ad rules", read.data?.value?.back_to_list_every_n === 3, JSON.stringify(read));
  check("full-screen ads on button taps are gone", !("generate_prompt_every_n" in read.data.value) && !("category_tap_ad_enabled" in read.data.value), JSON.stringify(read.data.value));
  const anonWrite = await anon.from("app_config").update({ value: {} }).eq("key", "ads").select();
  check("anon cannot change ad rules", Boolean(anonWrite.error) || anonWrite.data?.length === 0);
  const adminWrite = await admin.client.from("app_config").upsert({ key: "ads", value: read.data.value });
  check("admin can change ad rules", !adminWrite.error, adminWrite.error?.message);
}

console.log("\nReports");
{
  const reporter = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    ...noSession,
    global: { headers: { "cf-connecting-ip": `198.51.100.${stamp % 200}` } },
  });
  const sent = await reporter.rpc("report_content", { vid: videoId, p_reason: "copyright", p_note: "test note" });
  check("the app can send a report", !sent.error, sent.error?.message);
  const again = await reporter.rpc("report_content", { vid: videoId, p_reason: "copyright" });
  check("a repeat report is ignored, with no error", !again.error, again.error?.message);
  const direct = await anon.from("content_reports").select("id");
  check("anon cannot read reports", Boolean(direct.error) || direct.data?.length === 0);
  const bad = await reporter.rpc("report_content", { vid: videoId, p_reason: "made-up" });
  check("an unknown reason is refused", Boolean(bad.error));
  const list = await admin.client.from("content_reports").select("id,reason,status").eq("video_id", videoId);
  check("admin sees exactly one report", list.data?.length === 1 && list.data[0].reason === "copyright", JSON.stringify(list.data));
  const outsiderList = await outsider.client.from("content_reports").select("id");
  check("non-admin sees no reports", outsiderList.data?.length === 0);
}

console.log("\nActivity log and overview");
{
  const anonLog = await anon.from("admin_activity").select("id");
  check("anon cannot read the activity log", Boolean(anonLog.error) || anonLog.data?.length === 0);
  const { data: log } = await admin.client.from("admin_activity").select("action,target_type,target_label,actor_email").order("id", { ascending: false }).limit(50);
  check("saving a video is logged with who did it", log?.some((l) => l.target_type === "videos" && l.target_label === `E2E ${stamp}` && l.actor_email?.startsWith("admin-")), JSON.stringify(log?.slice(0, 3)));
  const before = log?.length;
  await anon.rpc("record_views", { vids: [videoId] });
  const { data: after } = await admin.client.from("admin_activity").select("id").order("id", { ascending: false }).limit(50);
  check("user views do not fill the log", after?.length === before, `${before} -> ${after?.length}`);
  const denied = await anon.rpc("admin_overview");
  check("anon cannot get the overview", Boolean(denied.error));
  const denied2 = await outsider.client.rpc("admin_overview");
  check("non-admin cannot get the overview", Boolean(denied2.error));
  const overview = await admin.client.rpc("admin_overview");
  check("admin overview works", !overview.error && overview.data?.daily?.length === 14 && overview.data?.open_reports >= 1, overview.error?.message ?? JSON.stringify(overview.data));
  await admin.client.from("videos").update({ is_featured: true }).eq("id", videoId);
  const pinned = await anon.from("videos").select("is_featured").eq("id", videoId).single();
  check("pinning reaches the app's feed", pinned.data?.is_featured === true);
  const anonPin = await anon.from("videos").update({ is_featured: false }).eq("id", videoId).select();
  check("anon cannot pin", Boolean(anonPin.error) || anonPin.data?.length === 0);
}
console.log("\nCategories");
{
  const anonAdd = await anon.from("categories").insert({ name: `x${stamp}` });
  check("anon cannot add categories", Boolean(anonAdd.error));
  const name = `Temp ${stamp}`;
  const add = await admin.client.from("categories").insert({ name }).select().single();
  check("admin can add a category", !add.error, add.error?.message);
  const hide = await admin.client.from("categories").update({ is_active: false }).eq("id", add.data.id);
  const hidden = await anon.from("categories").select("id").eq("id", add.data.id);
  check("hidden category is not public", !hide.error && hidden.data?.length === 0);
  await admin.client.from("categories").delete().eq("id", add.data.id);
}

console.log("\nDelete");
{
  const inUse = await callFunction("r2-delete", { keys: [media.key] }, admin.token);
  check("a file still in use cannot be removed", inUse.status === 409, `got ${inUse.status} ${JSON.stringify(inUse.body)}`);
  const badKey = await callFunction("r2-delete", { keys: ["../../secret"] }, admin.token);
  check("an invalid key is refused", badKey.status === 400, `got ${badKey.status}`);
  const refused = await callFunction("r2-delete", { id: videoId }, outsider.token);
  check("non-admin cannot delete", refused.status === 403, `got ${refused.status}`);
  const removed = await callFunction("r2-delete", { id: videoId }, admin.token);
  check("admin delete succeeds", removed.status === 200 && removed.body?.deleted === true, JSON.stringify(removed));
  check("its files are removed", removed.body?.filesRemoved === true, JSON.stringify(removed.body));
  const file = await fetch(objectUrl(media.key));
  check("the file is really gone from storage", file.status === 404, `got ${file.status}`);
  const prompts = await service.from("prompts").select("video_id").eq("video_id", videoId);
  check("the prompt went with it", prompts.data?.length === 0);

  const orphan = await upload("thumb", "image/jpeg", new Uint8Array(64).fill(1));
  const cleanup = await callFunction("r2-delete", { keys: [orphan.key] }, admin.token);
  check("an unused upload can be discarded", cleanup.status === 200 && cleanup.body?.filesRemoved === true, JSON.stringify(cleanup));
}

await service.from("admins").delete().eq("user_id", admin.id);
await service.auth.admin.deleteUser(admin.id);
await service.auth.admin.deleteUser(outsider.id);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
