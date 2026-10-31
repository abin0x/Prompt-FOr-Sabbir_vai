import type { AdConfig, AppSettings } from "./api";

export type CheckStatus = "pass" | "warn" | "fail";

export interface PolicyCheck {
  id: string;
  title: string;
  detail: string;
  status: CheckStatus;
  /** Which page fixes this. */
  fix?: "ads" | "settings";
}

/** Lowest values the form accepts, so the safe range cannot be left by accident. */
export const AD_MINIMUMS = {
  generate_prompt_every_n: 1,
  category_tap_every_n: 1,
  saved_tab_every_n: 1,
  back_to_list_every_n: 3,
  interstitial_min_gap_sec: 30,
  native_every_n_cards: 4,
  app_open_min_gap_hours: 4,
  native_first_after_cards: 2,
  grace_period_sec: 0,
  interstitial_max_per_session: 0,
} as const;

/** Settings that pass every check, used by the "Recommended" button. */
export const RECOMMENDED_AD_LIMITS = {
  generate_prompt_every_n: 1,
  category_tap_every_n: 1,
  saved_tab_every_n: 1,
  back_to_list_every_n: 3,
  interstitial_min_gap_sec: 90,
  interstitial_max_per_session: 4,
  app_open_min_gap_hours: 4,
  native_first_after_cards: 4,
  native_every_n_cards: 6,
  grace_period_sec: 60,
} as const;

const UNIT_ID = /^ca-app-pub-\d{16}\/\d{10}$/;

export function isValidUnitId(id: string): boolean {
  return UNIT_ID.test(id.trim());
}

export function isValidUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Reads the saved settings and reports what needs attention. */
export function runPolicyChecks(ads: AdConfig, app: AppSettings): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  const add = (check: PolicyCheck) => checks.push(check);

  const interstitials = ads.ads_enabled && ads.interstitial_enabled;
  const tapAds = [
    ads.generate_prompt_ad_enabled ? "Generate Prompt" : "",
    ads.category_tap_ad_enabled ? "category taps" : "",
  ].filter(Boolean);
  add({
    id: "tap-ads",
    title: "Full-screen ads right after a tap",
    status: interstitials && tapAds.length ? "warn" : "pass",
    fix: "ads",
    detail:
      interstitials && tapAds.length
        ? `On for ${tapAds.join(" and ")}. Google Play lists an ad "after a user has clicked on a button, and before the action intended by the button click has taken effect" as a violation. This can lead to rejection or limited ads.`
        : "None. Full-screen ads do not interrupt a button's action.",
  });

  add({
    id: "saved-ad",
    title: "Full-screen ad when opening Saved",
    status: interstitials && ads.saved_tab_ad_enabled ? "warn" : "pass",
    fix: "ads",
    detail:
      interstitials && ads.saved_tab_ad_enabled
        ? "On. AdMob lists an interstitial that appears just after a page has loaded as disallowed."
        : "Off.",
  });

  add({
    id: "detail-native",
    title: "Native ad above Generate Prompt",
    status: ads.ads_enabled && ads.native_enabled && ads.detail_native_ad_enabled ? "warn" : "pass",
    fix: "ads",
    detail:
      ads.ads_enabled && ads.native_enabled && ads.detail_native_ad_enabled
        ? "On. An ad right above a button can draw accidental clicks, which AdMob treats as invalid traffic."
        : "Off.",
  });

  add({
    id: "back-frequency",
    title: "Full-screen ads at natural breaks",
    status: ads.back_to_list_every_n < AD_MINIMUMS.back_to_list_every_n ? "fail" : "pass",
    fix: "ads",
    detail:
      ads.back_to_list_every_n < AD_MINIMUMS.back_to_list_every_n
        ? "Google says to avoid an ad after every action. Use every 3 items or more."
        : `Shown when returning to a list, after every ${ads.back_to_list_every_n} items.`,
  });

  add({
    id: "gap",
    title: "Time between full-screen ads",
    status: ads.interstitial_min_gap_sec < 60 ? "warn" : "pass",
    fix: "ads",
    detail:
      ads.interstitial_min_gap_sec < 60
        ? `${ads.interstitial_min_gap_sec} seconds is short. Our recommendation, not a Google rule: 60 seconds or more.`
        : `${ads.interstitial_min_gap_sec} seconds between ads.`,
  });

  add({
    id: "session-cap",
    title: "Full-screen ads per session",
    status: ads.interstitial_max_per_session > 10 ? "warn" : "pass",
    fix: "ads",
    detail:
      ads.interstitial_max_per_session > 10
        ? `${ads.interstitial_max_per_session} is high. Repeated ads can count as "made for ads" under Google Play's rules.`
        : `At most ${ads.interstitial_max_per_session} per session.`,
  });

  add({
    id: "native-density",
    title: "Native ad density",
    status: ads.native_every_n_cards < AD_MINIMUMS.native_every_n_cards ? "warn" : "pass",
    fix: "ads",
    detail:
      ads.native_every_n_cards < AD_MINIMUMS.native_every_n_cards
        ? `An ad every ${ads.native_every_n_cards} cards crowds the list. We recommend every 4 or more.`
        : `One native ad every ${ads.native_every_n_cards} cards, always labeled "Ad".`,
  });

  add({
    id: "app-open",
    title: "App-open ad timing",
    status: ads.app_open_min_gap_hours < AD_MINIMUMS.app_open_min_gap_hours ? "warn" : "pass",
    fix: "ads",
    detail:
      ads.app_open_min_gap_hours < AD_MINIMUMS.app_open_min_gap_hours
        ? `Every ${ads.app_open_min_gap_hours} hours is frequent. We recommend 4 or more.`
        : `At most one every ${ads.app_open_min_gap_hours} hours, never in the first session.`,
  });

  const slots: [boolean, string, string][] = [
    [ads.banner_enabled, "Banner", ads.banner_unit_id],
    [ads.native_enabled, "Native", ads.native_unit_id],
    [ads.interstitial_enabled, "Interstitial", ads.interstitial_unit_id],
    [ads.app_open_enabled, "App open", ads.app_open_unit_id],
  ];
  const invalid = slots
    .filter(([on, , id]) => on && !isValidUnitId(id))
    .map(([, name]) => name);
  if (ads.use_test_ads) {
    add({
      id: "ad-mode",
      title: "Test ads are on",
      status: "warn",
      fix: "ads",
      detail:
        "Correct while building, because clicking your own live ads can get an AdMob account closed. Test ads earn nothing, so turn this off for the store release.",
    });
  } else {
    add({
      id: "ad-mode",
      title: "Live ad unit IDs",
      status: invalid.length ? "fail" : "pass",
      fix: "ads",
      detail: invalid.length
        ? `Live ads are on, but these have no valid unit ID: ${invalid.join(", ")}.`
        : "Live ads are on and every enabled format has a unit ID.",
    });
  }

  add({
    id: "media-address",
    title: "Media address",
    status: app.media_base_url.trim() && !app.media_base_url.includes("r2.dev") ? "pass" : "warn",
    fix: "settings",
    detail:
      app.media_base_url.trim() && !app.media_base_url.includes("r2.dev")
        ? "Using your own domain."
        : "Still the r2.dev test address, which Cloudflare rate limits. Connect your own domain before launch.",
  });

  add({
    id: "privacy",
    title: "Privacy policy link",
    status: isValidUrl(app.privacy_url) ? "pass" : "fail",
    fix: "settings",
    detail: isValidUrl(app.privacy_url)
      ? "Set. It must match your Data safety form and mention ads."
      : "Google Play requires a privacy policy, linked inside the app. Add an https link.",
  });

  add({
    id: "terms",
    title: "Terms of use link",
    status: isValidUrl(app.terms_url) ? "pass" : "warn",
    fix: "settings",
    detail: isValidUrl(app.terms_url)
      ? "Set."
      : "The app has a Terms row. Add an https link.",
  });

  add({
    id: "support",
    title: "Support email",
    status: app.support_email.includes("@") ? "pass" : "warn",
    fix: "settings",
    detail: app.support_email.includes("@")
      ? "Set."
      : "Google Play asks for a contact email on the store listing.",
  });

  return checks;
}

export const CHECKLIST: { id: string; title: string; detail: string }[] = [
  {
    id: "no-tap-ads",
    title: "Decided on ads after Generate Prompt and category taps",
    detail:
      "Google Play lists an ad between a tap and its result as a violation. They can be turned off in Ad controls with no app update, if Google objects.",
  },
  {
    id: "ai-reporting",
    title: "Checked Google Play's rule on AI-generated content",
    detail:
      "Google Play generally expects a way to report AI-generated content inside the app, and this app has none. Check the current rule in Play Console before submitting.",
  },
  {
    id: "dismissible",
    title: "Every full-screen ad can be closed",
    detail: "Google's own ad screens handle this. Nothing in the app may cover or delay the close button.",
  },
  {
    id: "placement",
    title: "Ads were checked on a real phone",
    detail: "Banners have space around them, nothing covers an ad, no ad appears while a video plays, and none appears where users usually tap.",
  },
  {
    id: "consent",
    title: "Consent form (UMP) is set up",
    detail: "Google's consent message for users in the EEA, the UK and Switzerland.",
  },
  {
    id: "data-safety",
    title: "Google Play Data safety form is complete",
    detail: "Declare the advertising ID and what the ad SDK collects. It must match your privacy policy.",
  },
  {
    id: "app-ads",
    title: "app-ads.txt is published",
    detail: "On the developer website listed on Google Play. It helps protect ad revenue from spoofing.",
  },
  {
    id: "no-self-clicks",
    title: "Nobody on the team clicks live ads",
    detail: "Use test ads and test devices. Clicks on your own ads count as invalid activity.",
  },
  {
    id: "content-rights",
    title: "We have the rights to all content",
    detail: "Every video, image and prompt is ours or properly licensed.",
  },
  {
    id: "content-rules",
    title: "Content follows Google's publisher policies",
    detail: "No sexual content, violence, hate or copyrighted material. Be especially careful with images of children.",
  },
  {
    id: "reports",
    title: "Reports are reviewed regularly",
    detail: "Check the Reports page and your support email, and hide anything that breaks the rules.",
  },
];

const FLAG_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "sexual content",
    pattern: /\b(nude|nudity|naked|nsfw|topless|erotic|porn\w*|sexy|lingerie|seductive)\b/i,
  },
  {
    label: "content that may harm children",
    pattern: /\b(child|children|kid|kids|baby|babies|toddler|minor|teen|teenager|schoolgirl|schoolboy)\b.*\b(nude|naked|sexy|seductive|lingerie|bikini)\b|\b(nude|naked|sexy|seductive|lingerie|bikini)\b.*\b(child|children|kid|kids|baby|babies|toddler|minor|teen|teenager|schoolgirl|schoolboy)\b/i,
  },
  {
    label: "violence",
    pattern: /\b(gore|gory|blood\w*|murder\w*|beheading|torture\w*|massacre)\b/i,
  },
  {
    label: "hate",
    pattern: /\b(nazi\w*|racist|racism|genocide)\b/i,
  },
  {
    label: "a brand, character or real person",
    pattern: /\b(disney|marvel|pixar|nike|adidas|gucci|chanel|louis vuitton|harry potter|spider-?man|batman|mickey mouse|pok[eé]mon|taylor swift|elon musk)\b/i,
  },
];

/**
 * A simple word check that warns before publishing. It catches obvious problems
 * only: it does not understand context, and it cannot look at the video itself.
 */
export function scanContent(text: string): string[] {
  return FLAG_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
}
