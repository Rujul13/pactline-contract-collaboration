"use client";

import { FormEvent, useState } from "react";

export default function OwnerLoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/";
    const response = await fetch("/api/owner/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, returnTo }),
    });
    const result = await response.json() as { error?: string; returnTo?: string };
    setBusy(false);
    if (!response.ok) {
      setError(result.error ?? "Unable to sign in");
      return;
    }
    window.location.assign(result.returnTo || "/");
  }

  return <main className="review-portal">
    <form className="portal-login" onSubmit={signIn}>
      <div className="client-login-brand"><span className="brand-mark">P</span><strong>Pactline</strong></div>
      <p className="login-lock">Vendor workspace</p>
      <h1>Sign in to your contracts</h1>
      <p>The vendor workspace is private. Customers use the separate username and password included with their contract link.</p>
      <label htmlFor="owner-password">Vendor password</label>
      <input id="owner-password" type="password" autoComplete="current-password" required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />
      {error && <div className="portal-message error" role="alert">{error}</div>}
      <button type="submit" disabled={busy || password.length < 12}>{busy ? "Signing in…" : "Open vendor workspace"}</button>
      <small>Secure session · 12-hour expiry · password never stored in the browser</small>
    </form>
  </main>;
}
