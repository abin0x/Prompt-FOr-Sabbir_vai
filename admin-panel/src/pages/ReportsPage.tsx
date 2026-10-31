import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Alert, Card, PageHeader, useFeedback } from "../components/ui";
import type { Api, ContentReport, ReportReason } from "../lib/api";

const REASONS: Record<ReportReason, string> = {
  sexual: "Sexual content",
  violence: "Violence",
  child_safety: "Child safety",
  copyright: "Copyright",
  other: "Other",
};

export function ReportsPage({
  api,
  onChanged,
}: {
  api: Api;
  onChanged: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReports(await api.listReports(status));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      toast(message);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hide = async (report: ContentReport) => {
    const ok = await confirm({
      title: `Hide "${report.video?.title ?? "this item"}"?`,
      message: "It leaves the app right away, and this report is closed. You can publish it again from the Library.",
      confirmLabel: "Hide and close",
      danger: true,
    });
    if (!ok) return;
    void run(async () => {
      await api.setPublished([report.video_id], false);
      await api.setReportStatus(report.id, "resolved");
    }, "Item hidden and report closed.");
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description="Content that users flagged from the app. Reviewing these quickly helps protect your AdMob and Google Play accounts."
      />

      {error && <Alert kind="error">{error}</Alert>}

      <Card flush>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Report status">
            {(["open", "resolved"] as const).map((value) => (
              <button
                key={value}
                className={status === value ? "on" : ""}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {value === "open" ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        </div>

        {reports.length > 0 && (
          <ul className="report-list" aria-busy={loading}>
            {reports.map((report) => (
              <li key={report.id}>
                {report.video?.thumb_path ? (
                  <img src={api.mediaUrl(report.video.thumb_path)} alt="" loading="lazy" />
                ) : (
                  <div className="no-thumb" />
                )}
                <div className="report-body">
                  <div className="report-title">
                    <strong>{report.video?.title ?? "Deleted item"}</strong>
                    <span className="badge fail">{REASONS[report.reason]}</span>
                    {report.video && !report.video.is_published && (
                      <span className="badge">Hidden</span>
                    )}
                  </div>
                  {report.note && <p>{report.note}</p>}
                  <span className="muted small">
                    {new Date(report.created_at).toLocaleString("en", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </div>
                <div className="report-actions">
                  {status === "open" ? (
                    <>
                      {report.video?.is_published && (
                        <button
                          className="button small danger"
                          disabled={busy}
                          onClick={() => void hide(report)}
                        >
                          Hide item
                        </button>
                      )}
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api.setReportStatus(report.id, "resolved"),
                            "Report closed.",
                          )
                        }
                      >
                        Close report
                      </button>
                    </>
                  ) : (
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.setReportStatus(report.id, "open"),
                          "Report reopened.",
                        )
                      }
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!loading && reports.length === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <Icon name={status === "open" ? "check" : "flag"} size={20} />
            </span>
            <p className="muted">
              {status === "open" ? "No open reports." : "No closed reports yet."}
            </p>
          </div>
        )}
      </Card>
    </>
  );
}
