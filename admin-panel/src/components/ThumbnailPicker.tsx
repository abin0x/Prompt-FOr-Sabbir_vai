import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { captureFrame, makeImageThumb, validateFile } from "../lib/media";

/**
 * Chooses a video's thumbnail: drag along the video and the frame on screen is
 * used, or drop in an image. The small preview is shaped like a card in the app,
 * so the crop can be judged before saving.
 */
export function ThumbnailPicker({
  source,
  remote,
  currentUrl,
  disabled,
  onPick,
  onBusy,
}: {
  /** The video to take frames from. */
  source: string;
  /** Already in storage, so frames are only loaded when asked for. */
  remote: boolean;
  currentUrl: string | null;
  disabled: boolean;
  onPick: (thumb: Blob) => void;
  /** True from the moment the time changes until its frame is ready. */
  onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(!remote);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wanted = useRef(0);
  const asked = useRef(0);
  const seeking = useRef(false);
  const captureId = useRef(0);

  useEffect(() => {
    return () => {
      if (picked) URL.revokeObjectURL(picked);
    };
  }, [picked]);

  const use = (thumb: Blob, description: string) => {
    setPicked(URL.createObjectURL(thumb));
    setNote(description);
    setError("");
    onPick(thumb);
  };

  // Seeks can arrive faster than the video can follow while dragging, so only
  // the latest position is kept, and only the frame it lands on is captured.
  const seek = (next: number) => {
    wanted.current = next;
    setTime(next);
    onBusy(true);
    if (seeking.current || !videoRef.current) return;
    seeking.current = true;
    asked.current = next;
    videoRef.current.currentTime = next;
  };

  const onSeeked = async () => {
    const video = videoRef.current!;
    if (asked.current !== wanted.current) {
      asked.current = wanted.current;
      video.currentTime = wanted.current;
      return;
    }
    seeking.current = false;
    const id = ++captureId.current;
    try {
      const thumb = await captureFrame(video);
      // The time may have moved on while this frame was being made.
      if (id === captureId.current && !seeking.current) {
        use(thumb, `Frame at ${wanted.current.toFixed(1)} seconds`);
        onBusy(false);
      }
    } catch {
      setError(
        "This browser could not read that frame. Drop in an image instead.",
      );
      onBusy(false);
    }
  };

  const useImage = async (file: File) => {
    const problem = validateFile(file, "image");
    if (problem) {
      setError(problem);
      return;
    }
    try {
      // A frame still on its way must not replace the chosen image.
      seeking.current = false;
      captureId.current++;
      onBusy(false);
      use(await makeImageThumb(file), `Your image: ${file.name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shown = picked ?? currentUrl;

  return (
    <div className="field">
      <span>Thumbnail</span>
      <div className="thumb-picker">
        <div
          className={dragging ? "thumb-card dragging" : "thumb-card"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file && !disabled) void useImage(file);
          }}
        >
          {shown ? (
            <img src={shown} alt="Thumbnail preview" />
          ) : (
            <div className="no-thumb" />
          )}
          <span className="thumb-card-hint">Drop an image</span>
        </div>

        <div className="thumb-tools">
          {open ? (
            <>
              <video
                ref={videoRef}
                src={source}
                crossOrigin={remote ? "anonymous" : undefined}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget;
                  setDuration(video.duration);
                  // Shows a frame right away, without replacing the thumbnail.
                  video.currentTime = Math.min(0.5, video.duration / 2);
                  wanted.current = video.currentTime;
                  setTime(video.currentTime);
                  seeking.current = false;
                }}
                onSeeked={() => {
                  if (seeking.current) void onSeeked();
                }}
                onError={() => {
                  setError(
                    "Could not load the video here. Drop in an image instead.",
                  );
                  onBusy(false);
                }}
              />
              <label className="thumb-slider">
                <span className="small muted">
                  Drag to choose the frame: {time.toFixed(1)}s
                  {duration > 0 ? ` of ${duration.toFixed(1)}s` : ""}
                </span>
                <input
                  type="range"
                  aria-label="Thumbnail time"
                  min={0}
                  max={duration || 1}
                  step={0.1}
                  value={time}
                  disabled={disabled || duration === 0}
                  onChange={(e) => seek(e.target.valueAsNumber)}
                />
              </label>
            </>
          ) : (
            <button
              type="button"
              className="button small"
              disabled={disabled}
              onClick={() => setOpen(true)}
            >
              <Icon name="video" size={15} />
              Choose a frame from the video
            </button>
          )}

          <button
            type="button"
            className="button small"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <Icon name="image" size={15} />
            Choose an image
          </button>
          <input
            ref={inputRef}
            type="file"
            hidden
            aria-label="Thumbnail image"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void useImage(file);
            }}
          />

          <small className={error ? "field-error" : "muted"} role="status">
            {error ||
              note ||
              (remote
                ? "The current thumbnail stays unless you choose."
                : "A frame from the start of the video is used unless you choose.")}
          </small>
        </div>
      </div>
    </div>
  );
}
