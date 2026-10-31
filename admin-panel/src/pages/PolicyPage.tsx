import { useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import { Icon } from "../components/Icon";
import { Alert, Card, PageHeader, useFeedback } from "../components/ui";
import type { AdConfig, Api, AppSettings, ChecklistState } from "../lib/api";
import { CHECKLIST, runPolicyChecks, type CheckStatus } from "../lib/policy";

const STATUS: Record<CheckStatus, { label: string; icon: "check" | "warn" | "error" }> = {
  pass: { label: "OK", icon: "check" },
  warn: { label: "Review", icon: "warn" },
  fail: { label: "Fix", icon: "error" },
};

const LINKS = [
  {
    label: "Google Play ads policy",
    href: "https://support.google.com/googleplay/android-developer/answer/9857753",
  },
  {
    label: "AdMob program policies",
    href: "https://support.google.com/admob/answer/6128543",
  },
  {
    label: "Disallowed interstitial ads",
    href: "https://support.google.com/admob/answer/6201362",
  },
  {
    label: "Google Play user data policy",
    href: "https://support.google.com/googleplay/android-developer/answer/10144311",
  },
];

export function PolicyPage({ api, go }: { api: Api; go: (page: Page) => void }) {
  const { toast } = useFeedback();
  const [ads, setAds] = useState<AdConfig | null>(null);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [list, setList] = useState<ChecklistState>({});
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api.getConfig("ads"),
      api.getConfig("app"),
      api.getConfig("launch_checklist"),
    ])
      .then(([adConfig, appSettings, checklist]) => {
        setAds(adConfig);
        setApp(appSettings);
        setList(checklist);
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  const checks = useMemo(
    () => (ads && app ? runPolicyChecks(ads, app) : []),
    [ads, app],
  );
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const manualDone = CHECKLIST.filter((item) => list[item.id]).length;
  const ready = ads && app && fails === 0 && manualDone === CHECKLIST.length;

  const toggle = async (id: string, value: boolean) => {
    const previous = list;
    const next = { ...list, [id]: value };
    setList(next);
    try {
      await api.saveConfig("launch_checklist", next);
    } catch (err) {
      setList(previous);
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <PageHeader
        title="Policy check"
        description="Compares your saved settings with Google's ad rules and store requirements."
      />

      <Alert kind="info">
        This is a helper, not an approval. Google makes the final decision and its
        policies change, so read the links below before each release.
      </Alert>

      {error && <Alert kind="error">{error}</Alert>}

      {ads && app && (
        <div className="stats three">
          <div className="stat">
            <span className="stat-label">Must fix</span>
            <div className="stat-value">{fails}</div>
            <div className="stat-note">Fix these before releasing</div>
          </div>
          <div className="stat">
            <span className="stat-label">To review</span>
            <div className="stat-value">{warns}</div>
            <div className="stat-note">Recommended changes</div>
          </div>
          <div className="stat">
            <span className="stat-label">Launch checklist</span>
            <div className="stat-value">
              {manualDone}/{CHECKLIST.length}
            </div>
            <div className="meter wide" aria-hidden="true">
              <div style={{ width: `${(manualDone / CHECKLIST.length) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {ready && (
        <Alert kind="ok">
          No problems found and the checklist is complete. Read Google's policies one
          last time before you release.
        </Alert>
      )}

      <div className="stack">
        <Card
          title="Automatic checks"
          description="Updated from your Ad controls and App settings."
          flush
        >
          <ul className="check-list">
            {checks.map((check) => (
              <li key={check.id}>
                <span className={`status-icon ${check.status}`}>
                  <Icon name={STATUS[check.status].icon} size={14} />
                </span>
                <div>
                  <strong>{check.title}</strong>
                  <p className="muted small">{check.detail}</p>
                </div>
                {check.status !== "pass" && check.fix && (
                  <button
                    className="button small"
                    onClick={() => go(check.fix === "ads" ? "ads" : "settings")}
                  >
                    {check.fix === "ads" ? "Ad controls" : "App settings"}
                  </button>
                )}
                <span className={`badge ${check.status === "pass" ? "ok" : check.status}`}>
                  {STATUS[check.status].label}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="Launch checklist"
          description="These cannot be checked automatically. Tick each one when you have confirmed it."
          flush
        >
          <ul className="check-list">
            {CHECKLIST.map((item) => (
              <li key={item.id}>
                <input
                  type="checkbox"
                  id={`check-${item.id}`}
                  checked={Boolean(list[item.id])}
                  onChange={(e) => void toggle(item.id, e.target.checked)}
                />
                <label htmlFor={`check-${item.id}`}>
                  <strong>{item.title}</strong>
                  <span className="muted small">{item.detail}</span>
                </label>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Google's policies">
          <ul className="link-list">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
