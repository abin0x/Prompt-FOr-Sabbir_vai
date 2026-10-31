import type { ContentType } from "./media";

export interface Category {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface VideoRow {
  id: string;
  title: string;
  content_type: ContentType;
  category_id: string | null;
  tags: string[];
  media_path: string;
  thumb_path: string | null;
  duration_sec: number | null;
  is_published: boolean;
  is_featured: boolean;
  view_count: number;
  media_bytes: number | null;
  /** When set and in the future, the item waits until then to appear. */
  publish_at: string | null;
  generate_count: number;
  copy_count: number;
  has_prompt: boolean;
  created_at: string;
}

export interface VideoInput {
  title: string;
  contentType: ContentType;
  categoryId: string | null;
  tags: string[];
  mediaPath: string;
  thumbPath: string | null;
  durationSec: number | null;
  promptText: string;
  isPublished: boolean;
  /** Null keeps the size already saved. */
  mediaBytes: number | null;
  publishAt: string | null;
}

export type UploadKind = "video" | "image" | "thumb";

export type VideoSort = "newest" | "oldest" | "most_viewed" | "title";

export interface VideoQuery {
  search: string;
  contentType: ContentType | "all";
  status: "all" | "published" | "scheduled" | "hidden" | "pinned" | "no_prompt";
  categoryId: string;
  sort: VideoSort;
  page: number;
  pageSize: number;
}

export interface Overview {
  total: number;
  live: number;
  scheduled: number;
  hidden: number;
  videos: number;
  images: number;
  no_thumb: number;
  no_category: number;
  no_views: number;
  no_prompt: number;
  total_views: number;
  total_generates: number;
  total_copies: number;
  media_bytes: number;
  open_reports: number;
  views_7d: number;
  views_prev_7d: number;
  daily: { day: string; views: number }[];
  top: {
    id: string;
    title: string;
    content_type: ContentType;
    thumb_path: string | null;
    view_count: number;
    week_views: number;
  }[];
  top_prompts: {
    id: string;
    title: string;
    content_type: ContentType;
    thumb_path: string | null;
    generate_count: number;
    copy_count: number;
  }[];
  recent: {
    id: string;
    title: string;
    content_type: ContentType;
    thumb_path: string | null;
    is_published: boolean;
    publish_at: string | null;
    created_at: string;
  }[];
  categories: { name: string; items: number; views: number }[];
}

export interface AdConfig {
  ads_enabled: boolean;
  use_test_ads: boolean;
  banner_enabled: boolean;
  native_enabled: boolean;
  interstitial_enabled: boolean;
  app_open_enabled: boolean;
  back_to_list_ad_enabled: boolean;
  generate_prompt_ad_enabled: boolean;
  category_tap_ad_enabled: boolean;
  saved_tab_ad_enabled: boolean;
  detail_native_ad_enabled: boolean;
  banner_unit_id: string;
  native_unit_id: string;
  interstitial_unit_id: string;
  app_open_unit_id: string;
  back_to_list_every_n: number;
  generate_prompt_every_n: number;
  category_tap_every_n: number;
  saved_tab_every_n: number;
  interstitial_min_gap_sec: number;
  interstitial_max_per_session: number;
  app_open_min_gap_hours: number;
  native_first_after_cards: number;
  native_every_n_cards: number;
  grace_period_sec: number;
}

export type HomeView = "all" | "video" | "image";

export interface OnboardingSlide {
  title: string;
  body: string;
}

export interface AppSettings {
  maintenance_mode: boolean;
  maintenance_message: string;
  announcement_enabled: boolean;
  announcement_text: string;
  announcement_url: string;
  home_subtitle: string;
  default_home_view: HomeView;
  /** Three slides. A blank field keeps the text built into the app. */
  onboarding: OnboardingSlide[];
  /** Blank keeps the address built into the app. */
  media_base_url: string;
  min_supported_version: string;
  latest_version: string;
  store_url: string;
  privacy_url: string;
  terms_url: string;
  support_email: string;
}

export type ChecklistState = Record<string, boolean>;

export interface ConfigMap {
  ads: AdConfig;
  app: AppSettings;
  launch_checklist: ChecklistState;
}

export type ReportReason =
  | "sexual"
  | "violence"
  | "child_safety"
  | "copyright"
  | "other";

export interface ContentReport {
  id: string;
  video_id: string;
  reason: ReportReason;
  note: string | null;
  status: "open" | "resolved";
  created_at: string;
  video: {
    title: string;
    thumb_path: string | null;
    is_published: boolean;
  } | null;
}

export interface ActivityEntry {
  id: number;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_label: string | null;
  created_at: string;
}

/** Everything the screens need. Implemented for Supabase and for the demo. */
export interface Api {
  /** Null when signed out. */
  currentEmail(): Promise<string | null>;
  isAdmin(): Promise<boolean>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  changePassword(password: string): Promise<void>;

  getOverview(): Promise<Overview>;

  listVideos(query: VideoQuery): Promise<{ rows: VideoRow[]; total: number }>;
  getPrompt(id: string): Promise<string>;
  saveVideo(id: string | null, input: VideoInput): Promise<string>;
  setPublished(ids: string[], published: boolean): Promise<void>;
  setFeatured(id: string, featured: boolean): Promise<void>;
  deleteVideo(id: string): Promise<{ filesRemoved: boolean }>;

  uploadFile(
    file: Blob,
    kind: UploadKind,
    contentType: string,
    onProgress: (fraction: number) => void,
  ): Promise<string>;
  discardUploads(keys: string[]): Promise<void>;
  mediaUrl(path: string): string;

  listCategories(): Promise<Category[]>;
  saveCategory(category: Partial<Category> & { name: string }): Promise<void>;
  deleteCategory(id: string): Promise<void>;

  listReports(status: "open" | "resolved"): Promise<ContentReport[]>;
  setReportStatus(id: string, status: "open" | "resolved"): Promise<void>;

  listActivity(limit: number): Promise<ActivityEntry[]>;

  getConfig<K extends keyof ConfigMap>(key: K): Promise<ConfigMap[K]>;
  saveConfig<K extends keyof ConfigMap>(key: K, value: ConfigMap[K]): Promise<void>;
}
