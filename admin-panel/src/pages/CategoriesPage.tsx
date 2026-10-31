import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { Alert, Card, PageHeader, useFeedback } from "../components/ui";
import type { Api, Category } from "../lib/api";

export function CategoriesPage({ api }: { api: Api }) {
  const { toast, confirm, askText } = useFeedback();
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setCategories(await api.listCategories());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      if (done) toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const last = categories[categories.length - 1];
    void run(async () => {
      await api.saveCategory({
        name: trimmed,
        sort_order: (last?.sort_order ?? 0) + 10,
      });
      setName("");
    }, `"${trimmed}" was added.`);
  };

  const move = (index: number, by: number) => {
    const a = categories[index];
    const b = categories[index + by];
    void run(async () => {
      await api.saveCategory({ id: a.id, name: a.name, sort_order: b.sort_order });
      await api.saveCategory({ id: b.id, name: b.name, sort_order: a.sort_order });
    });
  };

  const rename = async (category: Category) => {
    const next = await askText({
      title: "Rename category",
      label: "Name",
      value: category.name,
      maxLength: 40,
    });
    if (!next || next === category.name) return;
    void run(() => api.saveCategory({ id: category.id, name: next }), "Category renamed.");
  };

  const remove = async (category: Category) => {
    const ok = await confirm({
      title: `Delete "${category.name}"?`,
      message: "Its videos and images stay, but they will have no category.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) void run(() => api.deleteCategory(category.id), "Category deleted.");
  };

  return (
    <>
      <PageHeader
        title="Categories"
        description={'The chips in the app, in this order. "All" and "Trending" are added automatically.'}
      />

      {error && <Alert kind="error">{error}</Alert>}

      <Card flush>
        <form className="toolbar" onSubmit={add}>
          <input
            className="grow"
            placeholder="New category name"
            aria-label="New category name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="button primary" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>
        <div className="table-scroll" aria-busy={loading}>
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Name</th>
                <th>In the app</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {categories.map((category, index) => (
                <tr key={category.id}>
                  <td>
                    <div className="row-actions start">
                      <button
                        className="icon-button"
                        disabled={busy || index === 0}
                        aria-label={`Move ${category.name} up`}
                        onClick={() => move(index, -1)}
                      >
                        <Icon name="up" />
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy || index === categories.length - 1}
                        aria-label={`Move ${category.name} down`}
                        onClick={() => move(index, 1)}
                      >
                        <Icon name="down" />
                      </button>
                    </div>
                  </td>
                  <td>
                    <strong>{category.name}</strong>
                  </td>
                  <td>
                    <span className={category.is_active ? "badge ok" : "badge"}>
                      {category.is_active ? "Shown" : "Hidden"}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={
                          category.is_active
                            ? `Hide ${category.name}`
                            : `Show ${category.name}`
                        }
                        title={category.is_active ? "Hide from the app" : "Show in the app"}
                        onClick={() =>
                          void run(() =>
                            api.saveCategory({
                              id: category.id,
                              name: category.name,
                              is_active: !category.is_active,
                            }),
                          )
                        }
                      >
                        <Icon name={category.is_active ? "eyeOff" : "eye"} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Rename ${category.name}`}
                        title="Rename"
                        onClick={() => rename(category)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-button danger"
                        disabled={busy}
                        aria-label={`Delete ${category.name}`}
                        title="Delete"
                        onClick={() => remove(category)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && categories.length === 0 && (
          <div className="empty">
            <p className="muted">No categories yet.</p>
          </div>
        )}
      </Card>
    </>
  );
}
