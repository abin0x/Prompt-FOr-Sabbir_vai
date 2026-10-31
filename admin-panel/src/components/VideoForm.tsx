import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { ThumbnailPicker } from "./ThumbnailPicker";
import { Alert } from "./ui";
import type { Api, Category, VideoRow } from "../lib/api";
import {
  formatBytes,
  itemStatus,
  parseTags,
  prepareFile,
  titleFromFileName,
  validateFile,
  type ContentType,
  type ItemStatus,
} from "../lib/media";
import { scanContent } from "../lib/policy";

const WHEN: { value: ItemStatus; label: string }[] = [
  { value: "live", label: "Publish now" },
  { value: "scheduled", label: "Schedule" },
  { value: "hidden", label: "Keep hidden" },
];

/** The browser's date field works in local time, with no time zone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface Prepared {
  file: File;
  thumb: Blob;
  thumbUrl: string;
  /** Empty for images. */
  videoUrl: string;
  durationSec: number | null;
  warnings: string[];
}

export function VideoForm({
  api,
  categories,
  row,
  onClose,
  onSaved,
}: {
  api: Api;
  categories: Category[];
  row: VideoRow | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const isEdit = row != null;
  const [contentType, setContentType] = useState<ContentType>(
    row?.content_type ?? "video",
  );
  const [title, setTitle] = useState(row?.title ?? "");
  const [categoryId, setCategoryId] = useState(row?.category_id ?? "");
  const [tags, setTags] = useState(row?.tags.join(", ") ?? "");
  const [prompt, setPrompt] = useState("");
  const [when, setWhen] = useState<ItemStatus>(row ? itemStatus(row) : "live");
  const [publishAt, setPublishAt] = useState(
    row?.publish_at ? toLocalInput(row.publish_at) : "",
  );
  const [confirmed, setConfirmed] = useState(isEdit);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  /** A frame or image the admin chose, over the automatic thumbnail. */
  const [chosenThumb, setChosenThumb] = useState<Blob | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(isEdit);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const autoTitle = useRef("");
  const saving = progress != null;

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    api
      .getPrompt(row.id)
      .then((text) => {
        if (!cancelled) setPrompt(text);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Could not load the prompt: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setPromptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, row]);

  useEffect(() => {
    return () => {
      if (prepared) {
        URL.revokeObjectURL(prepared.thumbUrl);
        if (prepared.videoUrl) URL.revokeObjectURL(prepared.videoUrl);
      }
    };
  }, [prepared]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const flags = useMemo(
    () => scanContent(`${title} ${tags} ${prompt}`),
    [title, tags, prompt],
  );

  const chooseFile = async (file: File) => {
    setError("");
    const problem = validateFile(file, contentType);
    if (problem) {
      setError(problem);
      return;
    }
    setReading(true);
    try {
      const ready = await prepareFile(file, contentType);
      setChosenThumb(null);
      setFrameBusy(false);
      setPrepared({
        ...ready,
        thumbUrl: URL.createObjectURL(ready.thumb),
        videoUrl: contentType === "video" ? URL.createObjectURL(ready.file) : "",
      });
      // Follows the file until the admin types their own title.
      if (!title || title === autoTitle.current) {
        const fromName = titleFromFileName(file.name);
        autoTitle.current = fromName;
        setTitle(fromName);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(false);
    }
  };

  const switchType = (next: ContentType) => {
    setContentType(next);
    setPrepared(null);
    setChosenThumb(null);
    setFrameBusy(false);
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!isEdit && !prepared) {
      setError(`Choose a ${contentType} file first.`);
      return;
    }
    if (when !== "hidden" && !prompt.trim()) {
      setError("Write the prompt first, or choose Keep hidden to add it later.");
      return;
    }
    const scheduledFor = when === "scheduled" ? new Date(publishAt) : null;
    if (scheduledFor && !(scheduledFor.getTime() > Date.now())) {
      setError("Choose a date and time in the future.");
      return;
    }

    const uploaded: string[] = [];
    setProgress(0);
    try {
      let mediaPath = row?.media_path ?? "";
      let thumbPath = row?.thumb_path ?? null;
      let durationSec = row?.duration_sec ?? null;
      let mediaBytes: number | null = null;

      const fileWeight = prepared ? 0.9 : 0;
      if (prepared) {
        mediaPath = await api.uploadFile(
          prepared.file,
          contentType,
          prepared.file.type,
          (f) => setProgress(f * fileWeight),
        );
        uploaded.push(mediaPath);
        durationSec = prepared.durationSec;
        mediaBytes = prepared.file.size;
      }
      const newThumb = chosenThumb ?? prepared?.thumb ?? null;
      if (newThumb) {
        thumbPath = await api.uploadFile(newThumb, "thumb", "image/jpeg", (f) =>
          setProgress(fileWeight + f * (1 - fileWeight)),
        );
        uploaded.push(thumbPath);
      }

      await api.saveVideo(row?.id ?? null, {
        title: title.trim(),
        contentType,
        categoryId: categoryId || null,
        tags: parseTags(tags),
        mediaPath,
        thumbPath,
        durationSec,
        promptText: prompt.trim(),
        isPublished: when !== "hidden",
        mediaBytes,
        publishAt: scheduledFor?.toISOString() ?? null,
      });

      // A replaced file is no longer used by anything.
      if (row) {
        const old = [
          prepared ? row.media_path : null,
          newThumb ? row.thumb_path : null,
        ].filter((path): path is string => Boolean(path));
        await api.discardUploads(old).catch(() => undefined);
      }

      await onSaved(
        when === "live"
          ? `"${title.trim()}" is live. Users see it the next time they open or refresh the app.`
          : scheduledFor
            ? `"${title.trim()}" will go live on ${scheduledFor.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}.`
            : `"${title.trim()}" was saved as hidden.`,
      );
    } catch (err) {
      await api.discardUploads(uploaded).catch(() => undefined);
      setError((err as Error).message);
      setProgress(null);
    }
  };

  const previewUrl =
    prepared?.thumbUrl ?? (row?.thumb_path ? api.mediaUrl(row.thumb_path) : null);
  const canPlay = Boolean(row && !prepared && row.media_path.endsWith(".mp4"));
  const framesFrom = prepared?.videoUrl || (row ? api.mediaUrl(row.media_path) : "");

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="drawer"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit item" : "Upload new item"}
      >
        <div className="drawer-head">
          <h2>{isEdit ? "Edit item" : "Upload new"}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={saving}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">
          {!isEdit && (
            <div className="segmented wide" role="group" aria-label="Type">
              {(["video", "image"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={contentType === type ? "on" : ""}
                  aria-pressed={contentType === type}
                  onClick={() => switchType(type)}
                  disabled={saving}
                >
                  {type === "video" ? "Video" : "Image"}
                </button>
              ))}
            </div>
          )}

          {canPlay && row && (
            <video
              className="media-preview"
              src={api.mediaUrl(row.media_path)}
              poster={previewUrl ?? undefined}
              controls
              preload="none"
              playsInline
            />
          )}

          <div
            className={`drop ${previewUrl && contentType === "image" ? "has-preview" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file && !saving) void chooseFile(file);
            }}
          >
            {previewUrl && contentType === "image" && <img src={previewUrl} alt="Preview" />}
            <div>
              <p>
                {reading
                  ? "Reading the file..."
                  : prepared
                    ? `${prepared.file.name} (${formatBytes(prepared.file.size)})`
                    : isEdit
                      ? "Keep the current file, or replace it."
                      : `Drop a ${contentType === "video" ? "video (MP4)" : "image (JPG, PNG, WebP)"} here.`}
              </p>
              <button
                type="button"
                className="button small"
                onClick={() => inputRef.current?.click()}
                disabled={saving || reading}
              >
                {prepared || isEdit ? "Choose another file" : "Choose a file"}
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              hidden
              aria-label="File"
              accept={
                contentType === "video"
                  ? "video/mp4"
                  : "image/jpeg,image/png,image/webp"
              }
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void chooseFile(file);
              }}
            />
          </div>

          {prepared?.warnings.map((warning) => (
            <Alert kind="warn" key={warning}>
              {warning}
            </Alert>
          ))}

          {contentType === "video" && framesFrom && (
            <ThumbnailPicker
              key={framesFrom}
              source={framesFrom}
              remote={!prepared}
              currentUrl={previewUrl}
              disabled={saving}
              onPick={setChosenThumb}
              onBusy={setFrameBusy}
            />
          )}

          <label className="field">
            <span>Title</span>
            <input
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={saving}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Category</span>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={saving}
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
            <label className="field">
              <span>Tags, separated by commas</span>
              <input
                value={tags}
                placeholder="Portrait, Neon"
                onChange={(e) => setTags(e.target.value)}
                disabled={saving}
              />
            </label>
          </div>

          <label className="field">
            <span>Prompt</span>
            <textarea
              rows={6}
              aria-label="Prompt"
              value={prompt}
              placeholder={promptLoading ? "Loading..." : "The exact prompt users will copy"}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={saving || promptLoading}
            />
          </label>

          {flags.length > 0 && (
            <Alert kind="warn">
              This may involve {flags.join(", ")}. Check it against Google's content
              policies before publishing, because it can put your AdMob account at
              risk.
            </Alert>
          )}

          {!isEdit && (
            <label className="check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={saving}
              />
              <span>
                I have the rights to this content, and it has no sexual content,
                violence or hate.
              </span>
            </label>
          )}

          <div className="field">
            <span>When should it appear?</span>
            <div className="segmented wide" role="group" aria-label="When to publish">
              {WHEN.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={when === option.value ? "on" : ""}
                  aria-pressed={when === option.value}
                  onClick={() => setWhen(option.value)}
                  disabled={saving}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {when === "scheduled" && (
            <label className="field">
              <span>Date and time</span>
              <input
                type="datetime-local"
                required
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                disabled={saving}
              />
              <small className="muted">
                In your computer's time zone. It appears in the app after this time,
                the next time users open or refresh.
              </small>
            </label>
          )}

          {error && <Alert kind="error">{error}</Alert>}
        </div>

        <div className="drawer-foot">
          {saving && (
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress ?? 0) * 100)}
              aria-label="Upload progress"
            >
              <div style={{ width: `${(progress ?? 0) * 100}%` }} />
            </div>
          )}
          <button
            className="button primary wide"
            disabled={saving || reading || promptLoading || frameBusy || !confirmed}
          >
            {saving
              ? `Saving ${Math.round((progress ?? 0) * 100)}%`
              : isEdit
                ? "Save changes"
                : when === "live"
                  ? "Upload and publish"
                  : when === "scheduled"
                    ? "Upload and schedule"
                    : "Upload as hidden"}
          </button>
        </div>
      </form>
    </div>
  );
}
