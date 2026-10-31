import { useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import { Icon, type IconName } from "../components/Icon";
import { Alert, Card, PageHeader, Skeleton } from "../components/ui";
import { ViewsChart } from "../components/ViewsChart";
import type { AdConfig, Api, AppSettings, Overview } from "../lib/api";
import { formatBytes, formatCount, itemStatus, MB, STATUS_LABELS } from "../lib/media";
import { runPolicyChecks } from "../lib/policy";

/** Cloudflare R2's free storage. Above this, storage costs a little each month. */
const FREE_STORAGE_BYTES = 10 * 1024 * MB;

function Stat({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "up" | "down";
  icon: IconName;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">
          <Icon name={icon} size={15} />
        </span>
      </div>
      <div className="stat-value">{value}</div>
      {note && <div className={tone ? `stat-note ${tone}` : "stat-note"}>{note}</div>}
    </div>
  );
}

function weekChange(data: Overview): { note: string; tone?: "up" | "down" } {
  if (data.views_prev_7d === 0) return { note: "No earlier week to compare" };
  const change = (data.views_7d - data.views_prev_7d) / data.views_prev_7d;
  const percent = Math.round(Math.abs(change) * 100);
  if (percent === 0) return { note: "Same as the week before" };
  return {
    note: `${change > 0 ? "Up" : "Down"} ${percent}% from the week before`,
    tone: change > 0 ? "up" : "down",
  };
}

function StatusRow({
  label,
  value,
  state,
  onClick,
}: {
  label: string;
  value: string;
  state: "ok" | "warn" | "fail" | "off";
  onClick: () => void;
}) {
  return (
    <li>
      <button className="status-row" onClick={onClick}>
        <span className={`dot ${state}`} />
        <span className="status-name">{label}</span>
        <span className="muted small">{value}</span>
      </button>
    </li>
  );
}

export function OverviewPage({
  api,
  go,
  onUpload,
}: {
  api: Api;
  go: (page: Page) => void;
  onUpload: () => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [ads, setAds] = useState<AdConfig | null>(null);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getOverview(), api.getConfig("ads"), api.getConfig("app")])
      .then(([overview, adConfig, appSettings]) => {
        if (cancelled) return;
        setData(overview);
        setAds(adConfig);
        setApp(appSettings);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const checks = useMemo(
    () => (ads && app ? runPolicyChecks(ads, app) : []),
    [ads, app],
  );
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;

  const maxCategoryViews = Math.max(...(data?.categories.map((c) => c.views) ?? [0]), 1);
  const change = data ? weekChange(data) : null;
  const storageShare = data ? Math.min(data.media_bytes / FREE_STORAGE_BYTES, 1) : 0;

  const issues: { label: string; page: Page; severity: "warn" | "fail" }[] = [];
  if (data) {
    if (data.open_reports > 0) {
      issues.push({
        label: `${data.open_reports} open ${data.open_reports === 1 ? "report" : "reports"}`,
        page: "reports",
        severity: "fail",
      });
    }
    if (data.no_prompt > 0) {
      issues.push({
        label: `${data.no_prompt} ${data.no_prompt === 1 ? "item needs" : "items need"} a prompt`,
        page: "library",
        severity: "warn",
      });
    }
    if (data.no_category > 0) {
      issues.push({
        label: `${data.no_category} ${data.no_category === 1 ? "item has" : "items have"} no category`,
        page: "library",
        severity: "warn",
      });
    }
    for (const check of checks) {
      if (check.status !== "pass") {
        issues.push({ label: check.title, page: "policy", severity: check.status });
      }
    }
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description="How the app and your content are doing."
        actions={
          <button className="button primary" onClick={onUpload}>
            <Icon name="upload" size={16} />
            Upload new
          </button>
        }
      />
      {error && <Alert kind="error">{error}</Alert>}

      {app?.maintenance_mode && (
        <Alert kind="warn">
          Maintenance mode is on, so users cannot open the app.{" "}
          <button className="text-link" onClick={() => go("settings")}>
            App settings
          </button>
        </Alert>
      )}
      {ads && !ads.ads_enabled && (
        <Alert kind="warn">
          All ads are turned off, so the app is earning nothing.{" "}
          <button className="text-link" onClick={() => go("ads")}>
            Ad controls
          </button>
        </Alert>
      )}

      <div className="stats six">
        {data && change ? (
          <>
            <Stat
              icon="library"
              label="Live in the app"
              value={String(data.live)}
              note={`${data.videos} ${data.videos === 1 ? "video" : "videos"}, ${data.images} ${data.images === 1 ? "image" : "images"} in total`}
            />
            <Stat
              icon="eyeOff"
              label="Hidden"
              value={String(data.hidden)}
              note={
                data.scheduled
                  ? `${data.scheduled} more scheduled to go live`
                  : data.hidden
                    ? "Saved but not visible to users"
                    : "Nothing waiting"
              }
            />
            <Stat
              icon="chart"
              label="Views, last 7 days"
              value={formatCount(data.views_7d)}
              {...change}
            />
            <Stat
              icon="eye"
              label="Views, all time"
              value={formatCount(data.total_views)}
              note={
                data.no_views
                  ? `${data.no_views} live ${data.no_views === 1 ? "item has" : "items have"} no views yet`
                  : undefined
              }
            />
            <Stat
              icon="star"
              label="Prompts generated"
              value={formatCount(data.total_generates)}
              note="All time"
            />
            <Stat
              icon="check"
              label="Prompts copied"
              value={formatCount(data.total_copies)}
              note={
                data.total_generates
                  ? `${Math.round((data.total_copies / data.total_generates) * 100)}% of those generated`
                  : "All time"
              }
            />
          </>
        ) : (
          [0, 1, 2, 3, 4, 5].map((n) => (
            <div className="stat" key={n}>
              <Skeleton height={14} />
              <Skeleton height={32} />
            </div>
          ))
        )}
      </div>

      <div className="grid-main">
        <Card title="Daily views" description="Last 14 days">
          {data ? (
            data.daily.some((d) => d.views > 0) ? (
              <ViewsChart daily={data.daily} />
            ) : (
              <div className="empty">
                <span className="empty-icon">
                  <Icon name="chart" size={20} />
                </span>
                <p className="muted">
                  No views yet. They appear here once the app is connected and
                  users watch content.
                </p>
              </div>
            )
          ) : (
            <Skeleton height={220} />
          )}
        </Card>

        <div className="stack">
          <Card title="App status">
            {data && ads && app ? (
              <ul className="status-list">
                <StatusRow
                  label="App"
                  value={app.maintenance_mode ? "Maintenance" : "Available"}
                  state={app.maintenance_mode ? "warn" : "ok"}
                  onClick={() => go("settings")}
                />
                <StatusRow
                  label="Ads"
                  value={
                    !ads.ads_enabled ? "Off" : ads.use_test_ads ? "Test ads" : "Live"
                  }
                  state={!ads.ads_enabled ? "off" : ads.use_test_ads ? "warn" : "ok"}
                  onClick={() => go("ads")}
                />
                <StatusRow
                  label="Policy check"
                  value={
                    fails
                      ? `${fails} to fix`
                      : warns
                        ? `${warns} to review`
                        : "All clear"
                  }
                  state={fails ? "fail" : warns ? "warn" : "ok"}
                  onClick={() => go("policy")}
                />
                <StatusRow
                  label="Reports"
                  value={data.open_reports ? `${data.open_reports} open` : "None open"}
                  state={data.open_reports ? "fail" : "ok"}
                  onClick={() => go("reports")}
                />
              </ul>
            ) : (
              <Skeleton height={120} />
            )}
          </Card>

          <Card title="Storage">
            {data ? (
              <>
                <div className="storage-head">
                  <strong>{formatBytes(data.media_bytes)}</strong>
                  <span className="muted small">of 10 GB free</span>
                </div>
                <div className="meter wide" role="img" aria-label={`${Math.round(storageShare * 100)}% of free storage used`}>
                  <div style={{ width: `${storageShare * 100}%` }} />
                </div>
                <p className="muted small top-gap-small">
                  Videos and images only, based on upload sizes.
                </p>
              </>
            ) : (
              <Skeleton height={60} />
            )}
          </Card>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="section-gap">
          <Card title="Needs attention">
            <ul className="issue-list">
              {issues.map((issue) => (
                <li key={issue.label}>
                  <span className={`dot ${issue.severity}`} />
                  <button className="issue" onClick={() => go(issue.page)}>
                    {issue.label}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div className="grid-even">
        <Card title="Top this week" description="Most viewed live items" flush>
          {data && data.top.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">This week</th>
                  <th className="num">All time</th>
                </tr>
              </thead>
              <tbody>
                {data.top.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="item-cell">
                        {item.thumb_path ? (
                          <img src={api.mediaUrl(item.thumb_path)} alt="" loading="lazy" />
                        ) : (
                          <div className="no-thumb" />
                        )}
                        <strong>{item.title}</strong>
                      </div>
                    </td>
                    <td className="num">{formatCount(item.week_views)}</td>
                    <td className="num">{formatCount(item.view_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <p className="muted">{data ? "Nothing is live yet." : "Loading..."}</p>
            </div>
          )}
        </Card>

        <Card title="Views by category" flush>
          {data && data.categories.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Items</th>
                  <th>Views</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((category) => (
                  <tr key={category.name}>
                    <td>
                      <strong>{category.name}</strong>
                    </td>
                    <td className="num">{category.items}</td>
                    <td>
                      <div className="meter-cell">
                        <div className="meter">
                          <div
                            style={{
                              width: `${(category.views / maxCategoryViews) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="num">{formatCount(category.views)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <p className="muted">{data ? "No categories yet." : "Loading..."}</p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid-even">
        <Card title="Top prompts" description="Most generated, all time" flush>
          {data && data.top_prompts.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Generated</th>
                  <th className="num">Copied</th>
                </tr>
              </thead>
              <tbody>
                {data.top_prompts.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="item-cell">
                        {item.thumb_path ? (
                          <img src={api.mediaUrl(item.thumb_path)} alt="" loading="lazy" />
                        ) : (
                          <div className="no-thumb" />
                        )}
                        <strong>{item.title}</strong>
                      </div>
                    </td>
                    <td className="num">{formatCount(item.generate_count)}</td>
                    <td className="num">{formatCount(item.copy_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <p className="muted">
                {data ? "No prompts generated yet." : "Loading..."}
              </p>
            </div>
          )}
        </Card>

        <Card
          title="Recently added"
          actions={
            <button className="text-link" onClick={() => go("library")}>
              Library
            </button>
          }
          flush
        >
          {data && data.recent.length > 0 ? (
            <table className="table">
              <tbody>
                {data.recent.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="item-cell">
                        {item.thumb_path ? (
                          <img src={api.mediaUrl(item.thumb_path)} alt="" loading="lazy" />
                        ) : (
                          <div className="no-thumb" />
                        )}
                        <strong>{item.title}</strong>
                      </div>
                    </td>
                    <td>
                      <span
                        className={
                          itemStatus(item) === "live"
                            ? "badge ok"
                            : itemStatus(item) === "scheduled"
                              ? "badge warn"
                              : "badge"
                        }
                      >
                        {STATUS_LABELS[itemStatus(item)]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <p className="muted">{data ? "Nothing yet." : "Loading..."}</p>
            </div>
          )}
        </Card>
      </div>

      <div className="section-gap">
        <Card title="Ad earnings">
          <div className="earnings">
            <span className="empty-icon">
              <Icon name="ads" size={20} />
            </span>
            <p className="muted">
              Earnings are kept in your AdMob account and are not shown here.
            </p>
            <a
              className="button"
              href="https://admob.google.com"
              target="_blank"
              rel="noreferrer"
            >
              Open AdMob
            </a>
          </div>
        </Card>
      </div>
    </>
  );
}
