import { describe, expect, it } from "vitest";
import type { Category, SourceMatch } from "./api";
import { planImport, readSheet, templateCsv, toImportItem } from "./importPlan";
import { parseCsv, toCsv } from "./sheet";

describe("parseCsv", () => {
  it("reads quotes, separators and line breaks inside cells", () => {
    const text = 'a,b,c\r\n"x, y","say ""hi""","line one\nline two"\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line one\nline two"],
    ]);
  });

  it("drops Excel's BOM and blank rows, and keeps a last row with no newline", () => {
    expect(parseCsv("﻿a,b\n\n,\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("uses semicolons or tabs when the sheet does", () => {
    expect(parseCsv("a;b\n1,5;2")).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("round-trips what toCsv writes", () => {
    const rows = [
      ["file_name", "prompt"],
      ["a.jpg", 'He said "go", then left\nfast'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("readSheet", () => {
  it("maps common header names and fills the title from the file name", () => {
    const { rows, problems } = readSheet(
      "File Name,Prompt Text,Category,Tags,Type\nmy_clip-01.mp4,Do this,Dance,\"A; b | A\",video\n",
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        rowNumber: 2,
        fileName: "my_clip-01.mp4",
        title: "my clip 01",
        titleGiven: false,
        prompt: "Do this",
        category: "Dance",
        tags: ["A", "b"],
        type: "video",
      },
    ]);
  });

  it("skips rows that cannot be used and says why", () => {
    const { rows, problems } = readSheet(
      [
        "file_name,title,prompt,type",
        ",,only a prompt,",
        "a.jpg,,p,",
        "A.JPG,,again,",
        `b.jpg,${"x".repeat(121)},p,`,
        "c.jpg,,p,gif",
      ].join("\n"),
    );
    expect(rows.map((row) => row.fileName)).toEqual(["a.jpg"]);
    expect(problems).toEqual([
      "Row 2: needs a title or a file name.",
      "Row 4: A.JPG is already used on row 3.",
      "Row 5: the title is longer than 120 characters.",
      'Row 6: type must be "image" or "video", not "gif".',
    ]);
  });

  it("refuses a sheet with no known columns", () => {
    expect(readSheet("foo,bar\n1,2").problems[0]).toMatch(/first row must name/);
    expect(readSheet("").problems).toEqual(["The sheet is empty."]);
    expect(readSheet("title,prompt\n").problems).toEqual([
      "The sheet has no rows under the header.",
    ]);
  });

  it("reads the downloadable template", () => {
    const { rows, problems } = readSheet(templateCsv());
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(3);
  });
});

const categories: Category[] = [
  { id: "c1", name: "Dance", sort_order: 1, is_active: true },
];
const file = (name: string, type: string, size = 1000) => ({ name, type, size });
const match = (name: string, extra: Partial<SourceMatch> = {}): SourceMatch => ({
  source_name: name,
  id: `id-${name}`,
  title: `Saved ${name}`,
  has_media: false,
  has_prompt: false,
  is_published: false,
  ...extra,
});

describe("planImport", () => {
  const sheet = readSheet(
    [
      "file_name,title,prompt,category",
      "new.jpg,New,p1,dance",
      "draft.mp4,,p2,Unknown",
      "done.jpg,,p3,",
      ",Text only,p4,",
      "missing.jpg,,,",
    ].join("\n"),
  ).rows;

  it("decides each row from the files and what is saved", () => {
    const plan = planImport(
      sheet,
      [
        file("NEW.JPG", "image/jpeg"),
        file("draft.mp4", "video/mp4"),
        file("done.jpg", "image/jpeg"),
        file("extra.png", "image/png"),
      ],
      [
        match("draft.mp4", { has_prompt: true }),
        match("done.jpg", { has_media: true, has_prompt: true, is_published: true }),
      ],
      categories,
      { publish: false },
    );
    const [newRow, draft, done, text, missing] = plan.rows;

    expect(newRow).toMatchObject({ kind: "new", contentType: "image", categoryId: "c1" });
    expect(newRow.file?.name).toBe("NEW.JPG");

    expect(draft).toMatchObject({ kind: "update", contentType: "video", categoryId: null });
    expect(draft.file?.name).toBe("draft.mp4");
    expect(draft.notes).toContain('There is no category "Unknown", so it is left empty.');

    expect(done.kind).toBe("update");
    expect(done.file).toBeNull();
    expect(done.notes[0]).toMatch(/already has a file/);

    expect(text).toMatchObject({ kind: "new", file: null, contentType: "image" });
    expect(missing.notes[0]).toMatch(/saved without a file/);

    expect(plan.unusedFiles.map((f) => f.name)).toEqual(["extra.png"]);
    expect(plan.missingCategories).toEqual(["Unknown"]);
    expect(plan.rows.every((row) => !row.publish && row.error == null)).toBe(true);
  });

  it("publishes only rows that will have a file and a prompt", () => {
    const plan = planImport(
      sheet,
      [file("new.jpg", "image/jpeg"), file("draft.mp4", "video/mp4")],
      [match("draft.mp4"), match("missing.jpg", { has_media: true })],
      categories,
      { publish: true },
    );
    expect(plan.rows.map((row) => row.publish)).toEqual([true, true, false, false, false]);
    expect(plan.rows[3].notes).toContain("Stays hidden until it has a file.");
    expect(plan.rows[4].notes).toContain("Stays hidden until it has a prompt.");
  });

  it("refuses a file that does not fit the row", () => {
    const rows = readSheet("file_name,type\nbig.mp4,\nwrong.jpg,video").rows;
    const plan = planImport(
      rows,
      [file("big.mp4", "video/mp4", 200 * 1024 * 1024), file("wrong.jpg", "image/jpeg")],
      [],
      categories,
      { publish: false },
    );
    expect(plan.rows[0].error).toBe("Video must be under 100 MB.");
    expect(plan.rows[1].error).toBe("Video must be an MP4 file.");
  });
});

describe("toImportItem", () => {
  const uploaded = {
    mediaPath: "images/a.jpg",
    thumbPath: "thumbs/a.jpg",
    durationSec: null,
    mediaBytes: 10,
  };

  it("creates a new item with everything from the row", () => {
    const [row] = readSheet("file_name,title,prompt,category,tags\na.jpg,A,p,Dance,x").rows;
    const [plan] = planImport([row], [file("a.jpg", "image/jpeg")], [], categories, {
      publish: true,
    }).rows;
    expect(toImportItem(plan, uploaded)).toEqual({
      title: "A",
      contentType: "image",
      categoryId: "c1",
      tags: ["x"],
      prompt: "p",
      sourceName: "a.jpg",
      publish: true,
      ...uploaded,
    });
  });

  it("changes only what the sheet gives when updating", () => {
    const [row] = readSheet("file_name,title,prompt\na.jpg,,new prompt").rows;
    const [plan] = planImport([row], [], [match("a.jpg", { has_media: true })], categories, {
      publish: false,
    }).rows;
    const item = toImportItem(plan, null);
    expect(JSON.parse(JSON.stringify(item))).toEqual({ id: "id-a.jpg", prompt: "new prompt" });
  });
});
