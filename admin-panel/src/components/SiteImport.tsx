import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { Alert } from "./ui";
import type { Api, Category, SourceMatch } from "../lib/api";
import { planSiteImport, readSiteFile, siteImportItems, type SiteFile, type SitePlan } from "../lib/siteImport";
/** Counts in full, like 7,175: an import is checked row by row. */
const exact = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${exact(n)} ${n === 1 ? one : many}`;

/** Rows sent per call, so the progress bar moves. */
const CHUNK = 500;
/** Problems shown in full before they collapse into a count. */
const SHOWN_PROBLEMS = 6;

interface Loaded {
  name: string;
  file: SiteFile;
  matches: SourceMatch[];
  categories: Category[];
  plan: SitePlan;
}

/**
 * Imports the prompts of an old website in one go. The images and videos are
 * already in storage (tools/site-import copies them); this saves the rows as
 * hidden items in one set, which the switch in the Library puts live.
 */
export function SiteImport({
  api,
  onClose,
  onFinished,
}: {
  api: Api;
  onClose: () => void;
  onFinished: (message: string) => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(0);
  const [failures, setFailures] = useState<string[]>([]);
  const [summary, setSummary] = useState("");

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setError("");
    setSummary("");
    setLoaded(null);
    setReading(true);
    try {
      const file = readSiteFile(await chosen.text());
      if (file.items.length === 0) throw new Error("This file has no rows to import.");
      // Fails before the database has the import sets, so nothing is saved
      // without its set.
      await api.importBatches();
      const [categories, matches] = await Promise.all([
        api.listCategories(),
        api.matchSourceNames(file.items.map((item) => item.source_name)),
      ]);
      setLoaded({
        name: chosen.name,
        file,
        matches,
        categories,
        plan: planSiteImport(file, matches, categories),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function start() {
    if (!loaded) return;
    setRunning(true);
    setError("");
    setSaved(0);
    setFailures([]);
    try {
      let categories = loaded.categories;
      if (loaded.plan.missingCategories.length) {
        let order = Math.max(0, ...categories.map((c) => c.sort_order));
        for (const name of loaded.plan.missingCategories) {
          order += 10;
          await api.saveCategory({ name, sort_order: order }).catch((err: Error) => {
            if (!err.message.includes("already exists")) throw err;
          });
        }
        categories = await api.listCategories();
      }

      const rows = siteImportItems(loaded.file, loaded.matches, categories);
      const problems: string[] = [];
      let ok = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const results = await api.importItems(rows.slice(i, i + CHUNK));
        results.forEach((result, j) => {
          if (result.error) {
            problems.push(`${loaded.file.items[i + j].title}: ${result.error}`);
          } else {
            ok++;
          }
        });
        setSaved(Math.min(rows.length, i + CHUNK));
        setFailures([...problems]);
      }

      const message =
        `${exact(ok)} saved to "${loaded.file.batch}"` +
        (problems.length ? `, ${problems.length} failed.` : ".") +
        " They are hidden until you turn on the set's switch in the Library.";
      setSummary(message);
      await onFinished(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const plan = loaded?.plan;
  const total = loaded?.file.items.length ?? 0;
  const done = Boolean(summary);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Website import">
        <div className="drawer-head">
          <h2>Website import</h2>
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
            Brings in every prompt from your old website at once. First the import tool
            copies the images and videos into your storage and writes{" "}
            <strong>prompt-lab-site-import.json</strong>. Choose that file here. All
            items are saved hidden, in one set; the set's switch in the Library puts
            them live in the app together. Importing the same file again updates the
            items instead of copying them.
          </p>

          <div className="drop">
            <div>
              <p>
                {loaded
                  ? `${loaded.name}: ${exact(total)} prompts`
                  : reading
                    ? "Reading the file..."
                    : "Choose prompt-lab-site-import.json."}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button small"
                  onClick={() => input.current?.click()}
                  disabled={running || reading}
                >
                  {loaded ? "Choose another file" : "Choose the file"}
                </button>
              </div>
            </div>
            <input
              ref={input}
              type="file"
              accept=".json,application/json"
              aria-label="Import file"
              hidden
              onChange={(e) => {
                void choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          {loaded && plan && (
            <>
              <ul className="plain-list site-plan">
                <li>
                  <strong>{exact(total)}</strong> prompts go into the set{" "}
                  <strong>{loaded.file.batch}</strong>: {plural(plan.images, "image", "images")} and{" "}
                  {plural(plan.videos, "video", "videos")}.
                </li>
                <li>
                  {exact(plan.newCount)} new
                  {plan.updateCount > 0 &&
                    `, ${exact(plan.updateCount)} imported before (they are updated, and stay live or hidden as they are)`}
                  .
                </li>
                <li>
                  {plan.withFile === 1 ? "1 has its" : `${exact(plan.withFile)} have their`} image or video.
                  {plan.withoutFile > 0 &&
                    ` ${plan.withoutFile === 1 ? "1 has" : `${exact(plan.withoutFile)} have`} none, because the old link no longer works; they stay hidden drafts until a file is added (Bulk upload, or Status: No file).`}
                </li>
                {plan.missingCategories.length > 0 && (
                  <li>
                    New categories are made for:{" "}
                    {plan.missingCategories.join(", ")}.
                  </li>
                )}
              </ul>

              {loaded.file.problems.length > 0 && (
                <Alert kind="warn">
                  {loaded.file.problems.length} rows are left out:{" "}
                  {loaded.file.problems.slice(0, SHOWN_PROBLEMS).join(" ")}
                  {loaded.file.problems.length > SHOWN_PROBLEMS &&
                    ` And ${loaded.file.problems.length - SHOWN_PROBLEMS} more.`}
                </Alert>
              )}

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

          {(running || done) && total > 0 && (
            <div className="site-progress">
              <span className="muted small">
                {exact(saved)} of {exact(total)} saved
              </span>
              <div className="meter wide">
                <div style={{ width: `${(saved / total) * 100}%` }} />
              </div>
            </div>
          )}

          {failures.length > 0 && (
            <Alert kind="error">
              {failures.length} not saved: {failures.slice(0, SHOWN_PROBLEMS).join(" ")}
              {failures.length > SHOWN_PROBLEMS &&
                ` And ${failures.length - SHOWN_PROBLEMS} more.`}
            </Alert>
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
              disabled={!loaded || running || reading || !confirmed}
              onClick={() => void start()}
            >
              {running ? "Importing..." : `Import ${exact(total)} prompts`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
