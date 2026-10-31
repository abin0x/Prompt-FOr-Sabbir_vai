import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ActivityEntry,
  Api,
  Category,
  ConfigMap,
  ContentReport,
  Overview,
  UploadKind,
  VideoQuery,
  VideoRow,
} from "./api";

const VIDEO_COLUMNS =
  "id,title,content_type,category_id,tags,media_path,thumb_path,duration_sec,is_published,is_featured,view_count,media_bytes,publish_at,generate_count,copy_count,created_at,prompts(video_id)";

type FetchedRow = Omit<VideoRow, "has_prompt"> & { prompts: unknown };

function friendlyError(message: string): string {
  return message.includes("prompt_missing")
    ? "Add a prompt before publishing. Items with no prompt can only stay hidden."
    : message;
}

function friendlyAuthError(message: string): string {
  if (/invalid login/i.test(message)) return "Wrong email or password.";
  if (/fetch/i.test(message)) return "Cannot reach the server. Check your connection.";
  return message;
}

/** A function error's useful text is in the response body. */
async function functionError(error: unknown, fallback: string): Promise<Error> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === "function") {
    const body = await context.json().catch(() => null);
    if (body?.error) return new Error(body.error);
  }
  return new Error(fallback);
}

function putWithProgress(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): Promise<void> {
  // fetch cannot report upload progress, so this one call uses XHR.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Upload to storage failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Upload to storage failed. Check the bucket's CORS rules."));
    xhr.send(file);
  });
}

export function createSupabaseApi(
  url: string,
  anonKey: string,
  mediaBaseUrl: string,
): Api {
  const db: SupabaseClient = createClient(url, anonKey);

  return {
    async currentEmail() {
      const { data } = await db.auth.getSession();
      return data.session?.user.email ?? null;
    },
    async isAdmin() {
      const { data, error } = await db.rpc("is_admin");
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
    async signIn(email, password) {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw new Error(friendlyAuthError(error.message));
    },
    async signOut() {
      await db.auth.signOut();
    },
    async changePassword(password) {
      const { error } = await db.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },

    async getOverview() {
      const { data, error } = await db.rpc("admin_overview");
      if (error) throw new Error(error.message);
      return data as Overview;
    },

    async listVideos(query: VideoQuery) {
      const from = query.page * query.pageSize;
      let request = db
        .from("videos")
        .select(VIDEO_COLUMNS, { count: "exact" })
        .range(from, from + query.pageSize - 1);
      request =
        query.sort === "oldest"
          ? request.order("created_at", { ascending: true })
          : query.sort === "most_viewed"
            ? request.order("view_count", { ascending: false })
            : query.sort === "title"
              ? request.order("title", { ascending: true })
              : request.order("created_at", { ascending: false });
      if (query.contentType !== "all") {
        request = request.eq("content_type", query.contentType);
      }
      const now = new Date().toISOString();
      if (query.status === "pinned") {
        request = request.eq("is_featured", true);
      } else if (query.status === "no_prompt") {
        request = request.is("prompts", null);
      } else if (query.status === "hidden") {
        request = request.eq("is_published", false);
      } else if (query.status === "scheduled") {
        request = request.eq("is_published", true).gt("publish_at", now);
      } else if (query.status === "published") {
        request = request
          .eq("is_published", true)
          .or(`publish_at.is.null,publish_at.lte.${now}`);
      }
      if (query.categoryId === "none") {
        request = request.is("category_id", null);
      } else if (query.categoryId) {
        request = request.eq("category_id", query.categoryId);
      }
      const search = query.search.trim();
      if (search) {
        // % and _ are wildcards in ilike, so a typed one must stay literal.
        request = request.ilike("title", `%${search.replace(/[\\%_]/g, "\\$&")}%`);
      }
      const { data, error, count } = await request;
      if (error) throw new Error(error.message);
      const rows = ((data ?? []) as unknown as FetchedRow[]).map(
        ({ prompts, ...row }) => ({ ...row, has_prompt: prompts != null }),
      );
      return { rows, total: count ?? 0 };
    },
    async getPrompt(id) {
      const { data, error } = await db
        .from("prompts")
        .select("prompt_text")
        .eq("video_id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.prompt_text ?? "";
    },
    async saveVideo(id, input) {
      const { data, error } = await db.rpc("save_video", {
        p_id: id,
        p_title: input.title,
        p_content_type: input.contentType,
        p_category_id: input.categoryId,
        p_tags: input.tags,
        p_media_path: input.mediaPath,
        p_thumb_path: input.thumbPath,
        p_duration_sec: input.durationSec,
        p_prompt_text: input.promptText,
        p_is_published: input.isPublished,
        p_media_bytes: input.mediaBytes,
        p_publish_at: input.publishAt,
      });
      if (error) throw new Error(friendlyError(error.message));
      return data as string;
    },
    async setPublished(ids, published) {
      const { error } = await db
        .from("videos")
        // Publish and Hide both act now, so they replace any scheduled time.
        .update({ is_published: published, publish_at: null })
        .in("id", ids);
      if (error) throw new Error(friendlyError(error.message));
    },
    async setFeatured(id, featured) {
      const { error } = await db
        .from("videos")
        .update({ is_featured: featured })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async deleteVideo(id) {
      const { data, error } = await db.functions.invoke("r2-delete", {
        body: { id },
      });
      if (error) throw await functionError(error, "Could not delete this item.");
      return { filesRemoved: Boolean(data?.filesRemoved) };
    },

    async uploadFile(file, kind: UploadKind, contentType, onProgress) {
      const { data, error } = await db.functions.invoke("r2-upload-url", {
        body: { kind, contentType, size: file.size },
      });
      if (error) throw await functionError(error, "Could not start the upload.");
      await putWithProgress(data.url, file, data.headers, onProgress);
      return data.key as string;
    },
    async discardUploads(keys) {
      if (keys.length === 0) return;
      await db.functions.invoke("r2-delete", { body: { keys } });
    },
    mediaUrl(path) {
      return `${mediaBaseUrl.replace(/\/$/, "")}/${path}`;
    },

    async listCategories() {
      const { data, error } = await db
        .from("categories")
        .select("id,name,sort_order,is_active")
        .order("sort_order")
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Category[];
    },
    async saveCategory(category) {
      const { id, ...fields } = category;
      const { error } = id
        ? await db.from("categories").update(fields).eq("id", id)
        : await db.from("categories").insert(fields);
      if (error) {
        throw new Error(
          error.code === "23505"
            ? "A category with this name already exists."
            : error.message,
        );
      }
    },
    async deleteCategory(id) {
      const { error } = await db.from("categories").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },

    async listReports(status) {
      const { data, error } = await db
        .from("content_reports")
        .select(
          "id,video_id,reason,note,status,created_at,video:videos(title,thumb_path,is_published)",
        )
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ContentReport[];
    },
    async setReportStatus(id, status) {
      const { error } = await db
        .from("content_reports")
        .update({ status })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },

    async listActivity(limit) {
      const { data, error } = await db
        .from("admin_activity")
        .select("id,actor_email,action,target_type,target_label,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as ActivityEntry[];
    },

    async getConfig<K extends keyof ConfigMap>(key: K) {
      const { data, error } = await db
        .from("app_config")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.value ?? {}) as ConfigMap[K];
    },
    async saveConfig(key, value) {
      const { error } = await db.from("app_config").upsert({ key, value });
      if (error) throw new Error(error.message);
    },
  };
}
