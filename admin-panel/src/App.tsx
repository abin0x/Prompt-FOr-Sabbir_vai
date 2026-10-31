import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { FeedbackProvider } from "./components/ui";
import type { Api } from "./lib/api";
import { AccountPage } from "./pages/AccountPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AdsPage } from "./pages/AdsPage";
import { AppSettingsPage } from "./pages/AppSettingsPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { ContentPage } from "./pages/ContentPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PolicyPage } from "./pages/PolicyPage";
import { ReportsPage } from "./pages/ReportsPage";

export function SetupNeeded() {
  return (
    <main className="center-page">
      <div className="auth-card">
        <img src="/logo.png" alt="" className="auth-logo" />
        <h1>Setup needed</h1>
        <p className="muted">
          Copy <code>.env.example</code> to <code>.env</code>, fill in your
          Supabase and R2 details, then restart.
        </p>
      </div>
    </main>
  );
}

export type Page =
  | "overview"
  | "library"
  | "categories"
  | "reports"
  | "ads"
  | "policy"
  | "settings"
  | "activity"
  | "account";

const NAV: { heading: string; items: { page: Page; label: string; icon: IconName }[] }[] = [
  {
    heading: "",
    items: [{ page: "overview", label: "Overview", icon: "overview" }],
  },
  {
    heading: "Content",
    items: [
      { page: "library", label: "Library", icon: "library" },
      { page: "categories", label: "Categories", icon: "tag" },
      { page: "reports", label: "Reports", icon: "flag" },
    ],
  },
  {
    heading: "Monetization",
    items: [
      { page: "ads", label: "Ad controls", icon: "ads" },
      { page: "policy", label: "Policy check", icon: "shield" },
    ],
  },
  {
    heading: "System",
    items: [
      { page: "settings", label: "App settings", icon: "settings" },
      { page: "activity", label: "Activity", icon: "history" },
    ],
  },
];

const PAGES: Page[] = [...NAV.flatMap((group) => group.items.map((item) => item.page)), "account"];

function pageFromHash(): Page {
  const name = window.location.hash.replace(/^#\/?/, "") as Page;
  return PAGES.includes(name) ? name : "overview";
}

type Theme = "light" | "dark";
type AuthState = "loading" | "signedOut" | "notAdmin" | "admin";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("admin-theme") as Theme) || "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("admin-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "light" ? "dark" : "light"))];
}

export function App({ api, demo }: { api: Api; demo: boolean }) {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [email, setEmail] = useState("");
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [authError, setAuthError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploadRequest, setUploadRequest] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [theme, toggleTheme] = useTheme();

  const go = useCallback((next: Page) => {
    window.location.hash = `/${next}`;
    setPageState(next);
    setMenuOpen(false);
  }, []);

  const startUpload = useCallback(() => {
    go("library");
    setUploadRequest((n) => n + 1);
  }, [go]);

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshReports = useCallback(() => {
    api
      .listReports("open")
      .then((reports) => setOpenReports(reports.length))
      .catch(() => undefined);
  }, [api]);

  const refreshAuth = useCallback(async () => {
    setAuthError("");
    try {
      const current = await api.currentEmail();
      if (!current) {
        setAuth("signedOut");
        return;
      }
      setEmail(current);
      setAuth((await api.isAdmin()) ? "admin" : "notAdmin");
    } catch (error) {
      setAuthError((error as Error).message);
      setAuth("signedOut");
    }
  }, [api]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (auth === "admin") refreshReports();
  }, [auth, refreshReports]);

  const signOut = async () => {
    await api.signOut();
    setAuth("signedOut");
  };

  if (auth === "loading") {
    return (
      <main className="center-page" aria-busy="true">
        <p className="muted">Loading...</p>
      </main>
    );
  }
  if (auth === "signedOut") {
    return (
      <LoginPage api={api} onSignedIn={refreshAuth} demo={demo} error={authError} />
    );
  }
  if (auth === "notAdmin") {
    return (
      <main className="center-page">
        <div className="auth-card">
          <img src="/logo.png" alt="" className="auth-logo" />
          <h1>No admin access</h1>
          <p className="muted">{email} is signed in but is not in the admins list.</p>
          <button className="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <FeedbackProvider>
      <div className="layout">
        <aside className={menuOpen ? "sidebar open" : "sidebar"}>
          <div className="sidebar-brand">
            <img src="/logo.png" alt="" />
            <div>
              <strong>Prompt Lab</strong>
              <span>Admin</span>
            </div>
          </div>

          <nav aria-label="Main">
            {NAV.map((group) => (
              <div className="nav-group" key={group.heading || "top"}>
                {group.heading && <div className="nav-heading">{group.heading}</div>}
                {group.items.map((item) => (
                  <button
                    key={item.page}
                    className={page === item.page ? "nav-item on" : "nav-item"}
                    aria-current={page === item.page ? "page" : undefined}
                    onClick={() => go(item.page)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    {item.page === "reports" && openReports > 0 && (
                      <span className="nav-badge" aria-label={`${openReports} open`}>
                        {openReports}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-foot">
            <button
              className={page === "account" ? "account-chip on" : "account-chip"}
              aria-label="Account"
              onClick={() => go("account")}
            >
              <span className="avatar" aria-hidden="true">
                {email.charAt(0).toUpperCase()}
              </span>
              <span className="account-email">{email}</span>
            </button>
            <div className="foot-actions">
              <button
                className="foot-button"
                aria-label={theme === "light" ? "Dark mode" : "Light mode"}
                title={theme === "light" ? "Dark mode" : "Light mode"}
                onClick={toggleTheme}
              >
                <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
              </button>
              <button
                className="foot-button"
                aria-label="Sign out"
                title="Sign out"
                onClick={signOut}
              >
                <Icon name="logout" size={16} />
              </button>
            </div>
          </div>
        </aside>

        {menuOpen && (
          <button
            className="sidebar-scrim"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
        )}

        <div className="main">
          <div className="mobile-bar">
            <button
              className="icon-button"
              aria-label="Open menu"
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <strong>Prompt Lab</strong>
          </div>
          {demo && (
            <div className="demo-bar">
              Demo mode: sample numbers, and nothing is saved.
            </div>
          )}
          <main className="page">
            {page === "overview" && (
              <OverviewPage api={api} go={go} onUpload={startUpload} />
            )}
            {page === "library" && <ContentPage api={api} uploadRequest={uploadRequest} />}
            {page === "categories" && <CategoriesPage api={api} />}
            {page === "reports" && (
              <ReportsPage api={api} onChanged={refreshReports} />
            )}
            {page === "ads" && <AdsPage api={api} go={go} />}
            {page === "policy" && <PolicyPage api={api} go={go} />}
            {page === "settings" && <AppSettingsPage api={api} />}
            {page === "activity" && <ActivityPage api={api} />}
            {page === "account" && (
              <AccountPage api={api} email={email} onSignOut={signOut} />
            )}
          </main>
        </div>
      </div>
    </FeedbackProvider>
  );
}
