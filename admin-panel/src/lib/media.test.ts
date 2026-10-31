import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  findContentBox,
  isFaststart,
  itemStatus,
  MB,
  parseTags,
  titleFromFileName,
  validateFile,
} from "./media";

function box(name: string, size: number): number[] {
  const bytes = new Array<number>(size).fill(0);
  bytes[0] = (size >>> 24) & 255;
  bytes[1] = (size >>> 16) & 255;
  bytes[2] = (size >>> 8) & 255;
  bytes[3] = size & 255;
  for (let i = 0; i < 4; i++) bytes[4 + i] = name.charCodeAt(i);
  return bytes;
}

describe("isFaststart", () => {
  it("is true when moov comes before mdat", () => {
    const file = [...box("ftyp", 32), ...box("moov", 64), ...box("mdat", 16)];
    expect(isFaststart(new Uint8Array(file))).toBe(true);
  });

  it("is false when mdat comes first", () => {
    const file = [...box("ftyp", 32), ...box("mdat", 64), ...box("moov", 16)];
    expect(isFaststart(new Uint8Array(file))).toBe(false);
  });

  it("is null for files it cannot read", () => {
    expect(isFaststart(new Uint8Array(4))).toBeNull();
    expect(isFaststart(new Uint8Array(32))).toBeNull();
  });

  it("works on a slice of a larger buffer", () => {
    const whole = new Uint8Array([9, 9, 9, ...box("moov", 16)]);
    expect(isFaststart(whole.subarray(3))).toBe(true);
  });
});

describe("validateFile", () => {
  it("accepts good files", () => {
    expect(validateFile({ type: "video/mp4", size: MB }, "video")).toBeNull();
    expect(validateFile({ type: "image/webp", size: MB }, "image")).toBeNull();
  });

  it("rejects wrong types and sizes", () => {
    expect(validateFile({ type: "video/webm", size: MB }, "video")).toMatch(/MP4/);
    expect(validateFile({ type: "video/mp4", size: 101 * MB }, "video")).toMatch(/100/);
    expect(validateFile({ type: "image/gif", size: MB }, "image")).toMatch(/JPG/);
    expect(validateFile({ type: "image/png", size: 16 * MB }, "image")).toMatch(/15/);
  });
});

describe("formatting", () => {
  it("formats numbers", () => {
    expect(formatBytes(2 * MB)).toBe("2.0 MB");
    expect(formatBytes(500)).toBe("1 KB");
    expect(formatDuration(75)).toBe("01:15");
    expect(formatDuration(null)).toBe("");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(9800)).toBe("9.8K");
    expect(formatCount(2000)).toBe("2K");
    expect(formatCount(125000)).toBe("125K");
  });

  it("cleans tags", () => {
    expect(parseTags(" Portrait, neon ,, portrait,")).toEqual(["Portrait", "neon"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("findContentBox", () => {
  /** A picture with a dark square inside a margin of the given pixel. */
  const picture = (size: number, margin: number, edge: number[]) => {
    const pixels: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside =
          x >= margin && x < size - margin && y >= margin && y < size - margin;
        pixels.push(...(inside ? [10, 10, 40, 255] : edge));
      }
    }
    return pixels;
  };

  it("finds the picture inside white margins", () => {
    expect(findContentBox(picture(20, 2, [255, 255, 255, 255]), 20, 20)).toEqual({
      left: 2,
      top: 2,
      right: 18,
      bottom: 18,
    });
  });

  it("treats transparent margins the same way", () => {
    expect(findContentBox(picture(20, 3, [0, 0, 0, 0]), 20, 20)).toEqual({
      left: 3,
      top: 3,
      right: 17,
      bottom: 17,
    });
  });

  it("leaves a picture with no margins alone", () => {
    expect(findContentBox(picture(20, 0, [255, 255, 255, 255]), 20, 20)).toBeNull();
  });

  it("does not cut dark margins, which can be part of the picture", () => {
    expect(findContentBox(picture(20, 2, [10, 10, 40, 255]), 20, 20)).toBeNull();
  });

  it("leaves mostly white pictures alone", () => {
    expect(findContentBox(picture(20, 6, [255, 255, 255, 255]), 20, 20)).toBeNull();
  });
});

describe("itemStatus", () => {
  const now = Date.UTC(2026, 9, 31);
  const later = new Date(now + 60000).toISOString();
  const earlier = new Date(now - 60000).toISOString();

  it("waits for a scheduled time", () => {
    expect(itemStatus({ is_published: true, publish_at: later }, now)).toBe("scheduled");
    expect(itemStatus({ is_published: true, publish_at: earlier }, now)).toBe("live");
    expect(itemStatus({ is_published: true, publish_at: null }, now)).toBe("live");
  });

  it("is hidden whatever the schedule says", () => {
    expect(itemStatus({ is_published: false, publish_at: later }, now)).toBe("hidden");
  });
});

describe("titleFromFileName", () => {
  it("makes a readable title", () => {
    expect(titleFromFileName("my_clip-01.final.mp4")).toBe("my clip 01.final");
  });
});
