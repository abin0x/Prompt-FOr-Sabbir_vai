import { describe, expect, it } from "vitest";
import type { AdConfig, AppSettings } from "./api";
import {
  isValidUnitId,
  isValidUrl,
  RECOMMENDED_AD_LIMITS,
  runPolicyChecks,
  scanContent,
} from "./policy";

const unit = "ca-app-pub-1234567890123456/1234567890";

const ads: AdConfig = {
  ads_enabled: true,
  use_test_ads: false,
  banner_enabled: true,
  native_enabled: true,
  interstitial_enabled: true,
  app_open_enabled: true,
  back_to_list_ad_enabled: true,
  generate_prompt_ad_enabled: false,
  category_tap_ad_enabled: false,
  saved_tab_ad_enabled: false,
  detail_native_ad_enabled: false,
  banner_unit_id: unit,
  native_unit_id: unit,
  interstitial_unit_id: unit,
  app_open_unit_id: unit,
  ...RECOMMENDED_AD_LIMITS,
};

const app: AppSettings = {
  maintenance_mode: false,
  maintenance_message: "",
  announcement_enabled: false,
  announcement_text: "",
  announcement_url: "",
  home_subtitle: "",
  default_home_view: "all",
  onboarding: [],
  media_base_url: "https://media.promptlab.app",
  min_supported_version: "",
  latest_version: "",
  store_url: "",
  privacy_url: "https://promptlab.app/privacy",
  terms_url: "https://promptlab.app/terms",
  support_email: "help@promptlab.app",
};

const status = (a: AdConfig, s: AppSettings, id: string) =>
  runPolicyChecks(a, s).find((c) => c.id === id)?.status;

describe("runPolicyChecks", () => {
  it("warns about each risky placement, until it is turned off", () => {
    const onTap = { ...ads, generate_prompt_ad_enabled: true };
    expect(status(onTap, app, "tap-ads")).toBe("warn");
    expect(status({ ...onTap, ads_enabled: false }, app, "tap-ads")).toBe("pass");
    expect(status({ ...onTap, interstitial_enabled: false }, app, "tap-ads")).toBe("pass");
    expect(status({ ...ads, category_tap_ad_enabled: true }, app, "tap-ads")).toBe("warn");
    expect(status({ ...ads, saved_tab_ad_enabled: true }, app, "saved-ad")).toBe("warn");
    expect(status({ ...ads, detail_native_ad_enabled: true }, app, "detail-native")).toBe("warn");
  });

  it("warns until the media address is a real domain", () => {
    expect(status(ads, { ...app, media_base_url: "" }, "media-address")).toBe("warn");
    expect(
      status(ads, { ...app, media_base_url: "https://pub-1.r2.dev" }, "media-address"),
    ).toBe("warn");
  });

  it("the recommended settings pass everything", () => {
    expect(runPolicyChecks(ads, app).filter((c) => c.status !== "pass")).toEqual([]);
  });

  it("fails an ad after nearly every item", () => {
    expect(status({ ...ads, back_to_list_every_n: 1 }, app, "back-frequency")).toBe("fail");
  });

  it("fails live ads with a missing unit ID, but not a disabled format", () => {
    const missing = { ...ads, native_unit_id: "" };
    expect(status(missing, app, "ad-mode")).toBe("fail");
    expect(status({ ...missing, native_enabled: false }, app, "ad-mode")).toBe("pass");
  });

  it("warns, not fails, while test ads are on", () => {
    expect(status({ ...ads, use_test_ads: true, banner_unit_id: "" }, app, "ad-mode")).toBe("warn");
  });

  it("fails without a privacy policy", () => {
    expect(status(ads, { ...app, privacy_url: "" }, "privacy")).toBe("fail");
    expect(status(ads, { ...app, privacy_url: "http://x.com" }, "privacy")).toBe("fail");
  });

  it("warns on aggressive frequency", () => {
    expect(status({ ...ads, interstitial_min_gap_sec: 30 }, app, "gap")).toBe("warn");
    expect(status({ ...ads, interstitial_max_per_session: 20 }, app, "session-cap")).toBe("warn");
    expect(status({ ...ads, native_every_n_cards: 2 }, app, "native-density")).toBe("warn");
  });
});

describe("validators", () => {
  it("checks AdMob unit IDs", () => {
    expect(isValidUnitId(unit)).toBe(true);
    expect(isValidUnitId("ca-app-pub-1234567890123456~1234567890")).toBe(false);
    expect(isValidUnitId("")).toBe(false);
  });

  it("requires https links", () => {
    expect(isValidUrl("https://a.com")).toBe(true);
    expect(isValidUrl("http://a.com")).toBe(false);
    expect(isValidUrl("nope")).toBe(false);
  });
});

describe("scanContent", () => {
  it("passes ordinary prompts", () => {
    expect(scanContent("Cinematic portrait, golden light, slow push-in, 4K")).toEqual([]);
    expect(scanContent("Happy baby in a bear hoodie laughing")).toEqual([]);
  });

  it("flags risky words", () => {
    expect(scanContent("nude portrait")).toContain("sexual content");
    expect(scanContent("gory battle scene")).toContain("violence");
    expect(scanContent("Spider-Man on a roof")).toContain("a brand, character or real person");
  });

  it("flags children combined with sexual words, in either order", () => {
    expect(scanContent("baby in a bikini")).toContain("content that may harm children");
    expect(scanContent("sexy teen")).toContain("content that may harm children");
  });
});
