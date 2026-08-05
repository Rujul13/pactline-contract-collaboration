"use client";

import { useCallback, useEffect, useState } from "react";

type Block = { id: string; block_key: string; order_index: number; kind: "title" | "heading" | "body"; current_text: string };
type Proposal = { id: string; block_id: string; original_text: string; proposed_text: string; counter_text?: string; status: string };
type Workspace = { contract: { id: string; title: string; status: string; current_version: number }; blocks: Block[]; reviewer: { name: string; company: string; username: string; permission: string; partyId: string }; proposals: Proposal[]; agreements: Array<{ party_id: string; version_number: number }> };

export default function ClientReviewPage({ params }: { params: Promise<{ contractId: string }> }) {
  const [contractId, setContractId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState(true);

  const loadWorkspace = useCallback(async (id: string) => {
    const response = await fetch(`/api/client/contracts/${encodeURIComponent(id)}/proposals`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.ok) { setWorkspace(await response.json() as Workspace); }
    else if (response.status !== 401) { setMessageType("error"); setMessage((await response.json() as { error?: string }).error ?? "Unable to open this contract"); }
    setBusy(false);
  }, []);

  useEffect(() => { void params.then(({ contractId: id }) => { setContractId(id); return loadWorkspace(id); }); }, [params, loadWorkspace]);

  useEffect(() => {
    if (!contractId) return;
    const refresh = () => { if (!document.hidden) void loadWorkspace(contractId); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); };
  }, [contractId, loadWorkspace]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/client/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    if (!response.ok) { setBusy(false); setMessageType("error"); setMessage((await response.json() as { error?: string }).error ?? "Unable to sign in"); return; }
    await loadWorkspace(contractId);
  }

  async function submitChanges() {
    if (!workspace) return; setBusy(true); setMessage("");
    const edits = Object.entries(drafts).map(([blockId, proposedText]) => ({ blockId, originalText: workspace.blocks.find((block) => block.id === blockId)?.current_text, proposedText }));
    const response = await fetch(`/api/client/contracts/${encodeURIComponent(contractId)}/proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: workspace.contract.current_version, edits }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setBusy(false); setMessageType("error"); setMessage(result.error ?? "Unable to submit changes"); return; }
    setDrafts({}); setEditingId(null); setMessageType("success"); setMessage(`${edits.length} proposed ${edits.length === 1 ? "change" : "changes"} sent to the contract owner.`); await loadWorkspace(contractId);
  }

  async function agree() {
    setBusy(true); setMessage("");
    const response = await fetch(`/api/client/contracts/${encodeURIComponent(contractId)}/agree`, { method: "POST" }); const result = await response.json() as { locked?: boolean; error?: string };
    setBusy(false); if (!response.ok) { setMessageType("error"); setMessage(result.error ?? "Unable to record agreement"); return; }
    setMessageType("success"); setMessage(result.locked ? "Both parties agreed. The final document is now locked and ready to download." : "Your agreement is recorded for this version. Waiting for the contract owner."); await loadWorkspace(contractId);
  }

  async function signOut() { await fetch("/api/client/logout", { method: "POST" }); setWorkspace(null); setDrafts({}); setMessageType("success"); setMessage("Signed out securely."); }
  function downloadFinal() { const anchor = document.createElement("a"); anchor.href = `/api/client/contracts/${contractId}/download`; anchor.click(); }

  if (busy && !workspace) return <main className="review-portal"><div className="portal-card"><span className="portal-spinner"/><p>Opening secure contract review…</p></div></main>;
  if (!workspace) return <main className="review-portal"><form className="portal-login" onSubmit={signIn}><div className="client-login-brand"><span className="brand-mark">P</span><strong>Pactline</strong></div><span className="login-lock">🔒</span><h1>Sign in to review</h1><p>Your edits are submitted as proposals and cannot overwrite the contract owner’s document.</p><label htmlFor="review-username">Username</label><input id="review-username" autoComplete="username" value={credentials.username} onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))} required/><label htmlFor="review-password">Password</label><input id="review-password" type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))} required/>{message && <div className="portal-message error" role="alert">{message}</div>}<button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in securely"}</button><small>Every proposal and agreement is attributed to this reviewer account.</small></form></main>;

  const locked = workspace.contract.status === "locked";
  const pending = workspace.proposals.filter((proposal) => proposal.status === "pending");
  const counters = workspace.proposals.filter((proposal) => proposal.status === "countered" && proposal.counter_text);
  const clientAgreed = workspace.agreements.some((agreement) => agreement.party_id === workspace.reviewer.partyId && agreement.version_number === workspace.contract.current_version);

  return <main className="review-portal workspace-open"><header className="portal-header"><div className="client-brand"><span className="brand-mark">P</span><div><strong>Pactline client review</strong><small>{workspace.contract.title} · Version {workspace.contract.current_version}</small></div></div><div className="portal-user"><span>{workspace.reviewer.name}</span><small>{workspace.reviewer.company}</small><button onClick={() => void signOut()}>Sign out</button></div></header><div className="portal-notice"><strong>{locked ? "Final" : counters.length ? "Counterproposal" : "Review mode"}</strong><span>{locked ? "Both parties agreed to this locked version." : counters.length ? "The contract owner suggested alternative language. Review it in the highlighted paragraph." : "Click a paragraph to propose replacement text. The owner must accept every change."}</span></div>{message && <div className={`portal-message ${messageType}`} role="status">{message}</div>}<article className="word-page portal-document"><div className="word-page-meta"><span>{locked ? "Final agreed document" : "Secure shared document"}</span><span>{workspace.blocks.length} paragraphs</span></div><div className="document-flow">{workspace.blocks.map((block) => { const draft = drafts[block.id]; const editing = editingId === block.id; const ownerCounter = counters.find((proposal) => proposal.block_id === block.id); return <section className={`doc-paragraph ${block.kind} ${draft ? "staged" : ""} ${ownerCounter ? "counter-returned" : ""}`} key={block.id}>{editing ? <div className="paragraph-editor"><label htmlFor={`review-block-${block.id}`}>Proposed paragraph text</label><textarea id={`review-block-${block.id}`} value={draft ?? block.current_text} onChange={(event) => setDrafts((current) => ({ ...current, [block.id]: event.target.value }))} rows={Math.max(3, Math.ceil((draft ?? block.current_text).length / 85))} autoFocus/><div><button onClick={() => setEditingId(null)}>Done</button>{draft && <button className="discard" onClick={() => setDrafts((current) => { const next = { ...current }; delete next[block.id]; return next; })}>Discard</button>}</div></div> : <button className="paragraph-content" disabled={locked || clientAgreed} onClick={() => setEditingId(block.id)}><span>{draft ?? block.current_text}</span><i>{draft ? "Proposed" : ownerCounter ? "Owner counter" : locked ? "Locked" : "Edit"}</i></button>}{ownerCounter && !draft && <div className="client-counter-card"><strong>Owner counterproposal</strong><p>{ownerCounter.counter_text}</p><button disabled={locked || clientAgreed} onClick={() => { setDrafts((current) => ({ ...current, [block.id]: ownerCounter.counter_text! })); setEditingId(block.id); }}>Continue negotiation with this text</button></div>}</section>; })}</div></article><footer className="client-submit-bar"><div><strong>{locked ? "Final document ready" : Object.keys(drafts).length ? `${Object.keys(drafts).length} changes ready to submit` : pending.length ? `${pending.length} ${pending.length === 1 ? "change" : "changes"} awaiting the owner` : counters.length ? `${counters.length} owner counterproposal${counters.length === 1 ? "" : "s"} to review` : clientAgreed ? "Your agreement is recorded" : "No unresolved proposals"}</strong><small>{locked ? "Download the exact version agreed by both parties." : "Agreements apply only to the current document version."}</small></div>{locked ? <button onClick={downloadFinal}>Download final DOCX</button> : Object.keys(drafts).length ? <button disabled={busy} onClick={() => void submitChanges()}>Submit proposed changes</button> : <button disabled={busy || pending.length > 0 || counters.length > 0 || clientAgreed} onClick={() => void agree()}>{clientAgreed ? "Agreement recorded" : counters.length ? "Review owner counter" : "Agree to this version"}</button>}</footer></main>;
}
