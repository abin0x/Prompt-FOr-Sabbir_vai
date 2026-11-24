import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Alert } from "./ui";
import type { Api, Category, SourceMatch } from "../lib/api";
import {
  IMAGE_TYPES,
  prepareFile,
  titleFromFileName,
  validateFile,
  type ContentType,
} from "../lib/media";

type Status = "waiting" | "uploading" | "done" | "failed";
type Outcome = "new" | "draft" | "published";

interface Entry {
  file: File;
  type: ContentType;
  status: Status;
  progress: number;
  message: string;
  /** A draft saved from a sheet under this file name, still waiting for its file. */
  draft: SourceMatch | null;
  /** An item made from a file with this name already has its file. */
  uploadedBefore: boolean;
}

const STATUS_TEXT: Record<Status, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  done: "Saved as hidden",
  failed: "Failed",
};

const DONE_TEXT: Record<Outcome, string> = {
  new: "Saved as hidden",
  draft: "Added to its draft",
  published: "Added to its draft and published",
};

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Uploads many files in one go. A file named in an imported sheet goes into
 * that row's draft; any other file becomes a hidden item titled from its name,
 * ready to get a prompt and be published from the Library.
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
  onFinished: (message: string) => Promise<void>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [publishDrafts, setPublishDrafts] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(0);
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

  const addFiles = async (files: File[]) => {
    const added: Entry[] = [];
    const rejected: string[] = [];
    // Names decide which draft a file goes into, so each may appear once.
    const names = new Set(entries.map((entry) => entry.file.name.toLowerCase()));
    for (const file of files) {
      const type: ContentType = IMAGE_TYPES.includes(file.type) ? "image" : "video";
      const problem = validateFile(file, type);
      const key = file.name.toLowerCase();
      if (problem) rejected.push(`${file.name}: ${problem}`);
      else if (names.has(key)) rejected.push(`${file.name}: already in the list.`);
      else {
        names.add(key);
        added.push({
          file,
          type,
          status: "waiting",
          progress: 0,
          message: "",
          draft: null,
          uploadedBefore: false,
        });
      }
    }
    setEntries((current) => [...current, ...added]);
    setError(rejected.join(" "));
    if (added.length === 0) return;

    setChecking((n) => n + 1);
    try {
      const matches = await api.matchSourceNames(added.map((entry) => entry.file.name));
      // Newest first, so the first match for a name is the one that counts.
      const byName = new Map<string, SourceMatch>();
      for (const match of matches) {
        const key = match.source_name.toLowerCase();
        if (!byName.has(key)) byName.set(key, match);
      }
      const addedFiles = new Set(added.map((entry) => entry.file));
      setEntries((current) =>
        current.map((entry) => {
          if (!addedFiles.has(entry.file)) return entry;
          const match = byName.get(entry.file.name.toLowerCase());
          return {
            ...entry,
            draft: match && !match.has_media ? match : null,
            uploadedBefore: Boolean(match?.has_media),
          };
        }),
      );
    } catch (err) {
      setError(
        `Could not check for drafts waiting for these files, so each will be a new item. ${(err as Error).message}`,
      );
    } finally {
      setChecking((n) => n - 1);
    }
  };

  const update = (index: number, change: Partial<Entry>) =>
    setEntries((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...change } : entry)),
    );

  const uploadOne = async (entry: Entry, index: number): Promise<Outcome | null> => {
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

      let outcome: Outcome = "new";
      if (entry.draft) {
        const publish = publishDrafts && entry.draft.has_prompt;
        const [result] = await api.importItems([
          {
            id: entry.draft.id,
            contentType: entry.type,
            mediaPath,
            thumbPath,
            durationSec: prepared.durationSec,
            mediaBytes: prepared.file.size,
            publish: publish || undefined,
          },
        ]);
        if (!result || result.error != null) throw new Error(result?.error ?? "Not saved.");
        outcome = publish ? "published" : "draft";
      } else {
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
          // Lets a sheet imported later fill in this item's prompt by file name.
          sourceName: entry.file.name,
        });
      }
      update(index, { status: "done", progress: 1, message: DONE_TEXT[outcome] });
      return outcome;
    } catch (err) {
      await api.discardUploads(uploaded).catch(() => undefined);
      update(index, { status: "failed", message: (err as Error).message });
      return null;
    }
  };

  const start = async () => {
    setRunning(true);
    setError("");
    const counts: Record<Outcome, number> = { new: 0, draft: 0, published: 0 };
    // One at a time: a home connection handles this better than many at once.
    for (const [index, entry] of entries.entries()) {
      if (entry.status === "done") continue;
      update(index, { status: "uploading", progress: 0, message: "" });
      const outcome = await uploadOne(entry, index);
      if (outcome) counts[outcome]++;
    }
    setRunning(false);
    setFinished(true);
    const parts = [
      counts.new && `${plural(counts.new, "item", "items")} saved as hidden`,
      counts.draft && `${plural(counts.draft, "file", "files")} added to drafts`,
      counts.published && `${plural(counts.published, "draft", "drafts")} published`,
    ].filter(Boolean);
    if (parts.length > 0) await onFinished(`${parts.join(", ")}.`);
  };

  const pending = entries.filter((entry) => entry.status !== "done").length;
  const done = entries.length - pending;
  const drafts = entries.filter((entry) => entry.draft).length;
  const draftsWithPrompt = entries.filter((entry) => entry.draft?.has_prompt).length;

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
          <p className="muted small">
            Imported a sheet first? A file with the same name as a row goes into that
            row's draft, with its title and prompt.
          </p>

          <div
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!running) void addFiles([...e.dataTransfer.files]);
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
                void addFiles(files);
              }}
            />
          </div>

          <label className="field">
            <span>{drafts > 0 ? "Category for the new items" : "Category for all of them"}</span>
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

          {draftsWithPrompt > 0 && (
            <label className="check">
              <input
                type="checkbox"
                checked={publishDrafts}
                onChange={(e) => setPublishDrafts(e.target.checked)}
                disabled={running}
              />
              <span>
                Publish the {plural(draftsWithPrompt, "draft that already has", "drafts that already have")}{" "}
                a prompt. New items stay hidden.
              </span>
            </label>
          )}

          {entries.length > 0 && (
            <ul className="bulk-list">
              {entries.map((entry, index) => (
                <li key={`${entry.file.name}-${index}`}>
                  <Icon name={entry.type} size={15} />
                  <div className="bulk-file">
                    <strong>{entry.file.name}</strong>
                    {entry.draft && (
                      <span className="muted small">
                        Goes into the draft "{entry.draft.title}"
                        {entry.draft.has_prompt ? "" : ", which has no prompt yet"}
                      </span>
                    )}
                    {entry.uploadedBefore && entry.status === "waiting" && (
                      <span className="small warn-text">
                        A file with this name was uploaded before. This adds another item.
                      </span>
                    )}
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
                : `All ${done} saved.`}
            </Alert>
          )}
        </div>

        <div className="drawer-foot">
          <button
            type="button"
            className="button primary wide"
            disabled={running || checking > 0 || pending === 0 || !confirmed}
            onClick={() => void start()}
          >
            {running
              ? `Uploading ${done + 1} of ${entries.length}`
              : checking > 0
                ? "Checking for drafts..."
                : pending
                  ? `Upload ${plural(pending, "file", "files")}`
                  : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
