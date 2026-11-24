/**
 * Turns an import sheet, the files dropped next to it and what is already saved
 * into one decision per row. Kept apart from the screen so it can be tested.
 */
import type { Category, ImportItem, SourceMatch } from "./api";
import {
  IMAGE_TYPES,
  parseTags,
  titleFromFileName,
  validateFile,
  type ContentType,
} from "./media";
import { parseCsv, toCsv } from "./sheet";

export interface SheetRow {
  /** The row number as the spreadsheet shows it; the header is row 1. */
  rowNumber: number;
  fileName: string;
  title: string;
  /** False when the title was made from the file name. */
  titleGiven: boolean;
  prompt: string;
  category: string;
  tags: string[];
  type: ContentType | null;
}

export interface SheetRead {
  rows: SheetRow[];
  problems: string[];
}

type Column = "fileName" | "title" | "prompt" | "category" | "tags" | "type";

/** Header names people are likely to use, after lowercasing and removing spaces. */
const HEADERS: Record<string, Column> = {
  filename: "fileName",
  file: "fileName",
  image: "fileName",
  video: "fileName",
  media: "fileName",
  imagename: "fileName",
  videoname: "fileName",
  title: "title",
  name: "title",
  prompt: "prompt",
  prompttext: "prompt",
  text: "prompt",
  category: "category",
  categoryname: "category",
  tags: "tags",
  tag: "tags",
  keywords: "tags",
  type: "type",
  contenttype: "type",
  kind: "type",
};

export const TITLE_MAX = 120;

/** Reads the sheet's rows. Rows that cannot be used are left out with a reason. */
export function readSheet(text: string): SheetRead {
  const [header, ...body] = parseCsv(text);
  const problems: string[] = [];
  if (!header) return { rows: [], problems: ["The sheet is empty."] };

  const columns = new Map<Column, number>();
  header.forEach((name, index) => {
    const column = HEADERS[name.toLowerCase().replace(/[\s_-]+/g, "")];
    if (column && !columns.has(column)) columns.set(column, index);
  });
  if (!columns.has("fileName") && !columns.has("title") && !columns.has("prompt")) {
    return {
      rows: [],
      problems: [
        "The first row must name the columns: file_name, title, prompt, category, tags.",
      ],
    };
  }

  const rows: SheetRow[] = [];
  const seenFiles = new Map<string, number>();
  body.forEach((cells, index) => {
    const rowNumber = index + 2;
    const cell = (column: Column) => {
      const at = columns.get(column);
      return at == null ? "" : (cells[at] ?? "").trim();
    };
    const fileName = cell("fileName");
    const typeText = cell("type").toLowerCase();
    const type: ContentType | null =
      typeText === "video" || typeText === "image" ? typeText : null;
    if (typeText && !type) {
      problems.push(`Row ${rowNumber}: type must be "image" or "video", not "${cell("type")}".`);
      return;
    }
    const given = cell("title");
    const title = given || titleFromFileName(fileName);
    if (!title) {
      problems.push(`Row ${rowNumber}: needs a title or a file name.`);
      return;
    }
    if (title.length > TITLE_MAX) {
      problems.push(`Row ${rowNumber}: the title is longer than ${TITLE_MAX} characters.`);
      return;
    }
    if (fileName) {
      const key = fileName.toLowerCase();
      const first = seenFiles.get(key);
      if (first != null) {
        problems.push(`Row ${rowNumber}: ${fileName} is already used on row ${first}.`);
        return;
      }
      seenFiles.set(key, rowNumber);
    }
    rows.push({
      rowNumber,
      fileName,
      title,
      titleGiven: given !== "",
      prompt: cell("prompt"),
      category: cell("category"),
      // A tags cell is itself inside a CSV, so semicolons and bars work too.
      tags: parseTags(cell("tags").replace(/[;|]/g, ",")),
      type,
    });
  });
  if (rows.length === 0 && problems.length === 0) {
    problems.push("The sheet has no rows under the header.");
  }
  return { rows, problems };
}

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

/**
 * - "new": creates an item, with the row's file if it was dropped.
 * - "update": changes an item saved from the same file name. A file is added
 *   only when that item is a draft still waiting for one.
 */
export type PlanKind = "new" | "update";

export interface PlanRow<F extends FileLike = FileLike> {
  row: SheetRow;
  kind: PlanKind;
  /** The file to upload, if any. */
  file: F | null;
  match: SourceMatch | null;
  contentType: ContentType;
  /** Null when the row has no category or it does not exist. */
  categoryId: string | null;
  /** Things worth knowing that do not stop the row. */
  notes: string[];
  /** Why the row will be skipped. */
  error: string | null;
  /** Whether the row will go live. */
  publish: boolean;
}

export interface ImportPlan<F extends FileLike = FileLike> {
  rows: PlanRow<F>[];
  /** Dropped files that no row names. */
  unusedFiles: F[];
  /** Category names in the sheet that do not exist yet. */
  missingCategories: string[];
}

function typeFromName(name: string): ContentType | null {
  if (/\.mp4$/i.test(name)) return "video";
  if (/\.(jpe?g|png|webp)$/i.test(name)) return "image";
  return null;
}

export function typeOfFile(file: FileLike): ContentType {
  return IMAGE_TYPES.includes(file.type) ? "image" : "video";
}

export function planImport<F extends FileLike>(
  rows: SheetRow[],
  files: F[],
  matches: SourceMatch[],
  categories: Category[],
  options: { publish: boolean },
): ImportPlan<F> {
  const filesByName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
  // Newest first, so the first match for a name is the one to update.
  const matchByName = new Map<string, SourceMatch>();
  for (const match of matches) {
    const key = match.source_name.toLowerCase();
    if (!matchByName.has(key)) matchByName.set(key, match);
  }
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const used = new Set<string>();
  const missing = new Map<string, string>();

  const planned = rows.map((row): PlanRow<F> => {
    const key = row.fileName.toLowerCase();
    let file = (key && filesByName.get(key)) || null;
    if (file) used.add(key);
    const match = (key && matchByName.get(key)) || null;
    const notes: string[] = [];
    let error: string | null = null;

    if (file && match?.has_media) {
      notes.push("This item already has a file, so the dropped file is not uploaded.");
      file = null;
    }
    const contentType =
      row.type ??
      (file ? typeOfFile(file) : null) ??
      typeFromName(row.fileName) ??
      "image";
    if (file) error = validateFile(file, contentType);

    let categoryId: string | null = null;
    if (row.category) {
      const category = categoryByName.get(row.category.toLowerCase());
      if (category) categoryId = category.id;
      else {
        missing.set(row.category.toLowerCase(), row.category);
        notes.push(`There is no category "${row.category}", so it is left empty.`);
      }
    }

    const willHaveFile = Boolean(file) || Boolean(match?.has_media);
    const willHavePrompt = row.prompt !== "" || Boolean(match?.has_prompt);
    if (row.fileName && !file && !match) {
      notes.push("No file with this name was dropped, so it is saved without a file.");
    }
    const publish = options.publish && willHaveFile && willHavePrompt;
    if (options.publish && !publish && !match?.is_published) {
      notes.push(
        willHaveFile
          ? "Stays hidden until it has a prompt."
          : "Stays hidden until it has a file.",
      );
    }

    return {
      row,
      kind: match ? "update" : "new",
      file,
      match,
      contentType,
      categoryId,
      notes,
      error,
      publish,
    };
  });

  return {
    rows: planned,
    unusedFiles: files.filter((file) => !used.has(file.name.toLowerCase())),
    missingCategories: [...missing.values()],
  };
}

export interface UploadedFile {
  mediaPath: string;
  thumbPath: string;
  durationSec: number | null;
  mediaBytes: number;
}

/** What to save for a planned row, once its file (if any) is uploaded. */
export function toImportItem(plan: PlanRow, uploaded: UploadedFile | null): ImportItem {
  const { row } = plan;
  const fileFields: Partial<ImportItem> = uploaded
    ? {
        contentType: plan.contentType,
        mediaPath: uploaded.mediaPath,
        thumbPath: uploaded.thumbPath,
        durationSec: uploaded.durationSec,
        mediaBytes: uploaded.mediaBytes,
      }
    : {};

  if (plan.kind === "new") {
    return {
      title: row.title,
      contentType: plan.contentType,
      categoryId: plan.categoryId,
      tags: row.tags,
      prompt: row.prompt || undefined,
      sourceName: row.fileName || undefined,
      publish: plan.publish || undefined,
      ...fileFields,
    };
  }

  // An update changes only what the sheet says, so blank cells keep what is saved.
  return {
    id: plan.match!.id,
    title: row.titleGiven ? row.title : undefined,
    categoryId: plan.categoryId ?? undefined,
    tags: row.tags.length > 0 ? row.tags : undefined,
    prompt: row.prompt || undefined,
    contentType: row.type ?? undefined,
    publish: plan.publish || undefined,
    ...fileFields,
  };
}

/** A starting sheet with the columns filled in, to download from the Dashboard. */
export function templateCsv(): string {
  return toCsv([
    ["file_name", "title", "prompt", "category", "tags"],
    [
      "golden-sunset.jpg",
      "Golden sunset",
      "Cinematic golden hour over the sea, warm light, soft haze, 35mm film look",
      "Cinematic",
      "Sunset, Nature",
    ],
    [
      "dance-moves.mp4",
      "Dance moves",
      "A dancer spinning under neon lights, slow motion, smooth camera orbit",
      "Dance",
      "Neon, Dance",
    ],
    [
      "old-fisherman.jpg",
      "Old fisherman",
      "Portrait of an old fisherman, dramatic side light, detailed skin texture",
      "",
      "Portrait",
    ],
  ]);
}
