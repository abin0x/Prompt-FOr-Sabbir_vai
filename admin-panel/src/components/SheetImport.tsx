import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Alert } from "./ui";
import type { Api, Category, SourceMatch } from "../lib/api";
import {
  planImport,
  readSheet,
  templateCsv,
  toImportItem,
  type PlanRow,
  type SheetRead,
  type UploadedFile,
} from "../lib/importPlan";
import { prepareFile } from "../lib/media";

type Status = "waiting" | "uploading" | "saving" | "saved" | "failed";

interface Progress {
  status: Status;
  fraction: number;
  message: string;
}

const STATUS_TEXT: Record<Status, string> = {
  waiting: "Waiting",
  uploading: "Uploading the file",
  saving: "Saving",
  saved: "Saved",
  failed: "Failed",
};

/** Problems shown in full before they collapse into a count. */
const SHOWN_PROBLEMS = 8;

function isSheet(file: File): boolean {
  return /\.(csv|tsv|txt)$/i.test(file.name) || file.type === "text/csv";
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "prompt-lab-import.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function describe(plan: PlanRow<File>): string {
  if (plan.kind === "update") {
    const title = plan.match!.title;
    return plan.file ? `Adds the file to the draft "${title}"` : `Updates "${title}"`;
  }
  return plan.file ? `New item with ${plan.file.name}` : "New item, no file yet";
}

/**
 * Imports a CSV sheet of prompts, with or without the files it names. Rows are
 * matched to files and to saved items by file name, so the same sheet can be
 * imported again to update instead of making copies.
 */
export function SheetImport({
  api,
  categories,
  onClose,
  onFinished,
}: {
  api: Api;
  categories: Category[];
  onClose: () => void;
  onFinished: (message: string) => Promise<void>;
}) {
  const [sheetName, setSheetName] = useState("");
  const [sheet, setSheet] = useState<SheetRead | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [matches, setMatches] = useState<SourceMatch[]>([]);
  const [matching, setMatching] = useState(false);
  const [knownCategories, setKnownCategories] = useState(categories);
  const [publish, setPublish] = useState(false);
  const [createCategories, setCreateCategories] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  const [error, setError] = useState("");
  const sheetInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  // The Library may still be loading its list, so read a fresh one here.
  useEffect(() => {
    let cancelled = false;
    api
      .listCategories()
      .then((fresh) => {
        if (!cancelled) setKnownCategories(fresh);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const fileNames = useMemo(
    () => (sheet?.rows ?? []).map((row) => row.fileName).filter(Boolean),
    [sheet],
  );

  // What is already saved under these names decides update or new.
  useEffect(() => {
    if (fileNames.length === 0) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setMatching(true);
    api
      .matchSourceNames(fileNames)
      .then((found) => {
        if (!cancelled) setMatches(found);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Could not check saved items: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setMatching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, fileNames]);

  const plan = useMemo(
    () => planImport(sheet?.rows ?? [], files, matches, knownCategories, { publish }),
    [sheet, files, matches, knownCategories, publish],
  );
  const ready = plan.rows.filter((row) => row.error == null);

  const addFiles = async (chosen: File[]) => {
    setError("");
    setSummary("");
    const sheets = chosen.filter(isSheet);
    const media = chosen.filter((file) => !isSheet(file));
    if (sheets.length > 1) setError("Drop one sheet at a time.");
    if (sheets[0]) {
      const text = await sheets[0].text();
      setSheetName(sheets[0].name);
      setSheet(readSheet(text));
      setUnreadable(text.includes("�"));
      setProgress(new Map());
    }
    if (media.length > 0) {
      setFiles((current) => {
        const names = new Set(media.map((file) => file.name.toLowerCase()));
        return [...current.filter((file) => !names.has(file.name.toLowerCase())), ...media];
      });
    }
  };

  const setRow = (rowNumber: number, change: Partial<Progress>) =>
    setProgress((current) => {
      const next = new Map(current);
      const before = next.get(rowNumber) ?? { status: "waiting", fraction: 0, message: "" };
      next.set(rowNumber, { ...before, ...change });
      return next;
    });

  const upload = async (row: PlanRow<File>): Promise<UploadedFile> => {
    const prepared = await prepareFile(row.file!, row.contentType);
    const fileWeight = 0.9;
    const mediaPath = await api.uploadFile(
      prepared.file,
      row.contentType,
      prepared.file.type,
      (f) => setRow(row.row.rowNumber, { fraction: f * fileWeight }),
    );
    try {
      const thumbPath = await api.uploadFile(prepared.thumb, "thumb", "image/jpeg", (f) =>
        setRow(row.row.rowNumber, { fraction: fileWeight + f * (1 - fileWeight) }),
      );
      return {
        mediaPath,
        thumbPath,
        durationSec: prepared.durationSec,
        mediaBytes: prepared.file.size,
      };
    } catch (err) {
      await api.discardUploads([mediaPath]).catch(() => undefined);
      throw err;
    }
  };

  const start = async () => {
    setRunning(true);
    setError("");
    setSummary("");
    let rows = ready;
    try {
      if (createCategories && plan.missingCategories.length > 0) {
        for (const name of plan.missingCategories) {
          // Another admin may have just made it; the fresh list below finds it.
          await api.saveCategory({ name: name.slice(0, 40) }).catch((err: Error) => {
            if (!err.message.includes("already exists")) throw err;
          });
        }
        const fresh = await api.listCategories();
        setKnownCategories(fresh);
        rows = planImport(sheet?.rows ?? [], files, matches, fresh, { publish }).rows.filter(
          (row) => row.error == null,
        );
      }
    } catch (err) {
      setError(`Could not create the categories: ${(err as Error).message}`);
      setRunning(false);
      return;
    }

    setProgress(new Map(rows.map((row) => [row.row.rowNumber, { status: "waiting", fraction: 0, message: "" }])));

    // Files one at a time: a home connection handles this better than many at once.
    const uploads = new Map<number, UploadedFile>();
    const toSave: PlanRow<File>[] = [];
    for (const row of rows) {
      if (!row.file) {
        toSave.push(row);
        continue;
      }
      setRow(row.row.rowNumber, { status: "uploading", fraction: 0 });
      try {
        uploads.set(row.row.rowNumber, await upload(row));
        toSave.push(row);
      } catch (err) {
        setRow(row.row.rowNumber, { status: "failed", message: (err as Error).message });
      }
    }

    for (const row of toSave) setRow(row.row.rowNumber, { status: "saving" });
    let results: Awaited<ReturnType<Api["importItems"]>> = [];
    try {
      results = await api.importItems(
        toSave.map((row) => toImportItem(row, uploads.get(row.row.rowNumber) ?? null)),
      );
    } catch (err) {
      results = toSave.map(() => ({ error: (err as Error).message }));
    }

    let created = 0;
    let updated = 0;
    let failed = rows.length - toSave.length;
    const orphans: string[] = [];
    toSave.forEach((row, index) => {
      const result = results[index] ?? { error: "Not saved." };
      if (result.error != null) {
        failed++;
        setRow(row.row.rowNumber, { status: "failed", message: result.error });
        const file = uploads.get(row.row.rowNumber);
        if (file) orphans.push(file.mediaPath, file.thumbPath);
      } else {
        if (row.kind === "new") created++;
        else updated++;
        setRow(row.row.rowNumber, { status: "saved", fraction: 1 });
      }
    });
    // Files whose row failed are not used by anything.
    for (let i = 0; i < orphans.length; i += 10) {
      await api.discardUploads(orphans.slice(i, i + 10)).catch(() => undefined);
    }

    const parts = [
      created && `${created} added`,
      updated && `${updated} updated`,
      failed && `${failed} failed`,
    ].filter(Boolean);
    const text = parts.length ? `${parts.join(", ")}.` : "Nothing was saved.";
    setSummary(text);
    setRunning(false);
    if (created + updated > 0) await onFinished(text);
  };

  const done = summary !== "";
  const problems = sheet?.problems ?? [];

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Import a sheet">
        <div className="drawer-head">
          <h2>Import a sheet</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={running}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">
          <p className="muted small">
            One row per item, with the columns <strong>file_name</strong>,{" "}
            <strong>title</strong>, <strong>prompt</strong>, <strong>category</strong> and{" "}
            <strong>tags</strong>. Drop the files too, and each is joined to the row with
            its name. Rows with no file are saved as hidden drafts: upload the files
            later with Bulk upload and they join their rows by name.
          </p>
          <p className="muted small">
            In Excel choose Save As, then CSV UTF-8. In Google Sheets choose File,
            Download, CSV. Importing the same sheet again updates the items instead of
            copying them.
          </p>
          <button type="button" className="text-link" onClick={downloadTemplate}>
            Download a sample sheet
          </button>

          <div
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!running) void addFiles([...e.dataTransfer.files]);
            }}
          >
            <div>
              <p>
                {sheet
                  ? `${sheetName}: ${sheet.rows.length} ${sheet.rows.length === 1 ? "row" : "rows"}${files.length ? `, ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}`
                  : "Drop the sheet (CSV) and its videos and images here."}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button small"
                  onClick={() => sheetInput.current?.click()}
                  disabled={running}
                >
                  {sheet ? "Choose another sheet" : "Choose the sheet"}
                </button>
                <button
                  type="button"
                  className="button small"
                  onClick={() => filesInput.current?.click()}
                  disabled={running}
                >
                  Add files
                </button>
              </div>
            </div>
            <input
              ref={sheetInput}
              type="file"
              hidden
              aria-label="Sheet"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(e) => {
                const chosen = [...(e.target.files ?? [])];
                e.target.value = "";
                void addFiles(chosen);
              }}
            />
            <input
              ref={filesInput}
              type="file"
              hidden
              multiple
              aria-label="Files"
              accept="video/mp4,image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const chosen = [...(e.target.files ?? [])];
                e.target.value = "";
                void addFiles(chosen);
              }}
            />
          </div>

          {unreadable && (
            <Alert kind="warn">
              Some letters in this sheet could not be read. In Excel, save it as CSV
              UTF-8 and choose it again.
            </Alert>
          )}

          {problems.length > 0 && (
            <Alert kind="warn">
              {problems.length === 1 ? "1 row is skipped:" : `${problems.length} rows are skipped:`}
              <ul className="plain-list">
                {problems.slice(0, SHOWN_PROBLEMS).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
                {problems.length > SHOWN_PROBLEMS && (
                  <li>and {problems.length - SHOWN_PROBLEMS} more.</li>
                )}
              </ul>
            </Alert>
          )}

          {plan.unusedFiles.length > 0 && (
            <Alert kind="info">
              {plan.unusedFiles.length === 1
                ? "1 file is not named in the sheet and will be skipped: "
                : `${plan.unusedFiles.length} files are not named in the sheet and will be skipped: `}
              {plan.unusedFiles
                .slice(0, SHOWN_PROBLEMS)
                .map((file) => file.name)
                .join(", ")}
              {plan.unusedFiles.length > SHOWN_PROBLEMS ? ", ..." : ""}
            </Alert>
          )}

          {plan.missingCategories.length > 0 && (
            <label className="check">
              <input
                type="checkbox"
                checked={createCategories}
                onChange={(e) => setCreateCategories(e.target.checked)}
                disabled={running || done}
              />
              <span>
                Create the missing{" "}
                {plan.missingCategories.length === 1 ? "category" : "categories"}:{" "}
                {plan.missingCategories.join(", ")}. They show in the app as soon as a
                live item uses them.
              </span>
            </label>
          )}

          {plan.rows.length > 0 && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(e) => setPublish(e.target.checked)}
                  disabled={running || done}
                />
                <span>
                  Publish rows that will have both a file and a prompt. Others stay
                  hidden.
                </span>
              </label>

              <ul className="bulk-list">
                {plan.rows.map((row) => {
                  const state = progress.get(row.row.rowNumber);
                  return (
                    <li key={row.row.rowNumber}>
                      <Icon name={row.contentType} size={15} />
                      <div className="bulk-file">
                        <strong>
                          {row.row.title}
                          {row.publish && <span className="badge ok">Goes live</span>}
                        </strong>
                        <span className="muted small">
                          Row {row.row.rowNumber} · {describe(row)}
                        </span>
                        {row.row.prompt && (
                          <span className="muted small one-line">{row.row.prompt}</span>
                        )}
                        {row.error ? (
                          <span className="field-error">{row.error} Skipped.</span>
                        ) : (
                          row.notes
                            // Ticking "Create the missing categories" answers this note.
                            .filter((note) => !(createCategories && note.startsWith("There is no category")))
                            .map((note) => (
                            <span key={note} className="small warn-text">
                              {note}
                            </span>
                          ))
                        )}
                        {state && state.status !== "waiting" && (
                          <span
                            className={state.status === "failed" ? "field-error" : "muted small"}
                          >
                            {state.message || STATUS_TEXT[state.status]}
                          </span>
                        )}
                        {state?.status === "uploading" && (
                          <div className="meter wide">
                            <div style={{ width: `${state.fraction * 100}%` }} />
                          </div>
                        )}
                      </div>
                      {state?.status === "saved" && <Icon name="check" size={15} />}
                    </li>
                  );
                })}
              </ul>

              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={running || done}
                />
                <span>
                  I have the rights to these files and prompts, and they have no sexual
                  content, violence or hate.
                </span>
              </label>
            </>
          )}

          {error && <Alert kind="error">{error}</Alert>}
          {done && !running && <Alert kind="info">{summary}</Alert>}
        </div>

        <div className="drawer-foot">
          {done ? (
            <button type="button" className="button primary wide" onClick={onClose}>
              Close
            </button>
          ) : (
            <button
              type="button"
              className="button primary wide"
              disabled={running || matching || ready.length === 0 || !confirmed}
              onClick={() => void start()}
            >
              {running
                ? "Importing..."
                : matching
                  ? "Checking saved items..."
                  : `Import ${ready.length} ${ready.length === 1 ? "row" : "rows"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
