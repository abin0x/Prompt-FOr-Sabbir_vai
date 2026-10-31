import { useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Alert, Card, PageHeader } from "../components/ui";
import type { ActivityEntry, Api } from "../lib/api";

const LIMIT = 100;

const CONFIG_NAMES: Record<string, string> = {
  ads: "Ad controls",
  app: "App settings",
  limits: "Limits",
};

function describe(entry: ActivityEntry): { icon: IconName; text: string } {
  const label = entry.target_label ?? "";
  if (entry.target_type === "app_config") {
    return { icon: "settings", text: `Changed ${CONFIG_NAMES[label] ?? label}` };
  }
  const action = entry.action.charAt(0).toUpperCase() + entry.action.slice(1);
  if (entry.target_type === "categories") {
    return { icon: "tag", text: `${action} category "${label}"` };
  }
  const icons: Record<string, IconName> = {
    published: "eye",
    scheduled: "history",
    hid: "eyeOff",
    pinned: "star",
    unpinned: "star",
    deleted: "trash",
    edited: "edit",
    created: "upload",
  };
  return { icon: icons[entry.action] ?? "library", text: `${action} "${label}"` };
}

export function ActivityPage({ api }: { api: Api }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listActivity(LIMIT)
      .then(setEntries)
      .catch((err: Error) => setError(err.message));
  }, [api]);

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Who changed what, newest first. Shows the latest ${LIMIT} changes.`}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <Card flush>
        {entries && entries.length > 0 && (
          <ul className="activity-list">
            {entries.map((entry) => {
              const { icon, text } = describe(entry);
              return (
                <li key={entry.id}>
                  <span className="stat-icon">
                    <Icon name={icon} size={15} />
                  </span>
                  <div>
                    <strong>{text}</strong>
                    <span className="muted small">{entry.actor_email ?? "System"}</span>
                  </div>
                  <time className="muted small nowrap" dateTime={entry.created_at}>
                    {new Date(entry.created_at).toLocaleString("en", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
        {entries && entries.length === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="history" size={20} />
            </span>
            <p className="muted">No changes yet.</p>
          </div>
        )}
        {!entries && !error && (
          <div className="empty">
            <p className="muted">Loading...</p>
          </div>
        )}
      </Card>
    </>
  );
}
