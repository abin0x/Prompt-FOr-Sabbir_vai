import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Alert } from "./ui";
import type { Api, Category } from "../lib/api";
import {
  IMAGE_TYPES,
  prepareFile,
  titleFromFileName,
  validateFile,
  type ContentType,
} from "../lib/media";

type Status = "waiting" | "uploading" | "done" | "failed";

interface Entry {
  file: File;
  type: ContentType;
  status: Status;
  progress: number;
  message: string;
}

const STATUS_TEXT: Record<Status, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  done: "Saved as hidden",
  failed: "Failed",
};

/**
 * Uploads many files in one go. Each becomes a hidden item titled from its file
 * name, ready to get a prompt and be published from the Library.
 */
export function BulkUpload({
  api,
  categories,
  onClose,
  onFinished,
}: {
  api: Api;
  categories: Category[];
  onClose: () => void;
  onFinished: (saved: number) => Promise<void>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const addFiles = (files: File[]) => {
    const added: Entry[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const type: ContentType = IMAGE_TYPES.includes(file.type) ? "image" : "video";
      const problem = validateFile(file, type);
      if (problem) rejected.push(`${file.name}: ${problem}`);
      else added.push({ file, type, status: "waiting", progress: 0, message: "" });
    }
    setEntries((current) => [...current, ...added]);
    setError(rejected.join(" "));
  };

  const update = (index: number, change: Partial<Entry>) =>
    setEntries((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...change } : entry)),
    );

  const uploadOne = async (entry: Entry, index: number) => {
    const uploaded: string[] = [];
    try {
      const prepared = await prepareFile(entry.file, entry.type);
      const fileWeight = 0.9;
      const mediaPath = await api.uploadFile(
        prepared.file,
        entry.type,
        prepared.file.type,
        (f) => update(index, { progress: f * fileWeight }),
      );
      uploaded.push(mediaPath);
      const thumbPath = await api.uploadFile(prepared.thumb, "thumb", "image/jpeg", (f) =>
        update(index, { progress: fileWeight + f * (1 - fileWeight) }),
      );
      uploaded.push(thumbPath);
      await api.saveVideo(null, {
        title: titleFromFileName(entry.file.name) || "Untitled",
        contentType: entry.type,
        categoryId: categoryId || null,
        tags: [],
        mediaPath,
        thumbPath,
        durationSec: prepared.durationSec,
        promptText: "",
        isPublished: false,
        mediaBytes: prepared.file.size,
        publishAt: null,
      });
      update(index, { status: "done", progress: 1 });
      return true;
    } catch (err) {
      await api.discardUploads(uploaded).catch(() => undefined);
      update(index, { status: "failed", message: (err as Error).message });
      return false;
    }
  };

  const start = async () => {
    setRunning(true);
    setError("");
    let saved = 0;
    // One at a time: a home connection handles this better than many at once.
    for (const [index, entry] of entries.entries()) {
      if (entry.status === "done") continue;
      update(index, { status: "uploading", progress: 0, message: "" });
      if (await uploadOne(entry, index)) saved++;
    }
    setRunning(false);
    setFinished(true);
    if (saved > 0) await onFinished(saved);
  };

  const pending = entries.filter((entry) => entry.status !== "done").length;
  const done = entries.length - pending;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Bulk upload">
        <div className="drawer-head">
          <h2>Bulk upload</h2>
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
            Each file is saved as a hidden item titled from its file name. Add the
            prompts later from the Library (filter by "No prompt"), then publish.
          </p>

          <div
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!running) addFiles([...e.dataTransfer.files]);
            }}
          >
            <div>
              <p>Drop videos (MP4) and images (JPG, PNG, WebP) here.</p>
              <button
                type="button"
                className="button small"
                onClick={() => inputRef.current?.click()}
                disabled={running}
              >
                Choose files
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              hidden
              multiple
              aria-label="Files"
              accept="video/mp4,image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                addFiles(files);
              }}
            />
          </div>

          <label className="field">
            <span>Category for all of them</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={running}
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.is_active ? "" : " (hidden)"}
                </option>
              ))}
            </select>
          </label>

          {entries.length > 0 && (
            <ul className="bulk-list">
              {entries.map((entry, index) => (
                <li key={`${entry.file.name}-${index}`}>
                  <Icon name={entry.type} size={15} />
                  <div className="bulk-file">
                    <strong>{entry.file.name}</strong>
                    <span
                      className={
                        entry.status === "failed" ? "field-error" : "muted small"
                      }
                    >
                      {entry.message || STATUS_TEXT[entry.status]}
                    </span>
                    {entry.status === "uploading" && (
                      <div className="meter wide">
                        <div style={{ width: `${entry.progress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {entry.status === "waiting" && !running && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${entry.file.name}`}
                      onClick={() =>
                        setEntries((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <Icon name="close" size={15} />
                    </button>
                  )}
                  {entry.status === "done" && <Icon name="check" size={15} />}
                </li>
              ))}
            </ul>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={running}
            />
            <span>
              I have the rights to these files, and they have no sexual content,
              violence or hate.
            </span>
          </label>

          {error && <Alert kind="error">{error}</Alert>}
          {finished && !running && (
            <Alert kind={pending ? "warn" : "info"}>
              {pending
                ? `${done} saved, ${pending} failed. Start again to retry the failed files.`
                : `All ${done} saved as hidden.`}
            </Alert>
          )}
        </div>

        <div className="drawer-foot">
          <button
            type="button"
            className="button primary wide"
            disabled={running || pending === 0 || !confirmed}
            onClick={() => void start()}
          >
            {running
              ? `Uploading ${done + 1} of ${entries.length}`
              : pending
                ? `Upload ${pending} ${pending === 1 ? "file" : "files"}`
                : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
