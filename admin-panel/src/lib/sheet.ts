/** Reading and writing the CSV sheets used for bulk import. */

/**
 * The separator a sheet uses, read from its first line. Excel saves CSV with
 * semicolons in many countries, and some tools export tabs.
 */
function detectSeparator(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  return Object.entries(counts).reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  )[0];
}

/**
 * Splits CSV text into rows of cells. Handles quoted cells with separators,
 * quotes and line breaks inside them, Windows line endings and Excel's BOM.
 * Rows of nothing but blank cells are dropped.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const separator = detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === separator) {
      endCell();
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** CSV text that Excel and Google Sheets open as a table. */
export function toCsv(rows: string[][]): string {
  const escape = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((row) => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
