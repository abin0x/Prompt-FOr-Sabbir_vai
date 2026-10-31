import { useState, type FormEvent } from "react";
import { Alert } from "../components/ui";
import type { Api } from "../lib/api";

export function LoginPage({
  api,
  onSignedIn,
  demo,
  error: outerError,
}: {
  api: Api;
  onSignedIn: () => Promise<void>;
  demo: boolean;
  error: string;
}) {
  const [email, setEmail] = useState(demo ? "demo@promptlab.app" : "");
  const [password, setPassword] = useState(demo ? "demo" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.signIn(email.trim(), password);
      await onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const shown = error || outerError;
  return (
    <main className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <img src="/logo.png" alt="" className="auth-logo" />
        <div>
          <h1>Prompt Lab Admin</h1>
          <p className="muted">Sign in to manage your app.</p>
        </div>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {shown && <Alert kind="error">{shown}</Alert>}
        <button className="button primary wide" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
