import { useEffect, useState, type FormEvent } from "react";
import { Alert, Card, PageHeader, Toggle, useFeedback } from "../components/ui";
import type { Api, AppSettings, HomeView, OnboardingSlide } from "../lib/api";
import { isValidUrl } from "../lib/policy";

const VERSION = /^\d+\.\d+\.\d+$/;

type TextKey = Exclude<
  keyof AppSettings,
  "maintenance_mode" | "announcement_enabled" | "onboarding" | "default_home_view"
>;

const HOME_VIEWS: { value: HomeView; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "video", label: "Videos" },
  { value: "image", label: "Images" },
];

/** What the app shows while a field is blank. */
const ONBOARDING_DEFAULTS: OnboardingSlide[] = [
  {
    title: "Discover AI videos & images",
    body: "Browse short videos and images made with AI, all in one place.",
  },
  {
    title: "See the prompt behind it",
    body: "Tap Generate Prompt and watch the exact prompt appear.",
  },
  {
    title: "Copy it. Create yours.",
    body: "Copy the prompt in one tap and use it in your favorite AI tool.",
  },
];
const HOME_SUBTITLE_DEFAULT = "Explore AI prompts, image prompts and videos";

export function AppSettingsPage({ api }: { api: Api }) {
  const { toast, confirm } = useFeedback();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getConfig("app")
      .then((value) => {
        setSettings(value);
        setSaved(value);
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  const text = (key: TextKey, label: string, hint: string, placeholder = "") =>
    settings && (
      <label className="field">
        <span>{label}</span>
        <input
          value={settings[key]}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
        />
        {hint && <small className="muted">{hint}</small>}
      </label>
    );

  const setSlide = (index: number, change: Partial<OnboardingSlide>) =>
    settings &&
    setSettings({
      ...settings,
      onboarding: ONBOARDING_DEFAULTS.map((_, i) => ({
        title: settings.onboarding[i]?.title ?? "",
        body: settings.onboarding[i]?.body ?? "",
        ...(i === index ? change : {}),
      })),
    });

  const problem = (value: AppSettings): string | null => {
    for (const [name, url] of [
      ["Privacy policy", value.privacy_url],
      ["Terms of use", value.terms_url],
      ["Store", value.store_url],
      ["Announcement", value.announcement_url],
      ["Media address", value.media_base_url],
    ]) {
      if (url.trim() && !isValidUrl(url.trim())) {
        return `${name} link must start with https://`;
      }
    }
    for (const [name, version] of [
      ["Latest version", value.latest_version],
      ["Minimum version", value.min_supported_version],
    ]) {
      if (version.trim() && !VERSION.test(version.trim())) {
        return `${name} must look like 1.0.0`;
      }
    }
    if (value.support_email.trim() && !value.support_email.includes("@")) {
      return "Support email is not valid.";
    }
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const issue = problem(settings);
    if (issue) {
      setError(issue);
      return;
    }
    if (settings.maintenance_mode && !saved?.maintenance_mode) {
      const ok = await confirm({
        title: "Turn on maintenance mode?",
        message: "Users will see the message below and cannot use the app until you turn this off.",
        confirmLabel: "Turn on",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveConfig("app", settings);
      setSaved(settings);
      toast("Settings saved. Users get them on their next open, refresh, or return after 30 minutes.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="App settings"
        description="Control the live app without publishing an update."
      />

      {error && <Alert kind="error">{error}</Alert>}
      {!settings && !error && <p className="muted">Loading...</p>}

      {settings && (
        <form className="stack" onSubmit={submit}>
          <Card title="Availability">
            <Toggle
              label="Maintenance mode"
              description="Replaces the app with the message below for all users."
              checked={settings.maintenance_mode}
              onChange={(value) =>
                setSettings({ ...settings, maintenance_mode: value })
              }
            />
            <label className="field top-gap">
              <span>Maintenance message</span>
              <textarea
                rows={2}
                maxLength={200}
                value={settings.maintenance_message}
                onChange={(e) =>
                  setSettings({ ...settings, maintenance_message: e.target.value })
                }
              />
            </label>
          </Card>

          <Card title="Announcement" description="A short message at the top of Home.">
            <Toggle
              label="Show announcement"
              checked={settings.announcement_enabled}
              onChange={(value) =>
                setSettings({ ...settings, announcement_enabled: value })
              }
            />
            <label className="field top-gap">
              <span>Announcement text</span>
              <input
                maxLength={120}
                value={settings.announcement_text}
                placeholder="New videos every week!"
                onChange={(e) =>
                  setSettings({ ...settings, announcement_text: e.target.value })
                }
              />
            </label>
            <div className="top-gap">
              {text(
                "announcement_url",
                "Announcement link",
                "Optional. Tapping the announcement opens this.",
                "https://...",
              )}
            </div>
          </Card>

          <Card title="Home screen">
            <div className="form-grid">
              <label className="field">
                <span>Subtitle</span>
                <input
                  maxLength={80}
                  value={settings.home_subtitle}
                  placeholder={HOME_SUBTITLE_DEFAULT}
                  onChange={(e) =>
                    setSettings({ ...settings, home_subtitle: e.target.value })
                  }
                />
                <small className="muted">Under the app name. Blank keeps the text shown here.</small>
              </label>
              <div className="field">
                <span>First view</span>
                <div className="segmented wide" role="group" aria-label="First view">
                  {HOME_VIEWS.map((view) => (
                    <button
                      key={view.value}
                      type="button"
                      className={settings.default_home_view === view.value ? "on" : ""}
                      aria-pressed={settings.default_home_view === view.value}
                      onClick={() =>
                        setSettings({ ...settings, default_home_view: view.value })
                      }
                    >
                      {view.label}
                    </button>
                  ))}
                </div>
                <small className="muted">What Home shows when the app opens.</small>
              </div>
            </div>
            <p className="muted small top-gap">
              To change the order of the category chips, use the arrows on the
              Categories page.
            </p>
          </Card>

          <Card
            title="Onboarding text"
            description="Shown once, the first time someone opens the app. Blank keeps the text shown here."
          >
            <div className="stack">
              {ONBOARDING_DEFAULTS.map((slide, index) => (
                <div className="form-grid" key={slide.title}>
                  <label className="field">
                    <span>Slide {index + 1} title</span>
                    <input
                      maxLength={40}
                      value={settings.onboarding[index]?.title ?? ""}
                      placeholder={slide.title}
                      onChange={(e) => setSlide(index, { title: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Slide {index + 1} text</span>
                    <input
                      maxLength={100}
                      value={settings.onboarding[index]?.body ?? ""}
                      placeholder={slide.body}
                      onChange={(e) => setSlide(index, { body: e.target.value })}
                    />
                  </label>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Media address"
            description="Where the app loads videos and images from. Connect your own domain to the R2 bucket, then enter it here: no app update is needed."
          >
            {text(
              "media_base_url",
              "Media address",
              "Blank keeps the current test address, which Cloudflare rate limits. It must serve the same files, or nothing will load.",
              "https://media.yourdomain.com",
            )}
          </Card>

          <Card title="App updates">
            <div className="form-grid">
              {text(
                "latest_version",
                "Latest version",
                "Older versions are invited to update.",
                "1.0.0",
              )}
              {text(
                "min_supported_version",
                "Minimum version",
                "Older versions must update before they can continue.",
                "1.0.0",
              )}
              {text("store_url", "Store link", "Where the update button goes.", "https://play.google.com/...")}
            </div>
          </Card>

          <Card title="Links and contact" description="Shown in the app's Settings screen.">
            <div className="form-grid">
              {text("privacy_url", "Privacy policy link", "Required by Google Play.", "https://...")}
              {text("terms_url", "Terms of use link", "", "https://...")}
              {text("support_email", "Support email", "", "support@...")}
            </div>
          </Card>

          <div className="save-bar">
            <span className="muted small">
              {dirty ? "You have unsaved changes." : "All changes saved."}
            </span>
            <button className="button primary" disabled={busy || !dirty}>
              {busy ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
