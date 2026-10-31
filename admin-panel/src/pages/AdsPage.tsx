import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Page } from "../App";
import { Icon } from "../components/Icon";
import { Alert, Card, PageHeader, Toggle, useFeedback } from "../components/ui";
import type { AdConfig, Api } from "../lib/api";
import {
  AD_MINIMUMS,
  isValidUnitId,
  RECOMMENDED_AD_LIMITS,
} from "../lib/policy";

type BoolKey = {
  [K in keyof AdConfig]: AdConfig[K] extends boolean ? K : never;
}[keyof AdConfig];
type UnitKey =
  | "banner_unit_id"
  | "native_unit_id"
  | "interstitial_unit_id"
  | "app_open_unit_id";
type LimitKey = keyof typeof AD_MINIMUMS;

const UNITS: { enabled: BoolKey; unit: UnitKey; label: string }[] = [
  { enabled: "banner_enabled", unit: "banner_unit_id", label: "Banner" },
  { enabled: "native_enabled", unit: "native_unit_id", label: "Native" },
  { enabled: "interstitial_enabled", unit: "interstitial_unit_id", label: "Interstitial" },
  { enabled: "app_open_enabled", unit: "app_open_unit_id", label: "App open" },
];

const PLACEMENTS: {
  enabled: BoolKey;
  every: LimitKey;
  label: string;
  description: string;
  unit: string;
  risky?: boolean;
}[] = [
  {
    enabled: "generate_prompt_ad_enabled",
    every: "generate_prompt_every_n",
    label: "On Generate Prompt",
    description: "The ad shows, then the prompt appears when it closes.",
    unit: "taps",
    risky: true,
  },
  {
    enabled: "category_tap_ad_enabled",
    every: "category_tap_every_n",
    label: "On category taps",
    description: "When a category chip or category card is tapped.",
    unit: "taps",
    risky: true,
  },
  {
    enabled: "saved_tab_ad_enabled",
    every: "saved_tab_every_n",
    label: "On opening Saved",
    description: "About half a second after the Saved tab opens.",
    unit: "opens",
    risky: true,
  },
  {
    enabled: "back_to_list_ad_enabled",
    every: "back_to_list_every_n",
    label: "On returning to a list",
    description: "When leaving a video or image page.",
    unit: "items",
  },
];

const NUMBER_LABELS: Partial<Record<LimitKey, string>> = {
  interstitial_min_gap_sec: "Minimum gap between ads",
  interstitial_max_per_session: "Most ads per session",
  grace_period_sec: "No ads after install for",
  native_first_after_cards: "First ad after",
  native_every_n_cards: "Then one ad every",
  app_open_min_gap_hours: "Gap between ads",
};

/** Formats that are on but have no usable ID, so show nothing with live ads. */
function missingUnits(config: AdConfig): string[] {
  return UNITS.filter(
    (unit) => config[unit.enabled] && !isValidUnitId(config[unit.unit]),
  ).map((unit) => unit.label);
}

function FormatSection({
  label,
  description,
  checked,
  disabled,
  needsUnit,
  onChange,
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  needsUnit: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <section className={checked && !disabled ? "ad-format on" : "ad-format"}>
      <Toggle
        label={label}
        description={description}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {needsUnit && (
        <span className="badge fail">Needs a unit ID, so no ad shows</span>
      )}
      {checked && !disabled && children && (
        <div className="ad-format-body">{children}</div>
      )}
    </section>
  );
}

export function AdsPage({ api, go }: { api: Api; go: (page: Page) => void }) {
  const { toast, confirm } = useFeedback();
  const [config, setConfig] = useState<AdConfig | null>(null);
  const [saved, setSaved] = useState<AdConfig | null>(null);
  const [error, setError] = useState("");
  const [unitsOpen, setUnitsOpen] = useState(false);
  // Quick taps must reach the server in order, each building on the one before.
  const latest = useRef<AdConfig | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    api
      .getConfig("ads")
      .then((value) => {
        setConfig(value);
        setSaved(value);
        latest.current = value;
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  const change = <K extends keyof AdConfig>(key: K, value: AdConfig[K]) =>
    setConfig((current) => (current ? { ...current, [key]: value } : current));

  /** Saves only what changed: numbers and IDs still being typed are left alone. */
  const saveNow = (patch: Partial<AdConfig>, message: string) => {
    const before = latest.current;
    if (!before) return;
    const next = { ...before, ...patch };
    latest.current = next;
    setSaved(next);
    setConfig((current) => (current ? { ...current, ...patch } : current));
    setError("");
    queue.current = queue.current.then(async () => {
      try {
        await api.saveConfig("ads", next);
        toast(message);
      } catch (err) {
        setError(`Not saved: ${(err as Error).message}`);
        // Puts back only what this tap changed, keeping any later tap.
        const undo = Object.fromEntries(
          Object.keys(patch).map((key) => [key, before[key as keyof AdConfig]]),
        ) as Partial<AdConfig>;
        latest.current = { ...latest.current!, ...undo };
        setSaved(latest.current);
        setConfig((current) => (current ? { ...current, ...undo } : current));
      }
    });
  };

  const saveSwitch = (key: BoolKey, label: string, on: boolean) =>
    saveNow({ [key]: on }, `${label} is ${on ? "on" : "off"}. Phones get this on their next open, refresh, or return after 30 minutes.`);

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  const summary = useMemo(() => {
    if (!config) return [];
    if (!config.ads_enabled) return ["No ads are shown at all."];
    const lines: string[] = [];
    if (config.banner_enabled) lines.push("A banner stays at the bottom of the main screens.");
    if (config.native_enabled) {
      lines.push(`In lists, a native ad after ${config.native_first_after_cards} cards, then every ${config.native_every_n_cards}.`);
    }
    if (config.native_enabled && config.detail_native_ad_enabled) {
      lines.push("A native ad stays above Generate Prompt on every detail page.");
    }
    if (config.interstitial_enabled) {
      const on = PLACEMENTS.filter((placement) => config[placement.enabled]);
      for (const placement of on) {
        const every = config[placement.every];
        lines.push(
          every === 1
            ? `Full-screen ad ${placement.label.toLowerCase()}, each time.`
            : `Full-screen ad ${placement.label.toLowerCase()}, every ${every} ${placement.unit}.`,
        );
      }
      if (on.length) {
        lines.push(
          `Full-screen ads stay ${config.interstitial_min_gap_sec} seconds apart, at most ${config.interstitial_max_per_session} per session, and never more than one per two user actions.`,
        );
      }
    }
    if (config.app_open_enabled) {
      lines.push(`An app-open ad at most every ${config.app_open_min_gap_hours} hours.`);
    }
    return lines.length ? lines : ["Every ad type is off, so no ads are shown."];
  }, [config]);

  const useLiveAds = async () => {
    if (!saved) return;
    const missing = missingUnits(saved);
    if (missing.length) {
      setUnitsOpen(true);
      setError(
        `Add and save a unit ID for ${missing.join(", ")} first, or turn ${missing.length > 1 ? "those types" : "that type"} off.`,
      );
      return;
    }
    const ok = await confirm({
      title: "Switch to live ads?",
      message:
        "Real ads will start showing on every phone. Don't tap live ads on your own phones: AdMob can close an account for that.",
      confirmLabel: "Use live ads",
      danger: true,
    });
    if (ok) saveNow({ use_test_ads: false }, "Live ads are on.");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;
    const badUnits = UNITS.filter(
      (format) =>
        config[format.unit].trim() !== "" && !isValidUnitId(config[format.unit]),
    );
    if (badUnits.length) {
      setUnitsOpen(true);
      setError(`Check the unit ID for: ${badUnits.map((f) => f.label).join(", ")}.`);
      return;
    }
    const low = (Object.keys(AD_MINIMUMS) as LimitKey[]).find(
      (key) => !(config[key] >= AD_MINIMUMS[key]),
    );
    if (low) {
      const placement = PLACEMENTS.find((item) => item.every === low);
      const label = placement ? `${placement.label}, show every` : NUMBER_LABELS[low];
      setError(`"${label}" must be at least ${AD_MINIMUMS[low]}.`);
      return;
    }
    const patch = Object.fromEntries(
      Object.entries(config).filter(
        ([key, value]) => value !== saved?.[key as keyof AdConfig],
      ),
    ) as Partial<AdConfig>;
    saveNow(patch, "Saved. Phones get this on their next open, refresh, or return after 30 minutes.");
  };

  const number = (key: LimitKey, label: string, unit: string, hint?: string) => (
    <label className="ad-number" key={key}>
      <span>
        {label}
        {hint && <small className="muted"> {hint}</small>}
      </span>
      <span className="unit-input">
        <input
          type="number"
          required
          min={AD_MINIMUMS[key]}
          step={1}
          aria-label={label}
          value={config && !Number.isNaN(config[key]) ? config[key] : ""}
          onChange={(e) => change(key, e.target.valueAsNumber)}
        />
        <span className="muted small">{unit}</span>
      </span>
    </label>
  );

  const live = config ? !config.use_test_ads : false;
  const allOn = config?.ads_enabled ?? false;
  const filled = config
    ? UNITS.filter((unit) => isValidUnitId(config[unit.unit])).length
    : 0;
  const needsUnit = (key: BoolKey, unit: UnitKey) =>
    Boolean(config && live && allOn && config[key] && !isValidUnitId(config[unit]));

  return (
    <>
      <PageHeader
        title="Ad controls"
        description="Turn ads on or off and set how often they appear, with no app update."
        actions={
          <button className="button" type="button" onClick={() => go("policy")}>
            <Icon name="shield" size={16} />
            Policy check
          </button>
        }
      />

      {error && <Alert kind="error">{error}</Alert>}
      {!config && !error && <p className="muted">Loading...</p>}

      {config && (
        <form onSubmit={submit} className="stack">
          <section className={allOn ? "ad-hero on" : "ad-hero off"}>
            <div className="ad-hero-main">
              <span className="ad-hero-state">
                <span className="ad-hero-dot" aria-hidden="true" />
                {allOn ? "Ads are on" : "All ads are off"}
              </span>
              <p className="muted small">
                Changes reach phones on their next open, refresh, or return after
                30 minutes.
              </p>
            </div>
            <button
              type="button"
              className={allOn ? "button danger" : "button primary"}
              onClick={() =>
                saveNow(
                  { ads_enabled: !allOn },
                  `All ads are ${allOn ? "off" : "on"}. Phones get this on their next open, refresh, or return after 30 minutes.`,
                )
              }
            >
              <Icon name="ads" size={16} />
              {allOn ? "Turn all ads off" : "Turn all ads on"}
            </button>

            <div className="ad-hero-mode">
              <div>
                <span className="toggle-label">Which ads</span>
                <p className="muted small">
                  {live
                    ? "Real ads from your AdMob account. These earn money."
                    : "Google's sample ads, safe to tap. These earn nothing."}
                </p>
              </div>
              <div className="segmented" role="group" aria-label="Which ads">
                <button
                  type="button"
                  className={live ? "" : "on"}
                  aria-pressed={!live}
                  onClick={() => saveNow({ use_test_ads: true }, "Test ads are on.")}
                >
                  Test ads
                </button>
                <button
                  type="button"
                  className={live ? "on" : ""}
                  aria-pressed={live}
                  onClick={() => {
                    if (!live) void useLiveAds();
                  }}
                >
                  Live ads
                </button>
              </div>
            </div>
          </section>

          <div className="ads-layout">
            <div className="stack">
              <Card
                title="Ad types"
                description="Each switch saves as soon as you tap it."
              >
                <div className="ad-format-list">
                  <FormatSection
                    label="Banner"
                    description="A strip at the bottom of Home, Trending, category and detail screens."
                    checked={config.banner_enabled}
                    disabled={!allOn}
                    needsUnit={needsUnit("banner_enabled", "banner_unit_id")}
                    onChange={(on) => saveSwitch("banner_enabled", "Banner", on)}
                  />

                  <FormatSection
                    label="Native"
                    description="Shaped like a card, always labeled as an ad."
                    checked={config.native_enabled}
                    disabled={!allOn}
                    needsUnit={needsUnit("native_enabled", "native_unit_id")}
                    onChange={(on) => saveSwitch("native_enabled", "Native", on)}
                  >
                    <Toggle
                      label="Above Generate Prompt"
                      description="Stays on the detail page, before and after the prompt appears."
                      checked={config.detail_native_ad_enabled}
                      onChange={(on) =>
                        saveSwitch("detail_native_ad_enabled", "Native above Generate Prompt", on)
                      }
                    />
                    <div className="ad-numbers">
                      {number("native_first_after_cards", NUMBER_LABELS.native_first_after_cards!, "cards", "in lists")}
                      {number("native_every_n_cards", NUMBER_LABELS.native_every_n_cards!, "cards")}
                    </div>
                  </FormatSection>

                  <FormatSection
                    label="Interstitial"
                    description="Full screen. Choose where below."
                    checked={config.interstitial_enabled}
                    disabled={!allOn}
                    needsUnit={needsUnit("interstitial_enabled", "interstitial_unit_id")}
                    onChange={(on) => saveSwitch("interstitial_enabled", "Interstitial", on)}
                  >
                    {PLACEMENTS.map((placement) => (
                      <div className="ad-placement" key={placement.label}>
                        <Toggle
                          label={placement.label}
                          description={placement.description}
                          checked={config[placement.enabled]}
                          onChange={(on) =>
                            saveSwitch(placement.enabled, `Full-screen ad ${placement.label.toLowerCase()}`, on)
                          }
                        />
                        {config[placement.enabled] && (
                          <div className="ad-placement-foot">
                            {number(placement.every, `${placement.label}, show every`, placement.unit)}
                            {placement.risky && (
                              <button
                                type="button"
                                className="badge warn ad-risk"
                                onClick={() => go("policy")}
                              >
                                Policy risk
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="ad-numbers">
                      {number("interstitial_min_gap_sec", NUMBER_LABELS.interstitial_min_gap_sec!, "seconds")}
                      {number("interstitial_max_per_session", NUMBER_LABELS.interstitial_max_per_session!, "ads")}
                      {number("grace_period_sec", NUMBER_LABELS.grace_period_sec!, "seconds")}
                    </div>
                  </FormatSection>

                  <FormatSection
                    label="App open"
                    description="When the app opens, never in the first session."
                    checked={config.app_open_enabled}
                    disabled={!allOn}
                    needsUnit={needsUnit("app_open_enabled", "app_open_unit_id")}
                    onChange={(on) => saveSwitch("app_open_enabled", "App open", on)}
                  >
                    <div className="ad-numbers">
                      {number("app_open_min_gap_hours", NUMBER_LABELS.app_open_min_gap_hours!, "hours")}
                    </div>
                  </FormatSection>
                </div>
                <button
                  type="button"
                  className="button small ad-recommended"
                  onClick={() =>
                    setConfig((current) =>
                      current ? { ...current, ...RECOMMENDED_AD_LIMITS } : current,
                    )
                  }
                >
                  Use recommended numbers
                </button>
              </Card>

              <details
                className="card ad-units"
                open={unitsOpen}
                onToggle={(e) => setUnitsOpen(e.currentTarget.open)}
              >
                <summary>
                  <span>
                    <span className="toggle-label">AdMob unit IDs</span>
                    <span className="muted small">
                      {" "}
                      {filled} of {UNITS.length} added.{" "}
                      {live ? "Used by live ads." : "Not needed for test ads."}
                    </span>
                  </span>
                </summary>
                <div className="card-body form-grid">
                  {UNITS.map((format) => {
                    const value = config[format.unit];
                    const invalid = value.trim() !== "" && !isValidUnitId(value);
                    return (
                      <label className="field" key={format.unit}>
                        <span>{format.label}</span>
                        <input
                          value={value}
                          placeholder="ca-app-pub-0000000000000000/0000000000"
                          spellCheck={false}
                          aria-invalid={invalid}
                          onChange={(e) => change(format.unit, e.target.value)}
                        />
                        {invalid && (
                          <small className="field-error">
                            This does not look like an ad unit ID.
                          </small>
                        )}
                      </label>
                    );
                  })}
                </div>
              </details>
            </div>

            <aside className="side-panel stack">
              <Card title="What users will see">
                <ul className="summary-list">
                  {summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Card>
              <Card title="Checking on a phone">
                <ol className="ad-steps muted small">
                  <li>Change a switch here.</li>
                  <li>Close the app fully and open it again.</li>
                  <li>
                    A full-screen ad may not come at once: none for{" "}
                    {config.grace_period_sec} seconds after install, then{" "}
                    {config.interstitial_min_gap_sec} seconds apart and two user
                    actions per ad.
                  </li>
                  <li>App-open ads skip the first session.</li>
                </ol>
              </Card>
            </aside>
          </div>

          {dirty && (
            <div className="save-bar">
              <span className="muted small">Numbers or unit IDs not saved yet.</span>
              <button
                className="button"
                type="button"
                onClick={() => {
                  setConfig(saved);
                  setError("");
                }}
              >
                Discard
              </button>
              <button className="button primary">Save changes</button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
