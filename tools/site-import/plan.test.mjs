import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderItems,
  photoCategory,
  photoTags,
  planItems,
  titleFromPrompt,
  videoCategory,
} from "./plan.mjs";
import { findContentBox, mp4Duration, sniff, uuidFor } from "./media.mjs";

test("a photo's category is its most specific tag", () => {
  assert.equal(photoCategory("New,Trending,Featured,PAK"), "Viral");
  assert.equal(photoCategory("Featured,Others"), "Others");
  assert.equal(photoCategory("New,Portrait,Trending,Cinematic,Featured,PAK"), "Portrait");
  assert.equal(photoCategory("Others,Video"), "Image to Video");
  assert.equal(photoCategory("IND"), "India");
  assert.equal(photoCategory(""), "Others");
});

test("tags are tidied and leave out the category and Video", () => {
  assert.deepEqual(photoTags("New, Trending,Featured,PAK", "Viral"), ["New", "Featured", "Pakistan"]);
  assert.deepEqual(photoTags("Others,Video", "Image to Video"), ["Others"]);
});

test("the app's own Trending chip is not reused as a category", () => {
  assert.equal(videoCategory("Trending"), "Viral");
  assert.equal(videoCategory(""), "Others");
  assert.equal(videoCategory("Anime/3D"), "Anime/3D");
});

test("titles come from the subject, not the instructions", () => {
  assert.equal(
    titleFromPrompt("A cinematic nighttime café portrait of a handsome, well-groomed man with a watch."),
    "Nighttime Café Portrait of a Handsome Well-groomed Man",
  );
  assert.equal(
    titleFromPrompt("Use the uploaded photo as the exact face reference. A young woman dancing in the rain, soft light."),
    "Young Woman Dancing in the Rain",
  );
  assert.equal(titleFromPrompt("CASH FLEX TREND – GOOGLE FLOW PROMPT (Upload: @video1)"), "Cash Flex Trend");
  assert.equal(titleFromPrompt("Keep my face exactly the same.", "Boys Prompt"), "Boys Prompt");
  for (const prompt of ["CREATE A 4:5 CINEMATIC PORTRAIT USING THE PHOTO", "0.0–2.5 s: zoom"]) {
    const title = titleFromPrompt(prompt, "Fallback");
    assert.ok(title.length <= 60 && !/^Create a 4$/.test(title), title);
  }
});

test("every category gets a turn near the top", () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => ({ key: `a${i}`, siteId: i, contentType: "image", category: "A" })),
    { key: "b0", siteId: 1, contentType: "image", category: "B" },
    { key: "v0", siteId: 1, contentType: "video", category: "A" },
  ];
  const ordered = orderItems(items);
  assert.deepEqual(ordered.slice(0, 3).map((i) => i.key).sort(), ["a4", "b0", "v0"]);
  const dates = ordered.map((i) => Date.parse(i.createdAt));
  assert.ok(dates.every((d, i) => i === 0 || d < dates[i - 1]), "newest first");
});

test("copies, command-only prompts and empty prompts are left out", () => {
  const photo = { id: 1, prompt: "A portrait of a young man in a field", imageUrl: "https://x/a.jpg", tags: "Boys" };
  const { items, skipped } = planItems(
    [photo, { ...photo, id: 2 }, { ...photo, id: 3, prompt: " " }],
    [{ id: 9, video: "https://x/v.mp4", image: "https://x/v.jpg", title: "", video_prompt: "/UGC ad", category: "Others" }],
  );
  assert.equal(items.length, 1);
  assert.deepEqual(skipped.map((s) => s.key).sort(), ["photo-2", "photo-3", "video-9"]);
});

test("file helpers", () => {
  assert.equal(sniff(Buffer.from("ffd8ffe000104a4649460001", "hex")), "jpg");
  assert.equal(sniff(Buffer.from("00000018667479706d703432", "hex")), "mp4");
  assert.match(`images/${uuidFor("x")}.jpg`, /^(videos|images|thumbs)\/[0-9a-f-]{36}\.[a-z0-9]+$/);
  assert.equal(uuidFor("same"), uuidFor("same"));

  // A 10x10 picture with a 2px white frame.
  const pixels = new Uint8Array(10 * 10 * 4).fill(255);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) pixels.set([10, 20, 30, 255], (y * 10 + x) * 4);
  assert.deepEqual(findContentBox(pixels, 10, 10), { left: 2, top: 2, right: 8, bottom: 8 });

  // ftyp + moov(mvhd version 0, timescale 1000, duration 12400).
  const mvhd = Buffer.alloc(8 + 100);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write("mvhd", 4, "latin1");
  mvhd.writeUInt32BE(1000, 8 + 12);
  mvhd.writeUInt32BE(12400, 8 + 16);
  const moov = Buffer.concat([Buffer.alloc(8), mvhd]);
  moov.writeUInt32BE(moov.length, 0);
  moov.write("moov", 4, "latin1");
  const ftyp = Buffer.from("00000010667479706d70343200000000", "hex");
  assert.equal(mp4Duration(Buffer.concat([ftyp, moov])), 12);
});
