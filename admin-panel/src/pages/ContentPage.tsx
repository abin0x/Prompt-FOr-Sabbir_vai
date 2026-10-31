import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Alert, Card, PageHeader, useFeedback } from "../components/ui";
import { BulkUpload } from "../components/BulkUpload";
import { VideoForm } from "../components/VideoForm";
import type { Api, Category, VideoQuery, VideoRow, VideoSort } from "../lib/api";
import {
  formatBytes,
  formatCount,
  formatDuration,
  itemStatus,
  STATUS_LABELS,
} from "../lib/media";

const PAGE_SIZE = 20;

type Editing = { mode: "closed" } | { mode: "new" } | { mode: "edit"; row: VideoRow };
type View = "table" | "grid";

const TABS: { value: VideoQuery["contentType"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Videos" },
  { value: "image", label: "Images" },
];

const SORTS: { value: VideoSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "most_viewed", label: "Most viewed" },
  { value: "title", label: "Title A to Z" },
];

export function ContentPage({
  api,
  uploadRequest,
}: {
  api: Api;
  uploadRequest: number;
}) {
  const { toast, confirm } = useFeedback();
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Editing>({ mode: "closed" });
  const [bulk, setBulk] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(
    () => (localStorage.getItem("library-view") as View) || "table",
  );
  const [query, setQuery] = useState<VideoQuery>({
    search: "",
    contentType: "all",
    status: "all",
    categoryId: "",
    sort: "newest",
    page: 0,
    pageSize: PAGE_SIZE,
  });

  const seenRequest = useRef(0);
  useEffect(() => {
    if (uploadRequest > seenRequest.current) {
      seenRequest.current = uploadRequest;
      setEditing({ mode: "new" });
    }
  }, [uploadRequest]);

  useEffect(() => {
    localStorage.setItem("library-view", view);
  }, [view]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [list, cats] = await Promise.all([
        api.listVideos(query),
        api.listCategories(),
      ]);
      setRows(list.rows);
      setTotal(list.total);
      setCategories(cats);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, query]);

  useEffect(() => {
    void load();
  }, [load]);

  // Wait for a pause in typing before searching, to save requests.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((q) => (q.search === search ? q : { ...q, search, page: 0 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const categoryName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? "No category";

  const setPublished = async (ids: string[], published: boolean, message: string) => {
    setBusy(true);
    try {
      await api.setPublished(ids, published);
      toast(message);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (row: VideoRow) => {
    setBusy(true);
    try {
      await api.setFeatured(row.id, !row.is_featured);
      toast(
        row.is_featured
          ? `"${row.title}" is no longer pinned.`
          : `"${row.title}" is pinned to the top of Home.`,
      );
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (targets: VideoRow[]) => {
    const single = targets.length === 1;
    const ok = await confirm({
      title: single ? `Delete "${targets[0].title}"?` : `Delete ${targets.length} items?`,
      message: "This also removes the files from storage. It cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    let filesKept = false;
    try {
      for (const target of targets) {
        const { filesRemoved } = await api.deleteVideo(target.id);
        if (!filesRemoved) filesKept = true;
      }
      toast(
        filesKept
          ? "Deleted, but some files could not be removed from storage."
          : single
            ? `"${targets[0].title}" was deleted.`
            : `${targets.length} items were deleted.`,
        filesKept ? "error" : "ok",
      );
      if (rows.length === targets.length && query.page > 0) {
        setQuery((q) => ({ ...q, page: q.page - 1 }));
      } else {
        await load();
      }
    } catch (err) {
      toast((err as Error).message, "error");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onSaved = async (message: string) => {
    setEditing({ mode: "closed" });
    toast(message);
    await load();
  };

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  const toggleOne = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered =
    query.search !== "" ||
    query.contentType !== "all" ||
    query.status !== "all" ||
    query.categoryId !== "";

  const statusBadge = (row: VideoRow, solid = false) => {
    const status = itemStatus(row);
    const tone = status === "live" ? "ok" : status === "scheduled" ? "warn" : "";
    return (
      <span
        className={["badge", tone, solid ? "solid" : ""].filter(Boolean).join(" ")}
        title={
          status === "scheduled"
            ? new Date(row.publish_at!).toLocaleString("en", {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : undefined
        }
      >
        {STATUS_LABELS[status]}
      </span>
    );
  };

  const noPromptBadge = (row: VideoRow) =>
    !row.has_prompt && <span className="badge warn">No prompt</span>;

  const pinButton = (row: VideoRow) => (
    <button
      className={row.is_featured ? "icon-button pinned" : "icon-button"}
      disabled={busy}
      aria-label={row.is_featured ? `Unpin ${row.title}` : `Pin ${row.title}`}
      aria-pressed={row.is_featured}
      title={row.is_featured ? "Remove from the top of Home" : "Pin to the top of Home"}
      onClick={() => void togglePin(row)}
    >
      <Icon name="star" />
    </button>
  );

  const actions = (row: VideoRow) => (
    <>
      <button
        className="icon-button"
        disabled={busy}
        aria-label={row.is_published ? `Hide ${row.title}` : `Publish ${row.title}`}
        title={row.is_published ? "Hide from the app" : "Publish to the app"}
        onClick={() =>
          setPublished(
            [row.id],
            !row.is_published,
            row.is_published
              ? `"${row.title}" is hidden from the app.`
              : `"${row.title}" is live in the app.`,
          )
        }
      >
        <Icon name={row.is_published ? "eyeOff" : "eye"} />
      </button>
      <button
        className="icon-button"
        aria-label={`Edit ${row.title}`}
        title="Edit"
        onClick={() => setEditing({ mode: "edit", row })}
      >
        <Icon name="edit" />
      </button>
      <button
        className="icon-button danger"
        disabled={busy}
        aria-label={`Delete ${row.title}`}
        title="Delete"
        onClick={() => void remove([row])}
      >
        <Icon name="trash" />
      </button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Library"
        description={`${total} ${total === 1 ? "item" : "items"}`}
        actions={
          <>
            <button className="button" onClick={() => setBulk(true)}>
              <Icon name="upload" size={16} />
              Bulk upload
            </button>
            <button className="button primary" onClick={() => setEditing({ mode: "new" })}>
              <Icon name="upload" size={16} />
              Upload new
            </button>
          </>
        }
      />

      {error && <Alert kind="error">{error}</Alert>}

      <Card flush>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Type">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                className={query.contentType === tab.value ? "on" : ""}
                aria-pressed={query.contentType === tab.value}
                onClick={() =>
                  setQuery((q) => ({ ...q, contentType: tab.value, page: 0 }))
                }
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Search by title"
              aria-label="Search by title"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Status"
            className="filter-select"
            value={query.status}
            onChange={(e) =>
              setQuery((q) => ({
                ...q,
                status: e.target.value as VideoQuery["status"],
                page: 0,
              }))
            }
          >
            <option value="all">Any status</option>
            <option value="published">Live</option>
            <option value="scheduled">Scheduled</option>
            <option value="hidden">Hidden</option>
            <option value="no_prompt">No prompt</option>
            <option value="pinned">Pinned</option>
          </select>
          <select
            aria-label="Category"
            className="filter-select"
            value={query.categoryId}
            onChange={(e) =>
              setQuery((q) => ({ ...q, categoryId: e.target.value, page: 0 }))
            }
          >
            <option value="">All categories</option>
            <option value="none">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort"
            className="filter-select"
            value={query.sort}
            onChange={(e) =>
              setQuery((q) => ({ ...q, sort: e.target.value as VideoSort, page: 0 }))
            }
          >
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
          <div className="segmented icons" role="group" aria-label="View">
            <button
              className={view === "table" ? "on" : ""}
              aria-pressed={view === "table"}
              aria-label="Table view"
              title="Table view"
              onClick={() => setView("table")}
            >
              <Icon name="rows" size={16} />
            </button>
            <button
              className={view === "grid" ? "on" : ""}
              aria-pressed={view === "grid"}
              aria-label="Grid view"
              title="Grid view"
              onClick={() => setView("grid")}
            >
              <Icon name="grid" size={16} />
            </button>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label="Selected items">
            <strong>{selected.size} selected</strong>
            <button
              className="button small"
              disabled={busy}
              onClick={() =>
                setPublished([...selected], true, `${selected.size} items are live.`)
              }
            >
              Publish
            </button>
            <button
              className="button small"
              disabled={busy}
              onClick={() =>
                setPublished([...selected], false, `${selected.size} items are hidden.`)
              }
            >
              Hide
            </button>
            <button
              className="button small danger"
              disabled={busy}
              onClick={() => void remove(selectedRows)}
            >
              Delete
            </button>
            <button className="text-link" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        {view === "table" ? (
          <div className="table-scroll" aria-busy={loading}>
            <table className="table">
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="num">Views</th>
                  <th className="num" title="Times Generate Prompt was used">
                    Generated
                  </th>
                  <th className="num" title="Times a prompt was copied">
                    Copied
                  </th>
                  <th className="num">Size</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={selected.has(row.id) ? "selected" : ""}>
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.title}`}
                        checked={selected.has(row.id)}
                        onChange={() => toggleOne(row.id)}
                      />
                    </td>
                    <td>
                      <div className="item-cell">
                        {row.thumb_path ? (
                          <img src={api.mediaUrl(row.thumb_path)} alt="" loading="lazy" />
                        ) : (
                          <div className="no-thumb" />
                        )}
                        <div>
                          <button
                            className="item-title"
                            onClick={() => setEditing({ mode: "edit", row })}
                          >
                            {row.title}
                          </button>
                          <span className="muted small item-meta">
                            <Icon name={row.content_type} size={12} />
                            {row.content_type === "video"
                              ? `Video ${formatDuration(row.duration_sec)}`
                              : "Image"}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>{categoryName(row.category_id)}</td>
                    <td className="num">{formatCount(row.view_count)}</td>
                    <td className="num">{formatCount(row.generate_count)}</td>
                    <td className="num">{formatCount(row.copy_count)}</td>
                    <td className="num muted">
                      {row.media_bytes != null ? formatBytes(row.media_bytes) : "-"}
                    </td>
                    <td>
                      <div className="badge-row">
                        {statusBadge(row)}
                        {noPromptBadge(row)}
                      </div>
                    </td>
                    <td className="muted nowrap">
                      {new Date(row.created_at).toLocaleDateString("en", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td>
                      <div className="row-actions">
                        {pinButton(row)}
                        {actions(row)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="media-grid" aria-busy={loading}>
            {rows.map((row) => (
              <article
                key={row.id}
                className={selected.has(row.id) ? "media-card selected" : "media-card"}
              >
                <div className="media-thumb">
                  {row.thumb_path ? (
                    <img src={api.mediaUrl(row.thumb_path)} alt="" loading="lazy" />
                  ) : (
                    <div className="no-thumb" />
                  )}
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggleOne(row.id)}
                  />
                  {statusBadge(row, true)}
                  {row.duration_sec != null && (
                    <span className="media-time">{formatDuration(row.duration_sec)}</span>
                  )}
                </div>
                <div className="media-info">
                  <button
                    className="item-title"
                    onClick={() => setEditing({ mode: "edit", row })}
                  >
                    {row.title}
                  </button>
                  <span className="muted small">
                    {categoryName(row.category_id)} · {formatCount(row.view_count)} views ·{" "}
                    {formatCount(row.generate_count)} generated
                  </span>
                  {noPromptBadge(row)}
                </div>
                <div className="media-actions">
                  {pinButton(row)}
                  <span className="grow-space" />
                  {actions(row)}
                </div>
              </article>
            ))}
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="library" size={20} />
            </span>
            <p className="muted">
              {filtered
                ? "Nothing matches these filters."
                : "No content yet. Upload your first video."}
            </p>
          </div>
        )}

        {pages > 1 && (
          <div className="pager">
            <span className="muted small">
              Page {query.page + 1} of {pages}
            </span>
            <button
              className="button small"
              disabled={query.page === 0}
              onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}
            >
              Previous
            </button>
            <button
              className="button small"
              disabled={query.page + 1 >= pages}
              onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}
            >
              Next
            </button>
          </div>
        )}
      </Card>

      {bulk && (
        <BulkUpload
          api={api}
          categories={categories}
          onClose={() => setBulk(false)}
          onFinished={async (saved) => {
            toast(`${saved} ${saved === 1 ? "item" : "items"} saved as hidden. Add prompts, then publish.`);
            await load();
          }}
        />
      )}

      {editing.mode !== "closed" && (
        <VideoForm
          api={api}
          categories={categories}
          row={editing.mode === "edit" ? editing.row : null}
          onClose={() => setEditing({ mode: "closed" })}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
