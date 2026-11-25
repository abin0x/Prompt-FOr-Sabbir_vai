import { describe, expect, it } from "vitest";
import type { Category, SourceMatch } from "./api";
import { planSiteImport, readSiteFile, siteImportItems } from "./siteImport";

const id = "6e538035-a375-5ad0-9528-a68aa08ee534";

function fileWith(items: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: "prompt-lab-site-import", version: 1, batch: "Website prompts", items, ...extra });
}

const photo = {
  source_name: "site-photo-1",
  title: "Portrait of a Young Man",
  content_type: "image",
  category: "Boys",
  tags: ["New", "Featured"],
  prompt: "A portrait of a young man.",
  media_path: `images/${id}.jpg`,
  thumb_path: `thumbs/${id}.jpg`,
  duration_sec: null,
  media_bytes: 1200,
  created_at: "2026-09-30T23:59:59.000Z",
};
const video = {
  ...photo,
  source_name: "site-video-9",
  title: "Motorcycle Assembly",
  content_type: "video",
  category: "Miniature",
  tags: [],
  media_path: `videos/${id}.mp4`,
  duration_sec: 10,
};
const noFile = { ...photo, source_name: "site-photo-2", media_path: null, thumb_path: null, media_bytes: null };

const categories: Category[] = [{ id: "c1", name: "Boys", sort_order: 10, is_active: true }];

describe("readSiteFile", () => {
  it("reads good rows and explains the bad ones", () => {
    const file = readSiteFile(
      fileWith([
        photo,
        video,
        noFile,
        { ...photo, source_name: "site-photo-1" },
        { ...photo, source_name: "site-photo-3", prompt: " " },
        { ...photo, source_name: "site-photo-4", media_path: "https://old.site/a.jpg" },
        { ...video, source_name: "site-video-5", media_path: `images/${id}.jpg` },
      ]),
    );
    expect(file.batch).toBe("Website prompts");
    expect(file.items.map((i) => i.source_name)).toEqual(["site-photo-1", "site-video-9", "site-photo-2"]);
    expect(file.problems).toHaveLength(4);
    expect(file.problems[0]).toContain("appears twice");
  });

  it("refuses files that are not website imports", () => {
    expect(() => readSiteFile("{")).toThrow("not valid JSON");
    expect(() => readSiteFile(JSON.stringify({ items: [] }))).toThrow("not a website import");
  });
});

describe("planSiteImport", () => {
  it("counts new, updated, with and without a file, and missing categories", () => {
    const file = readSiteFile(fileWith([photo, video, noFile]));
    const matches: SourceMatch[] = [
      { source_name: "SITE-PHOTO-1", id: "v1", title: "Old", has_media: true, has_prompt: true, is_published: true },
    ];
    expect(planSiteImport(file, matches, categories)).toEqual({
      newCount: 2,
      updateCount: 1,
      withFile: 2,
      withoutFile: 1,
      videos: 1,
      images: 2,
      missingCategories: ["Miniature"],
    });
  });
});

describe("siteImportItems", () => {
  it("creates new rows in the set, with their place in the order", () => {
    const file = readSiteFile(fileWith([video, noFile]));
    const [first, second] = siteImportItems(file, [], [...categories, { id: "c2", name: "Miniature", sort_order: 20, is_active: true }]);
    expect(first).toMatchObject({
      title: "Motorcycle Assembly",
      contentType: "video",
      categoryId: "c2",
      mediaPath: `videos/${id}.mp4`,
      durationSec: 10,
      importBatch: "Website prompts",
      createdAt: "2026-09-30T23:59:59.000Z",
      sourceName: "site-video-9",
    });
    expect(first.publish).toBeUndefined();
    // No file: the draft is saved without one and keeps none of the file fields.
    expect(second).not.toHaveProperty("mediaPath");
    expect(second).not.toHaveProperty("thumbPath");
  });

  it("updates an item imported before without touching its date, file or live state", () => {
    const file = readSiteFile(fileWith([noFile]));
    const matches: SourceMatch[] = [
      { source_name: "site-photo-2", id: "v2", title: "Old", has_media: true, has_prompt: true, is_published: true },
    ];
    const [row] = siteImportItems(file, matches, categories);
    expect(row.id).toBe("v2");
    expect(row).not.toHaveProperty("createdAt");
    expect(row).not.toHaveProperty("mediaPath");
    expect(row.publish).toBeUndefined();
    expect(row.importBatch).toBe("Website prompts");
  });
});
