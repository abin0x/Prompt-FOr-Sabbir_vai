import type { Category, ImportItem, SourceMatch } from "./api";
import type { ContentType } from "./media";

/**
 * The file tools/site-import/copy-media.mjs writes: prompts from an old website
 * whose images and videos are already copied into R2.
 */
export interface SiteItem {
  source_name: string;
  title: string;
  content_type: ContentType;
  category: string;
  tags: string[];
  prompt: string;
  media_path: string | null;
  thumb_path: string | null;
  duration_sec: number | null;
  media_bytes: number | null;
  created_at: string;
}

export interface SiteFile {
  batch: string;
  items: SiteItem[];
  /** Rows that cannot be imported, with the reason. */
  problems: string[];
}

const KEY = /^(videos|images|thumbs)\/[0-9a-f-]{36}\.[a-z0-9]+$/;
const FOLDER: Record<ContentType, string> = { video: "videos/", image: "images/" };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Reads and checks the file. Throws when it is not a website import at all. */
export function readSiteFile(json: string): SiteFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const file = data as { format?: unknown; batch?: unknown; items?: unknown };
  if (file?.format !== "prompt-lab-site-import" || !Array.isArray(file.items)) {
    throw new Error(
      "This is not a website import file. Choose prompt-lab-site-import.json from tools/site-import/out.",
    );
  }
  const batch = text(file.batch).slice(0, 60) || "Website prompts";
  const items: SiteItem[] = [];
  const problems: string[] = [];
  const names = new Set<string>();

  file.items.forEach((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const label = `Row ${index + 1}`;
    const contentType = row.content_type === "video" ? "video" : row.content_type === "image" ? "image" : null;
    const sourceName = text(row.source_name).slice(0, 255);
    const title = text(row.title).replace(/\s+/g, " ").slice(0, 120);
    const prompt = text(row.prompt);
    const media = text(row.media_path) || null;
    const thumb = text(row.thumb_path) || null;
    const created = text(row.created_at);

    if (!contentType) return problems.push(`${label}: the type must be video or image.`);
    if (!sourceName) return problems.push(`${label}: it has no source name.`);
    if (names.has(sourceName.toLowerCase())) {
      return problems.push(`${label}: ${sourceName} appears twice.`);
    }
    if (!title) return problems.push(`${label}: it has no title.`);
    if (!prompt) return problems.push(`${label}: it has no prompt.`);
    if (media && (!KEY.test(media) || !media.startsWith(FOLDER[contentType]))) {
      return problems.push(`${label}: the file path ${media} is not one of ours.`);
    }
    if (thumb && (!KEY.test(thumb) || !thumb.startsWith("thumbs/"))) {
      return problems.push(`${label}: the thumbnail path ${thumb} is not one of ours.`);
    }
    names.add(sourceName.toLowerCase());
    items.push({
      source_name: sourceName,
      title,
      content_type: contentType,
      category: text(row.category).slice(0, 40),
      tags: Array.isArray(row.tags)
        ? row.tags.map(text).filter(Boolean).slice(0, 20)
        : [],
      prompt,
      media_path: media,
      thumb_path: media ? thumb : null,
      duration_sec: count(row.duration_sec),
      media_bytes: count(row.media_bytes),
      created_at: created && !Number.isNaN(Date.parse(created)) ? created : "",
    });
  });
  return { batch, items, problems };
}

export interface SitePlan {
  newCount: number;
  updateCount: number;
  withFile: number;
  withoutFile: number;
  videos: number;
  images: number;
  /** Category names the file uses that do not exist yet, most used first. */
  missingCategories: string[];
}

export function planSiteImport(
  file: SiteFile,
  matches: SourceMatch[],
  categories: Category[],
): SitePlan {
  const matched = new Set(matches.map((m) => m.source_name.toLowerCase()));
  const known = new Set(categories.map((c) => c.name.toLowerCase()));
  const uses = new Map<string, number>();
  for (const item of file.items) {
    if (item.category && !known.has(item.category.toLowerCase())) {
      uses.set(item.category, (uses.get(item.category) ?? 0) + 1);
    }
  }
  const updateCount = file.items.filter((i) => matched.has(i.source_name.toLowerCase())).length;
  const withFile = file.items.filter((i) => i.media_path).length;
  const videos = file.items.filter((i) => i.content_type === "video").length;
  return {
    newCount: file.items.length - updateCount,
    updateCount,
    withFile,
    withoutFile: file.items.length - withFile,
    videos,
    images: file.items.length - videos,
    missingCategories: [...uses.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name),
  };
}

/**
 * Rows for importItems. An item imported before is updated in place: its text
 * and set change, its file only when the new file has one, and whether it is
 * live stays as it was.
 */
export function siteImportItems(
  file: SiteFile,
  matches: SourceMatch[],
  categories: Category[],
): ImportItem[] {
  const byName = new Map<string, SourceMatch>();
  // Matches come newest first; the first one for a name wins.
  for (const match of matches) {
    const key = match.source_name.toLowerCase();
    if (!byName.has(key)) byName.set(key, match);
  }
  const categoryId = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

  return file.items.map((item) => {
    const match = byName.get(item.source_name.toLowerCase());
    const row: ImportItem = {
      title: item.title,
      contentType: item.content_type,
      categoryId: categoryId.get(item.category.toLowerCase()) ?? null,
      tags: item.tags,
      prompt: item.prompt,
      sourceName: item.source_name,
      importBatch: file.batch,
    };
    if (item.media_path) {
      row.mediaPath = item.media_path;
      row.thumbPath = item.thumb_path;
      row.durationSec = item.duration_sec;
      if (item.media_bytes !== null) row.mediaBytes = item.media_bytes;
    }
    if (match) return { ...row, id: match.id };
    return item.created_at ? { ...row, createdAt: item.created_at } : row;
  });
}
