import { useEffect, useState } from "react";
import { Card, Toggle, useFeedback } from "./ui";
import type { Api, ImportBatch } from "../lib/api";

const exact = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${exact(n)} ${n === 1 ? one : many}`;

function describe(set: ImportBatch): string {
  const waiting = set.total - set.ready;
  return (
    `${plural(set.total, "item", "items")}: ${plural(set.image_items, "image", "images")}, ${plural(set.video_items, "video", "videos")}. ` +
    `Live now: ${exact(set.live)}.` +
    (waiting === 1
      ? " 1 has no file or prompt and stays hidden."
      : waiting > 1
        ? ` ${exact(waiting)} have no file or prompt and stay hidden.`
        : "")
  );
}

/**
 * One switch per imported set: on puts every item of the set live in the app,
 * off hides them all again. Nothing shows when there are no imported sets.
 */
export function ImportSets({
  api,
  refreshKey,
  onChanged,
}: {
  api: Api;
  refreshKey: number;
  onChanged: () => void | Promise<void>;
}) {
  const { toast, confirm } = useFeedback();
  const [sets, setSets] = useState<ImportBatch[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .importBatches()
      .then((found) => {
        if (!cancelled) setSets(found);
      })
      // Before the database is updated there are no sets to show.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, refreshKey]);

  if (sets.length === 0) return null;

  async function change(set: ImportBatch, live: boolean) {
    if (!live) {
      const ok = await confirm({
        title: `Hide all of "${set.batch}"?`,
        message: `${exact(set.live)} items leave the app now. Turn the switch on again to bring them back.`,
        confirmLabel: "Hide all",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(set.batch);
    try {
      const { changed, skipped } = await api.setBatchLive(set.batch, live);
      toast(
        live
          ? `${exact(changed)} items of "${set.batch}" are live in the app.` +
              (skipped ? ` ${exact(skipped)} have no file or prompt and stay hidden.` : "")
          : `${exact(changed)} items of "${set.batch}" are hidden from the app.`,
      );
      setSets(await api.importBatches());
      await onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <Card
      title="Website imports"
      description="Each set goes live in the app, or hides, with its switch. The app on phones loads the newest 500 live items, so a bigger set shows its newest 500 there."
    >
      <div className="import-sets">
        {sets.map((set) => (
          <Toggle
            key={set.batch}
            label={busy === set.batch ? `${set.batch} (working...)` : set.batch}
            description={describe(set)}
            checked={set.live > 0}
            disabled={busy !== "" || (set.ready === 0 && set.live === 0)}
            onChange={(live) => void change(set, live)}
          />
        ))}
      </div>
    </Card>
  );
}
