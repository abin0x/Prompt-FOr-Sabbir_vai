import type {
  ActivityEntry,
  AdConfig,
  Api,
  AppSettings,
  Category,
  ChecklistState,
  ConfigMap,
  ContentReport,
  Overview,
  VideoInput,
  VideoRow,
} from "./api";
import { itemStatus } from "./media";

// Runs with `npm run demo`: the whole portal in memory, with no accounts, so the
// screens can be tried before Supabase and R2 exist. All numbers are samples and
// nothing is saved.

const thumb = (name: string) => `/demo/thumb-${name}.jpg`;
const MB = 1024 * 1024;

function makeRow(
  n: number,
  title: string,
  contentType: "video" | "image",
  categoryId: string,
  image: string,
  views: number,
  published = true,
  featured = false,
): VideoRow {
  return {
    id: `demo-${n}`,
    title,
    content_type: contentType,
    category_id: categoryId,
    tags: [contentType === "video" ? "Video" : "Image"],
    media_path: thumb(image),
    thumb_path: thumb(image),
    duration_sec: contentType === "video" ? 8 + n : null,
    is_published: published,
    is_featured: featured,
    view_count: views,
    media_bytes: Math.round((contentType === "video" ? 1.2 : 0.3) * MB),
    publish_at: null,
    generate_count: Math.round(views / 4),
    copy_count: Math.round(views / 7),
    has_prompt: true,
    created_at: new Date(Date.UTC(2026, 9, 30 - n)).toISOString(),
  };
}

const DAILY_SAMPLE = [
  410, 520, 480, 610, 740, 690, 820, 780, 910, 1040, 980, 1160, 1090, 1240,
];

export function createDemoApi(): Api {
  let signedIn = false;
  const categories: Category[] = [
    "Laugh",
    "Cinematic",
    "Fashion",
    "Dance",
    "Formal",
    "Baby",
  ].map((name, i) => ({
    id: `cat-${i}`,
    name,
    sort_order: (i + 1) * 10,
    is_active: true,
  }));
  const rows: VideoRow[] = [
    makeRow(1, "Luxury Portrait", "video", "cat-2", "Trending", 9800, true, true),
    makeRow(2, "Moon Walker", "video", "cat-1", "Cinematic", 7400),
    makeRow(3, "Mountain Sunset", "image", "cat-1", "Mountain", 8200),
    makeRow(4, "Dance Moves", "video", "cat-3", "Dance", 6300),
    makeRow(5, "Runway Glow", "video", "cat-2", "Fashion", 9100),
    makeRow(6, "Classic Suit", "image", "cat-4", "Formal", 4700),
    makeRow(7, "Sweet Smile", "image", "cat-5", "Baby", 6100),
    makeRow(8, "Draft: Neon Street", "video", "cat-3", "Dance", 0, false),
  ];
  const prompts = new Map(
    rows.map((row) => [
      row.id,
      `Cinematic scene of ${row.title.toLowerCase()}, soft light, slow camera push-in, 4K.`,
    ]),
  );
  const config: ConfigMap = {
    ads: {
      ads_enabled: true,
      use_test_ads: true,
      banner_enabled: true,
      native_enabled: true,
      interstitial_enabled: true,
      app_open_enabled: true,
      back_to_list_ad_enabled: true,
      generate_prompt_ad_enabled: true,
      category_tap_ad_enabled: true,
      saved_tab_ad_enabled: true,
      detail_native_ad_enabled: true,
      banner_unit_id: "",
      native_unit_id: "",
      interstitial_unit_id: "",
      app_open_unit_id: "",
      back_to_list_every_n: 3,
      generate_prompt_every_n: 1,
      category_tap_every_n: 1,
      saved_tab_every_n: 1,
      interstitial_min_gap_sec: 90,
      interstitial_max_per_session: 4,
      app_open_min_gap_hours: 4,
      native_first_after_cards: 4,
      native_every_n_cards: 6,
      grace_period_sec: 60,
    } satisfies AdConfig,
    app: {
      maintenance_mode: false,
      maintenance_message: "We are making Prompt Lab better. Please check back soon.",
      announcement_enabled: false,
      announcement_text: "",
      announcement_url: "",
      home_subtitle: "",
      default_home_view: "all",
      onboarding: [
        { title: "", body: "" },
        { title: "", body: "" },
        { title: "", body: "" },
      ],
      media_base_url: "",
      min_supported_version: "",
      latest_version: "",
      store_url: "",
      privacy_url: "",
      terms_url: "",
      support_email: "",
    } satisfies AppSettings,
    launch_checklist: {} satisfies ChecklistState,
  };
  const reports: ContentReport[] = [
    {
      id: "report-1",
      video_id: "demo-4",
      reason: "copyright",
      note: "This looks like a clip from a music video.",
      status: "open",
      created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
      video: { title: "Dance Moves", thumb_path: thumb("Dance"), is_published: true },
    },
  ];
  const activity: ActivityEntry[] = [
    ["published", "videos", "Runway Glow", 1],
    ["edited", "app_config", "ads", 5],
    ["created", "videos", "Draft: Neon Street", 26],
    ["created", "categories", "Baby", 50],
  ].map(([action, target_type, target_label, hours], i) => ({
    id: i + 1,
    actor_email: "demo@promptlab.app",
    action: action as string,
    target_type: target_type as string,
    target_label: target_label as string,
    created_at: new Date(Date.now() - (hours as number) * 3600000).toISOString(),
  }));
  let nextId = 100;

  const wait = () => new Promise((resolve) => setTimeout(resolve, 120));
  const log = (action: string, target_type: string, target_label: string) =>
    activity.unshift({
      id: nextId++,
      actor_email: "demo@promptlab.app",
      action,
      target_type,
      target_label,
      created_at: new Date().toISOString(),
    });

  return {
    async currentEmail() {
      return signedIn ? "demo@promptlab.app" : null;
    },
    async isAdmin() {
      return signedIn;
    },
    async signIn(email, password) {
      await wait();
      if (!email || !password) throw new Error("Wrong email or password.");
      signedIn = true;
    },
    async signOut() {
      signedIn = false;
    },
    async changePassword() {
      await wait();
    },

    async getOverview(): Promise<Overview> {
      await wait();
      const live = rows.filter((row) => itemStatus(row) === "live");
      const today = new Date(Date.UTC(2026, 9, 30));
      const daily = DAILY_SAMPLE.map((views, i) => ({
        day: new Date(today.getTime() - (13 - i) * 86400000)
          .toISOString()
          .slice(0, 10),
        views,
      }));
      const sum = (list: typeof daily) => list.reduce((a, b) => a + b.views, 0);
      return {
        total: rows.length,
        live: live.length,
        scheduled: rows.filter((row) => itemStatus(row) === "scheduled").length,
        hidden: rows.filter((row) => !row.is_published).length,
        videos: rows.filter((row) => row.content_type === "video").length,
        images: rows.filter((row) => row.content_type === "image").length,
        no_thumb: rows.filter((row) => !row.thumb_path).length,
        no_category: rows.filter((row) => !row.category_id).length,
        no_views: live.filter((row) => row.view_count === 0).length,
        no_prompt: rows.filter((row) => !row.has_prompt).length,
        total_views: rows.reduce((a, b) => a + b.view_count, 0),
        total_generates: rows.reduce((a, b) => a + b.generate_count, 0),
        total_copies: rows.reduce((a, b) => a + b.copy_count, 0),
        media_bytes: rows.reduce((a, b) => a + (b.media_bytes ?? 0), 0),
        open_reports: reports.filter((r) => r.status === "open").length,
        views_7d: sum(daily.slice(7)),
        views_prev_7d: sum(daily.slice(0, 7)),
        daily,
        top: [...live]
          .sort((a, b) => b.view_count - a.view_count)
          .slice(0, 5)
          .map((row) => ({
            id: row.id,
            title: row.title,
            content_type: row.content_type,
            thumb_path: row.thumb_path,
            view_count: row.view_count,
            week_views: Math.round(row.view_count / 6),
          })),
        top_prompts: [...rows]
          .filter((row) => row.generate_count > 0 || row.copy_count > 0)
          .sort((a, b) => b.generate_count - a.generate_count)
          .slice(0, 5)
          .map((row) => ({
            id: row.id,
            title: row.title,
            content_type: row.content_type,
            thumb_path: row.thumb_path,
            generate_count: row.generate_count,
            copy_count: row.copy_count,
          })),
        recent: [...rows]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 5)
          .map((row) => ({
            id: row.id,
            title: row.title,
            content_type: row.content_type,
            thumb_path: row.thumb_path,
            is_published: row.is_published,
            publish_at: row.publish_at,
            created_at: row.created_at,
          })),
        categories: categories
          .map((category) => {
            const items = rows.filter((row) => row.category_id === category.id);
            return {
              name: category.name,
              items: items.length,
              views: items.reduce((a, b) => a + b.view_count, 0),
            };
          })
          .sort((a, b) => b.views - a.views),
      };
    },

    async listVideos(query) {
      await wait();
      const search = query.search.trim().toLowerCase();
      const matches = rows
        .filter((row) => !search || row.title.toLowerCase().includes(search))
        .filter(
          (row) =>
            query.contentType === "all" || row.content_type === query.contentType,
        )
        .filter((row) => {
          if (query.status === "all") return true;
          if (query.status === "pinned") return row.is_featured;
          if (query.status === "no_prompt") return !row.has_prompt;
          if (query.status === "published") return itemStatus(row) === "live";
          return itemStatus(row) === query.status;
        })
        .filter((row) => {
          if (!query.categoryId) return true;
          if (query.categoryId === "none") return !row.category_id;
          return row.category_id === query.categoryId;
        })
        .sort((a, b) => {
          if (query.sort === "most_viewed") return b.view_count - a.view_count;
          if (query.sort === "title") return a.title.localeCompare(b.title);
          const order = a.created_at.localeCompare(b.created_at);
          return query.sort === "oldest" ? order : -order;
        });
      const start = query.page * query.pageSize;
      return {
        rows: matches.slice(start, start + query.pageSize),
        total: matches.length,
      };
    },
    async getPrompt(id) {
      return prompts.get(id) ?? "";
    },
    async saveVideo(id, input: VideoInput) {
      await wait();
      if (input.isPublished && !input.promptText.trim()) {
        throw new Error(
          "Add a prompt before publishing. Items with no prompt can only stay hidden.",
        );
      }
      const savedId = id ?? `demo-${nextId++}`;
      const existing = rows.find((row) => row.id === savedId);
      const row: VideoRow = {
        id: savedId,
        title: input.title,
        content_type: input.contentType,
        category_id: input.categoryId,
        tags: input.tags,
        media_path: input.mediaPath,
        thumb_path: input.thumbPath,
        duration_sec: input.durationSec,
        is_published: input.isPublished,
        is_featured: existing?.is_featured ?? false,
        view_count: existing?.view_count ?? 0,
        media_bytes: input.mediaBytes ?? existing?.media_bytes ?? null,
        publish_at: input.publishAt,
        generate_count: existing?.generate_count ?? 0,
        copy_count: existing?.copy_count ?? 0,
        has_prompt: input.promptText.trim() !== "",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      if (existing) rows[rows.indexOf(existing)] = row;
      else rows.unshift(row);
      prompts.set(savedId, input.promptText);
      log(
        itemStatus(row) === "scheduled" ? "scheduled" : existing ? "edited" : "created",
        "videos",
        input.title,
      );
      return savedId;
    },
    async setPublished(ids, published) {
      const missing = rows.some((r) => ids.includes(r.id) && published && !r.has_prompt);
      if (missing) {
        throw new Error(
          "Add a prompt before publishing. Items with no prompt can only stay hidden.",
        );
      }
      for (const row of rows) {
        if (ids.includes(row.id)) {
          row.is_published = published;
          row.publish_at = null;
          log(published ? "published" : "hid", "videos", row.title);
        }
      }
    },
    async setFeatured(id, featured) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.is_featured = featured;
        log(featured ? "pinned" : "unpinned", "videos", row.title);
      }
    },
    async deleteVideo(id) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) {
        log("deleted", "videos", rows[index].title);
        rows.splice(index, 1);
      }
      for (let i = reports.length - 1; i >= 0; i--) {
        if (reports[i].video_id === id) reports.splice(i, 1);
      }
      return { filesRemoved: true };
    },

    async uploadFile(file, _kind, _contentType, onProgress) {
      for (const step of [0.25, 0.6, 1]) {
        await wait();
        onProgress(step);
      }
      return URL.createObjectURL(file);
    },
    async discardUploads() {},
    mediaUrl(path) {
      return path;
    },

    async listCategories() {
      return [...categories].sort((a, b) => a.sort_order - b.sort_order);
    },
    async saveCategory(category) {
      const duplicate = categories.some(
        (c) =>
          c.name.toLowerCase() === category.name.toLowerCase() &&
          c.id !== category.id,
      );
      if (duplicate) throw new Error("A category with this name already exists.");
      const existing = categories.find((c) => c.id === category.id);
      if (existing) Object.assign(existing, category);
      else {
        categories.push({
          id: `cat-${nextId++}`,
          sort_order: 0,
          is_active: true,
          ...category,
        });
        log("created", "categories", category.name);
      }
    },
    async deleteCategory(id) {
      const index = categories.findIndex((c) => c.id === id);
      if (index >= 0) categories.splice(index, 1);
      for (const row of rows) if (row.category_id === id) row.category_id = null;
    },

    async listReports(status) {
      await wait();
      return reports.filter((report) => report.status === status);
    },
    async setReportStatus(id, status) {
      const report = reports.find((r) => r.id === id);
      if (report) report.status = status;
    },

    async listActivity(limit) {
      await wait();
      return activity.slice(0, limit);
    },

    async getConfig(key) {
      return structuredClone(config[key]);
    },
    async saveConfig(key, value) {
      await wait();
      config[key] = structuredClone(value);
      if (key !== "launch_checklist") log("edited", "app_config", key);
    },
  };
}
