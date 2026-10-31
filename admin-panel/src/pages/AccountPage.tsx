import { useState, type FormEvent } from "react";
import { Alert, Card, PageHeader, useFeedback } from "../components/ui";
import type { Api } from "../lib/api";

const MIN_LENGTH = 10;

export function AccountPage({
  api,
  email,
  onSignOut,
}: {
  api: Api;
  email: string;
  onSignOut: () => void;
}) {
  const { toast } = useFeedback();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== again) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.changePassword(password);
      setPassword("");
      setAgain("");
      toast("Password changed.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" description="Your admin sign-in." />
      <div className="stack narrow-stack">
        <Card title="Signed in as">
          <div className="account-row">
            <strong>{email}</strong>
            <button className="button" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </Card>

        <Card title="Change password">
          <form className="stack small-gap" onSubmit={submit}>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Repeat new password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
            {error && <Alert kind="error">{error}</Alert>}
            <div>
              <button className="button primary" disabled={busy}>
                {busy ? "Saving..." : "Change password"}
              </button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
