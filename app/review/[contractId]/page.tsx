"use client";

import { useCallback, useEffect, useState } from "react";

type Block = { id: string; block_key: string; order_index: number; kind: "title" | "heading" | "body"; current_text: string };
type Workspace = { contract: { id: string; title: string; status: string; current_version: number }; blocks: Block[]; reviewer: { name: string; company: string; username: string; permission: string }; proposals: Array<{ id: string; block_id: string; status: string }> };

export default function ClientReviewPage({ params }: { params: Promise<{ contractId: string }> }) {
  const [contractId, setContractId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);

  const loadWorkspace = useCallback(async (id: string) => {
    const response = await fetch(`/api/client/contracts/${encodeURIComponent(id)}/proposals`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.ok) { setWorkspace(await response.json() as Workspace); setMessage(""); }
    else if (response.status !== 401) setMessage((await response.json() as { error?: string }).error ?? "Unable to open this contract");
    setBusy(false);
  }, []);

  useEffect(() => { void params.then(({ contractId: id }) => { setContractId(id); return loadWorkspace(id); }); }, [params, loadWorkspace]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/client/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    if (!response.ok) { setBusy(false); setMessage((await response.json() as { error?: string }).error ?? "Unable to sign in"); return; }
    await loadWorkspace(contractId);
  }

  async function submitChanges() {
    if (!workspace) return;
    setBusy(true); setMessage("");
    const edits = Object.entries(drafts).map(([blockId, proposedText]) => ({ blockId, originalText: workspace.blocks.find((block) => block.id === blockId)?.current_text, proposedText }));
    const response = await fetch(`/api/client/contracts/${encodeURIComponent(contractId)}/proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: workspace.contract.current_version, edits }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setBusy(false); setMessage(result.error ?? "Unable to submit changes"); return; }
    setDrafts({}); setEditingId(null); setMessage(`${edits.length} proposed ${edits.length === 1 ? "change" : "changes"} sent for review.`); await loadWorkspace(contractId);
  }

  async function signOut() {
    await fetch("/api/client/logout", { method: "POST" }); setWorkspace(null); setDrafts({}); setMessage("Signed out securely.");
  }

  if (busy && !workspace) return <main className="review-portal"><div className="portal-card"><span className="portal-spinner"/><p>Opening secure contract review…</p></div></main>;
  if (!workspace) return <main className="review-portal"><form className="portal-login" onSubmit={signIn}><div className="client-login-brand"><span className="brand-mark">P</span><strong>Pactline</strong></div><span className="login-lock">🔒</span><h1>Sign in to review</h1><p>Your edits will be submitted as proposals and cannot overwrite the original contract.</p><label htmlFor="review-username">Username</label><input id="review-username" autoComplete="username" value={credentials.username} onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))} required/><label htmlFor="review-password">Password</label><input id="review-password" type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))} required/>{message && <div className="portal-message error" role="alert">{message}</div>}<button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in securely"}</button><small>Access is named, expiring, revocable, and fully attributed.</small></form></main>;

  return <main className="review-portal workspace-open"><header className="portal-header"><div className="client-brand"><span className="brand-mark">P</span><div><strong>Pactline client review</strong><small>{workspace.contract.title} · Version {workspace.contract.current_version}</small></div></div><div className="portal-user"><span>{workspace.reviewer.name}</span><small>{workspace.reviewer.company}</small><button onClick={() => void signOut()}>Sign out</button></div></header><div className="portal-notice"><strong>Review mode</strong><span>Click a paragraph to suggest replacement text. The owner must accept every change.</span></div>{message && <div className="portal-message success" role="status">{message}</div>}<article className="word-page portal-document"><div className="word-page-meta"><span>Secure shared document</span><span>{workspace.blocks.length} paragraphs</span></div><div className="document-flow">{workspace.blocks.map((block) => { const draft = drafts[block.id]; const editing = editingId === block.id; return <section className={`doc-paragraph ${block.kind} ${draft ? "staged" : ""}`} key={block.id}>{editing ? <div className="paragraph-editor"><label htmlFor={`review-block-${block.id}`}>Proposed paragraph text</label><textarea id={`review-block-${block.id}`} value={draft ?? block.current_text} onChange={(event) => setDrafts((current) => ({ ...current, [block.id]: event.target.value }))} rows={Math.max(3, Math.ceil((draft ?? block.current_text).length/85))} autoFocus/><div><button onClick={() => setEditingId(null)}>Done</button>{draft && <button className="discard" onClick={() => setDrafts((current) => { const next = { ...current }; delete next[block.id]; return next; })}>Discard</button>}</div></div> : <button className="paragraph-content" onClick={() => setEditingId(block.id)}><span>{draft ?? block.current_text}</span><i>{draft ? "Proposed" : "Edit"}</i></button>}</section>;})}</div></article><footer className="client-submit-bar"><div><strong>{Object.keys(drafts).length ? `${Object.keys(drafts).length} changes ready to submit` : "No unsubmitted changes"}</strong><small>Your proposals remain separate from the authoritative document.</small></div><button disabled={busy || !Object.keys(drafts).length} onClick={() => void submitChanges()}>Submit proposed changes</button></footer></main>;
}
