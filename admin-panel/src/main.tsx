import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, SetupNeeded } from "./App";
import type { Api } from "./lib/api";
import { createDemoApi } from "./lib/demoApi";
import { createSupabaseApi } from "./lib/supabaseApi";
import "./styles.css";

const { VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_MEDIA_BASE_URL, MODE } =
  import.meta.env;

let api: Api | null = null;
if (MODE === "demo") {
  api = createDemoApi();
} else if (VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY && VITE_MEDIA_BASE_URL) {
  api = createSupabaseApi(
    VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY,
    VITE_MEDIA_BASE_URL,
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {api ? <App api={api} demo={MODE === "demo"} /> : <SetupNeeded />}
  </StrictMode>,
);
