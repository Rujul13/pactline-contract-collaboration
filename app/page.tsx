"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { diffText, type DiffSegment } from "@/lib/text-diff";

const DEMO_CONTRACT_ID = "sample-services-agreement";
const DEMO_USERNAME = "client.reviewer";
const DEMO_PASSWORD = "ReviewDemo!2026";

type ContractSummary = {
  id: string;
  title: string;
  status: string;
  current_version: number;
  locked_at: string | null;
  updated_at: string;
  reviewer_name: string | null;
  client_company: string | null;
  reviewer_email: string | null;
  pending_proposals: number;
  filename: string | null;
};

type Block = { id: string; block_key: string; order_index: number; kind: "title" | "heading" | "body"; current_text: string };
type Proposal = { id: string; block_id: string; base_version: number; original_text: string; proposed_text: string; counter_text?: string; rationale?: string; resolution_reason?: string; status: string; created_at: string; accountId: string; author_display: string };
type Comment = { id: string; block_id: string; parent_comment_id: string | null; author_kind: "owner" | "reviewer"; author_display: string; body: string; status: string; resolution_reason?: string; created_at: string };
type AccessAccount = { id: string; party_id: string; username: string; permission: string; status: string; expires_at: string };
type AuditLogEntry = { id: string; actor_display: string; action: string; metadata?: Record<string, unknown>; created_at: string };
type ReviewRound = { id: string; round_number: number; status: string; deadline_at?: string };

type Workspace = {
  contract: ContractSummary;
  blocks: Block[];
  versions: Array<{ version_number: number; created_at: string; created_by: string | null }>;
  parties: Array<{ id: string; role: "initiator" | "counterparty"; name: string; company: string; email: string }>;
  proposals: Proposal[];
  comments: Comment[];
  access: AccessAccount[];
  auditLogs: AuditLogEntry[];
  reviewRounds: ReviewRound[];
  agreements: Array<{ party_id: string; version_number: number }>;
};

type Credentials = { username: string; password?: string; link: string };
type AiMode = "chat" | "review" | "rewrite" | "insert_clause";
type AiChatMessage = { id: string; role: "user" | "assistant"; content: string; result?: AiResult };
type AiDraft = { operation: "replace_paragraph" | "insert_clause"; heading?: string; paragraphs?: string[]; targetBlockId?: string | null; replacementText?: string; baseVersion: number };
type AiResult = { reply: string; operation: "none" | "replace_paragraph" | "insert_clause"; inScope: boolean; targetBlockId?: string | null; heading?: string; paragraphs?: string[]; replacementText?: string; baseVersion: number };

function titleFromFilename(filename: string) {
  return filename.replace(/\.docx$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableAction(action: string) {
  const labels: Record<string, string> = {
    "demo.created": "created the generic demonstration contract",
    "contract.created": "created a contract from a Word document",
    "document.uploaded": "uploaded a new Word document version",
    "paragraph.updated": "edited a paragraph",
    "paragraph_proposals.submitted": "submitted proposed paragraph changes",
    "paragraph_proposal.accepted": "accepted a proposed change",
    "paragraph_proposal.rejected": "rejected a proposed change",
    "paragraph_proposal.countered": "sent a counterproposal",
    "access.created": "created reviewer access",
    "contract.agreed": "agreed to the current version",
    "contract.locked": "locked the final agreed contract",
    "document.downloaded": "downloaded the contract",
    "ai.assistant_invoked": "used the AI contract assistant",
    "ai.assistant_attempted": "requested an AI contract review",
    "ai.paragraph_rewritten": "applied an AI-assisted paragraph rewrite",
    "ai.clause_inserted": "applied an AI-drafted clause",
  };
  return labels[action] ?? action.replaceAll(".", " ");
}

function DiffText({ original, proposed, side }: { original: string; proposed: string; side: "original" | "proposed" }) {
  const segments = diffText(original, proposed)[side];
  return <>{segments.map((segment: DiffSegment, index: number) => segment.changed
    ? <mark className={`diff-change ${side === "original" ? "removed-change" : "added-change"}`} key={index}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)}</>;
}

export default function Home() {
  const router = useRouter();
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [activeId, setActiveId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState("");
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"document" | "history" | "activity">("document");
  const [rail, setRail] = useState<"proposals" | "details">("proposals");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [counteringId, setCounteringId] = useState<string | null>(null);
  const [counterDraft, setCounterDraft] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [sidebarView, setSidebarView] = useState<"contracts" | "queue" | "activity">("contracts");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newContractOpen, setNewContractOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiAcknowledged, setAiAcknowledged] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMode, setAiMode] = useState<AiMode>("chat");
  const [aiInput, setAiInput] = useState("");
  const [aiTargetBlockId, setAiTargetBlockId] = useState<string | null>(null);
  const [aiMessages, setAiMessages] = useState<Record<string, AiChatMessage[]>>({});
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);

  const announce = useCallback((message: string) => {
    setToast(message); window.setTimeout(() => setToast(""), 3000);
  }, []);

  const loadContract = useCallback(async (contractId: string) => {
    setLoading(true); setError("");
    const response = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/workspace`, { cache: "no-store" });
    const result = await response.json() as Workspace & { error?: string };
    if (!response.ok) { setError(result.error ?? "Unable to load the contract"); setLoading(false); return; }
    setWorkspace(result); setActiveId(contractId); setLoading(false);
  }, []);

  const loadWorkspace = useCallback(async (preferredId?: string) => {
    setLoading(true); setError("");
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const result = await response.json() as { owner?: { name: string }; contracts?: ContractSummary[]; error?: string; signIn?: string };
    if (!response.ok) { setError(result.error ?? "Unable to open the workspace"); setSignIn(result.signIn ?? ""); setLoading(false); return; }
    const nextContracts = result.contracts ?? []; setContracts(nextContracts);
    const searchId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("contract") : null;
    const nextId = preferredId || searchId || activeId || nextContracts[0]?.id;
    if (nextId) await loadContract(nextId); else setLoading(false);
  }, [activeId, loadContract]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeId) return;
    const refresh = () => { if (!document.hidden) void loadWorkspace(activeId); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); };
  }, [activeId, loadWorkspace]);

  useEffect(() => {
    if (aiOpen) aiMessagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [aiMessages, aiOpen, aiBusy]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) setSwitcherOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function updateBlock(blockId: string, text: string) {
    if (!contract || !text.trim()) return; setBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/blocks/${blockId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentText: text.trim() }) });
    const result = await response.json() as { error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to update paragraph"); return; }
    setEditingId(null); announce("Paragraph updated."); await loadWorkspace(contract.id);
  }

  async function resolveProposal(proposalId: string, action: "accept" | "reject" | "counter", counterText?: string) {
    if (!contract || !decisionReason.trim()) return; setBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/paragraph-proposals/${proposalId}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, counterText, reason: decisionReason.trim() }) });
    const result = await response.json() as { error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to resolve proposal"); return; }
    setCounteringId(null); setCounterDraft(""); setDecisionReason(""); setSelectedProposalId(null);
    announce(action === "accept" ? "Change accepted into a new version." : action === "counter" ? "Counterproposal sent back to the reviewer." : "Change rejected and recorded."); await loadWorkspace(contract.id);
  }

  async function uploadVersion(file?: File) {
    if (!file || !contract) return;
    if (contract.id === DEMO_CONTRACT_ID) {
      setNewFile(file); setNewTitle(titleFromFilename(file.name)); setNewContractOpen(true); setSwitcherOpen(true);
      if (fileRef.current) fileRef.current.value = "";
      announce("Your Word document is ready. Confirm its name to create a private contract."); return;
    }
    setBusy(true);
    const form = new FormData(); form.append("document", file);
    const response = await fetch(`/api/contracts/${contract.id}/documents`, { method: "POST", body: form });
    const result = await response.json() as { error?: string };
    setBusy(false); if (fileRef.current) fileRef.current.value = ""; if (!response.ok) { announce(result.error ?? "Unable to upload the Word document"); return; }
    announce("New Word document imported as editable paragraphs."); await loadWorkspace(contract.id);
  }

  async function createContract() {
    if (!newFile || !newTitle.trim()) return; setBusy(true);
    const form = new FormData(); form.append("title", newTitle.trim()); form.append("document", newFile); form.append("clientCompany", "Client Company"); form.append("reviewerName", "Client Reviewer"); form.append("reviewerEmail", "reviewer@example.test");
    const response = await fetch("/api/contracts", { method: "POST", body: form }); const result = await response.json() as { contract?: ContractSummary; error?: string };
    setBusy(false); if (!response.ok || !result.contract) { announce(result.error ?? "Unable to create the contract"); return; }
    setNewContractOpen(false); setSwitcherOpen(false); setNewTitle(""); setNewFile(null); announce("Contract created from the Word document."); await loadWorkspace(result.contract.id);
  }

  async function createAccess() {
    if (!contract || !clientParty) return;
    if (contract.id === DEMO_CONTRACT_ID) {
      setCredentials({ username: DEMO_USERNAME, password: DEMO_PASSWORD, link: `${window.location.origin}/review/${contract.id}` }); setShareOpen(true); return;
    }
    const existing = workspace?.access.find((account) => account.status !== "revoked");
    if (existing) { setCredentials({ username: existing.username, password: "Previously generated — create a new contract to issue fresh demo credentials", link: `${window.location.origin}/review/${contract.id}` }); setShareOpen(true); return; }
    setBusy(true); const username = `reviewer.${contract.id.slice(0, 8)}`;
    const response = await fetch(`/api/contracts/${contract.id}/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ partyId: clientParty.id, username, permission: "propose_changes" }) });
    const result = await response.json() as { temporaryPassword?: string; account?: { username: string }; error?: string };
    setBusy(false); if (!response.ok || !result.account || !result.temporaryPassword) { announce(result.error ?? "Unable to create reviewer access"); return; }
    setCredentials({ username: result.account.username, password: result.temporaryPassword, link: `${window.location.origin}/review/${contract.id}` }); setShareOpen(true); await loadContract(contract.id);
  }

  async function agreeAsOwner() {
    if (!contract) return;
    const confirmation = clientAgreed
      ? `Lock version ${contract.current_version} as the final agreement? Both parties will only be able to download it.`
      : `Approve version ${contract.current_version}? It will lock automatically when the client approves this same version.`;
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/agree`, { method: "POST" }); const result = await response.json() as { locked?: boolean; error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to record agreement"); return; }
    announce(result.locked ? "Both parties agreed. The final document is locked." : "Your agreement is recorded for this version."); await loadWorkspace(contract.id);
  }

  function openAi(mode: AiMode = "chat", blockId: string | null = null) {
    setAiMode(mode); setAiTargetBlockId(blockId); setAiDraft(null); setAiOpen(true);
    if (mode === "rewrite" && blockId) setAiInput("Rewrite this paragraph to be clear, balanced, and contract-ready while preserving its commercial intent.");
    else setAiInput("");
  }

  async function sendAiMessage() {
    if (!contract || !aiInput.trim() || !aiAcknowledged || aiBusy) return;
    const message = aiInput.trim(); const messageId = crypto.randomUUID(); const currentMessages = aiMessages[contract.id] ?? [];
    setAiMessages((messages) => ({ ...messages, [contract.id]: [...(messages[contract.id] ?? []), { id: messageId, role: "user", content: message }] }));
    setAiInput(""); setAiBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/ai-assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: aiMode, message, targetBlockId: aiTargetBlockId, history: currentMessages.slice(-12).map(({ role, content }) => ({ role, content })), acknowledgedExternalProcessing: true }) });
    const result = await response.json() as Partial<AiResult> & { error?: string };
    setAiBusy(false);
    if (!response.ok || !result.reply || !result.operation) {
      setAiMessages((messages) => ({ ...messages, [contract.id]: [...(messages[contract.id] ?? []), { id: crypto.randomUUID(), role: "assistant", content: result.error ?? "The assistant is temporarily unavailable." }] }));
      return;
    }
    const completed = { ...result, baseVersion: contract.current_version } as AiResult;
    setAiMessages((messages) => ({ ...messages, [contract.id]: [...(messages[contract.id] ?? []), { id: crypto.randomUUID(), role: "assistant", content: completed.reply, result: completed }] }));
    if (completed.inScope && completed.operation !== "none") setAiDraft({ operation: completed.operation, heading: completed.heading ?? "", paragraphs: completed.paragraphs ?? [], targetBlockId: completed.targetBlockId ?? aiTargetBlockId, replacementText: completed.replacementText ?? "", baseVersion: completed.baseVersion });
  }

  async function applyAiDraft() {
    if (!contract || !aiDraft || aiBusy) return;
    setAiBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/ai-suggestions/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: aiDraft.baseVersion, operation: aiDraft.operation, targetBlockId: aiDraft.targetBlockId, afterBlockId: aiDraft.targetBlockId, heading: aiDraft.heading, paragraphs: aiDraft.paragraphs, replacementText: aiDraft.replacementText }) });
    const result = await response.json() as { versionNumber?: number; error?: string };
    setAiBusy(false); if (!response.ok) { announce(result.error ?? "Unable to apply AI changes"); return; }
    setAiDraft(null); announce(`AI changes applied as Version ${result.versionNumber ?? contract.current_version + 1}.`); await loadWorkspace(contract.id);
  }

  function downloadFinalDocx() {
    if (!contract) return;
    const anchor = document.createElement("a"); anchor.href = `/api/contracts/${contract.id}/download`; anchor.click(); announce("Downloading final agreed Word document.");
  }

  if (signIn) return <main className="portal-container"><div className="portal-card"><h1>Authentication Required</h1><p>Your session expired or you need to sign in to access the contract workspace.</p><a className="portal-button" href={signIn}>Sign in to Pactline</a></div></main>;
  if (loading && !workspace) return <main className="shell-workspace"><div className="loading-state"><span className="spinner-mark"/>Loading contract workspace…</div></main>;
  if (error || !workspace) return <main className="shell-workspace"><div className="error-state"><h1>Workspace unavailable</h1><p>{error || "No contract found"}</p></div></main>;

  const contract = workspace.contract;
  const locked = contract.status === "locked";
  const initiatorParty = workspace.parties.find((party) => party.role === "initiator");
  const clientParty = workspace.parties.find((party) => party.role === "counterparty");
  const pendingProposals = workspace.proposals.filter((proposal) => proposal.status === "pending");
  const ownerAgreed = workspace.agreements.some((agreement) => agreement.party_id === initiatorParty?.id && agreement.version_number === contract.current_version);
  const clientAgreed = workspace.agreements.some((agreement) => agreement.party_id === clientParty?.id && agreement.version_number === contract.current_version);
  const selectedProposal = workspace.proposals.find((proposal) => proposal.id === selectedProposalId);
  const blockMap = new Map(workspace.blocks.map((block) => [block.id, block]));
  const currentMessages = aiMessages[contract.id] ?? [];
  const targetBlock = aiTargetBlockId ? blockMap.get(aiTargetBlockId) : null;

  return <div className="workspace-layout">
    {toast && <div className="toast-notification" role="status">{toast}</div>}
    <header className="app-header">
      <div className="brand-group"><span className="brand-mark">P</span><div><strong className="brand-title">Pactline</strong><span className="brand-subtitle">Contract Collaboration</span></div></div>
      <div className="switcher-wrapper" ref={switcherRef}>
        <button className="switcher-trigger" onClick={() => setSwitcherOpen(!switcherOpen)}><span>{contract.title}</span><small>v{contract.current_version} · {locked ? "Locked" : contract.status}</small><span className="chevron">▾</span></button>
        {switcherOpen && <div className="switcher-dropdown">
          <div className="switcher-header"><span>Your contracts</span><button className="new-contract-btn" onClick={() => { setNewContractOpen(true); setSwitcherOpen(false); }}>+ New</button></div>
          <div className="switcher-list">{contracts.map((item) => <button key={item.id} className={`switcher-item ${item.id === contract.id ? "active" : ""}`} onClick={() => { void loadContract(item.id); setSwitcherOpen(false); }}><div><strong>{item.title}</strong><small>{item.client_company ?? "Client"} · Version {item.current_version}</small></div><span className={`status-pill ${item.status}`}>{item.status}</span></button>)}</div>
        </div>}
      </div>
      <nav className="header-actions">
        <button className="action-btn ai-btn" onClick={() => openAi("chat")}>✨ AI Assistant</button>
        <button className="action-btn workflow-btn" onClick={() => router.push(`/workflow/${contract.id}`)}>Workflow & Approvals</button>
        <button className="action-btn share-btn" onClick={() => void createAccess()}>🔗 Share with reviewer</button>
        <input type="file" ref={fileRef} accept=".docx" style={{ display: "none" }} onChange={(event) => void uploadVersion(event.target.files?.[0])}/>
        <button className="action-btn upload-btn" disabled={busy || locked} onClick={() => fileRef.current?.click()}>📄 Import new .docx</button>
      </nav>
    </header>

    <div className="workspace-body">
      <aside className="sidebar-rail">
        <nav className="sidebar-nav">
          <button className={sidebarView === "contracts" ? "active" : ""} onClick={() => setSidebarView("contracts")}>📁 Contracts ({contracts.length})</button>
          <button className={sidebarView === "queue" ? "active" : ""} onClick={() => setSidebarView("queue")}>📬 Review queue ({pendingProposals.length})</button>
          <button className={sidebarView === "activity" ? "active" : ""} onClick={() => setSidebarView("activity")}>📜 Activity</button>
        </nav>
        {sidebarView === "contracts" && <div className="sidebar-list">{contracts.map((item) => <article key={item.id} className={`sidebar-card ${item.id === contract.id ? "active" : ""}`} onClick={() => void loadContract(item.id)}><h3>{item.title}</h3><p>{item.client_company ?? "Client"} · Version {item.current_version}</p><span className={`status-tag ${item.status}`}>{item.status}</span></article>)}</div>}
        {sidebarView === "queue" && <div className="sidebar-list">{pendingProposals.length ? pendingProposals.map((proposal) => <article key={proposal.id} className={`sidebar-card ${proposal.id === selectedProposalId ? "active" : ""}`} onClick={() => { setSelectedProposalId(proposal.id); setRail("proposals"); }}><h3>Paragraph {blockMap.get(proposal.block_id)?.order_index ? blockMap.get(proposal.block_id)!.order_index + 1 : "—"}</h3><p>Proposed by {proposal.author_display}</p><small>{new Date(proposal.created_at).toLocaleTimeString()}</small></article>) : <p className="empty-rail">No pending proposals awaiting your decision.</p>}</div>}
        {sidebarView === "activity" && <div className="sidebar-list">{workspace.auditLogs.slice(0, 15).map((log) => <article key={log.id} className="activity-card"><strong>{log.actor_display}</strong><span>{readableAction(log.action)}</span><small>{new Date(log.created_at).toLocaleString()}</small></article>)}</div>}
      </aside>

      <main className="document-stage">
        <header className="stage-header">
          <div><h1 className="document-title">{contract.title}</h1><div className="document-meta"><span>Version {contract.current_version}</span><span>·</span><span>{locked ? "Final agreed document" : "Editable workspace"}</span><span>·</span><span>{workspace.blocks.length} paragraphs</span></div></div>
          <div className="stage-controls">
            <div className="tab-group"><button className={tab === "document" ? "active" : ""} onClick={() => setTab("document")}>Document</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Versions ({workspace.versions.length})</button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Audit Log</button></div>
            {locked ? <button className="agree-btn locked" onClick={downloadFinalDocx}>🔒 Download final DOCX</button> : <button className={`agree-btn ${ownerAgreed ? "agreed" : ""}`} disabled={busy || pendingProposals.length > 0} onClick={() => void agreeAsOwner()}>{ownerAgreed ? "✓ Owner approved" : clientAgreed ? "🔒 Lock version" : "✓ Approve version"}</button>}
          </div>
        </header>

        {tab === "document" && <div className="word-editor-stage"><div className="word-page"><div className="document-flow">
          {workspace.blocks.map((block, index) => {
            const editing = editingId === block.id; const proposalsForBlock = workspace.proposals.filter((p) => p.block_id === block.id); const pendingForBlock = proposalsForBlock.find((p) => p.status === "pending");
            return <section className={`doc-paragraph ${block.kind} ${pendingForBlock ? "has-proposal" : ""}`} key={block.id}>
              <span className="paragraph-num">{index + 1}</span>
              {editing ? <div className="paragraph-editor"><label htmlFor={`edit-block-${block.id}`}>Edit paragraph text</label><textarea id={`edit-block-${block.id}`} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={Math.max(3, Math.ceil(editDraft.length / 85))} autoFocus/><div><button disabled={busy} onClick={() => void updateBlock(block.id, editDraft)}>Save change</button><button className="discard" onClick={() => setEditingId(null)}>Cancel</button></div></div> : <div className="paragraph-content" onClick={() => { if (!locked) { setEditingId(block.id); setEditDraft(block.current_text); } }}><span>{block.current_text}</span>{!locked && <button className="edit-hover-btn" title="Edit text">✎ Edit</button>}</div>}
              {!locked && <button className="ai-rewrite-btn" title="Rewrite with AI" onClick={() => openAi("rewrite", block.id)}>✨ AI</button>}
              {pendingForBlock && <div className="inline-proposal-banner" onClick={() => { setSelectedProposalId(pendingForBlock.id); setRail("proposals"); }}><span>Reviewer proposed a change</span><button>View proposal →</button></div>}
            </section>;
          })}
        </div></div></div>}

        {tab === "history" && <section className="versions-table"><h2>Version history</h2><table><thead><tr><th>Version</th><th>Created at</th><th>Created by</th><th>Status</th></tr></thead><tbody>{workspace.versions.map((v) => <tr key={v.version_number}><td>Version {v.version_number}</td><td>{new Date(v.created_at).toLocaleString()}</td><td>{v.created_by ?? "Owner"}</td><td>{v.version_number === contract.current_version ? (locked ? "Locked" : "Current") : "Historical"}</td></tr>)}</tbody></table></section>}

        {tab === "activity" && <section className="activity-table"><h2>Audit trail</h2><table><thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Timestamp</th></tr></thead><tbody>{workspace.auditLogs.map((log) => <tr key={log.id}><td>{log.actor_display}</td><td>{readableAction(log.action)}</td><td>{log.id.slice(0, 8)}</td><td>{new Date(log.created_at).toLocaleString()}</td></tr>)}</tbody></table></section>}
      </main>

      <aside className="detail-rail">
        <nav className="rail-tabs"><button className={rail === "proposals" ? "active" : ""} onClick={() => setRail("proposals")}>Proposals ({pendingProposals.length})</button><button className={rail === "details" ? "active" : ""} onClick={() => setRail("details")}>Contract details</button></nav>
        {rail === "proposals" && <div className="rail-content">
          {selectedProposal ? <article className="proposal-detail-card">
            <header className="proposal-header"><div><strong>Paragraph {blockMap.get(selectedProposal.block_id)?.order_index ? blockMap.get(selectedProposal.block_id)!.order_index + 1 : "—"}</strong><p>Proposed by {selectedProposal.author_display}</p></div><button className="close-btn" onClick={() => setSelectedProposalId(null)}>✕</button></header>
            <div className="diff-view"><div className="diff-box original"><h4>Original text</h4><p><DiffText original={selectedProposal.original_text} proposed={selectedProposal.proposed_text} side="original"/></p></div><div className="diff-box proposed"><h4>Proposed text</h4><p><DiffText original={selectedProposal.original_text} proposed={selectedProposal.proposed_text} side="proposed"/></p></div></div>
            {selectedProposal.rationale && <div className="proposal-rationale"><strong>Reviewer&apos;s rationale:</strong><p>{selectedProposal.rationale}</p></div>}
            {counteringId === selectedProposal.id ? <div className="counter-form"><label htmlFor="counter-text-input">Counterproposal text</label><textarea id="counter-text-input" value={counterDraft} onChange={(e) => setCounterDraft(e.target.value)} rows={4}/><label htmlFor="counter-reason-input">Decision reason (required)</label><input id="counter-reason-input" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="Explain counterproposal intent…"/><div><button disabled={busy || decisionReason.trim().length < 3 || counterDraft.trim() === selectedProposal.original_text} onClick={() => void resolveProposal(selectedProposal.id, "counter", counterDraft)}>Send counterproposal</button><button className="discard" onClick={() => setCounteringId(null)}>Cancel</button></div></div> : <div className="decision-form"><label htmlFor="decision-reason-input">Decision reason (required)</label><input id="decision-reason-input" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="Explain acceptance or rejection rationale…"/><div className="decision-actions"><button className="accept-btn" disabled={busy || decisionReason.trim().length < 3} onClick={() => void resolveProposal(selectedProposal.id, "accept")}>✓ Accept change</button><button className="counter-btn" disabled={busy} onClick={() => { setCounteringId(selectedProposal.id); setCounterDraft(selectedProposal.proposed_text); }}>✎ Counter</button><button className="reject-btn" disabled={busy || decisionReason.trim().length < 3} onClick={() => void resolveProposal(selectedProposal.id, "reject")}>✕ Reject</button></div></div>}
          </article> : pendingProposals.length > 0 ? <div className="proposal-list">{pendingProposals.map((proposal) => <article key={proposal.id} className="proposal-card" onClick={() => setSelectedProposalId(proposal.id)}><div><strong>Paragraph {blockMap.get(proposal.block_id)?.order_index ? blockMap.get(proposal.block_id)!.order_index + 1 : "—"}</strong><p>Proposed by {proposal.author_display}</p></div><button className="proposal-jump">Review →</button></article>)}</div> : <div className="empty-rail-state"><span className="check-icon">✓</span><p>All proposed changes resolved.</p></div>}
        </div>}
        {rail === "details" && <div className="rail-content"><section className="details-card"><h3>Contract metadata</h3><div className="meta-row"><span>Status</span><strong>{contract.status}</strong></div><div className="meta-row"><span>Version</span><strong>v{contract.current_version}</strong></div><div className="meta-row"><span>Initiator</span><strong>{initiatorParty?.name ?? "Contract Owner"}</strong></div><div className="meta-row"><span>Counterparty</span><strong>{clientParty?.name ?? "Client Reviewer"}</strong></div><div className="meta-row"><span>Reviewer Email</span><strong>{clientParty?.email ?? "reviewer@example.test"}</strong></div></section></div>}
      </aside>
    </div>

    {newContractOpen && <div className="modal-backdrop"><form className="modal-card" onSubmit={(e) => { e.preventDefault(); void createContract(); }}><h2>Create new contract</h2><p>Upload a Word document to start a new tracked negotiation.</p><label htmlFor="new-contract-title">Contract title</label><input id="new-contract-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required/><label htmlFor="new-contract-file">Word document (.docx)</label><input id="new-contract-file" type="file" accept=".docx" onChange={(e) => { if (e.target.files?.[0]) { setNewFile(e.target.files[0]); if (!newTitle) setNewTitle(titleFromFilename(e.target.files[0].name)); } }} required/><div className="modal-actions"><button type="button" onClick={() => setNewContractOpen(false)}>Cancel</button><button type="submit" disabled={busy || !newFile || !newTitle.trim()}>Create contract</button></div></form></div>}

    {shareOpen && credentials && <div className="modal-backdrop"><div className="modal-card"><h2>Reviewer access credentials</h2><p>Provide these credentials to the client reviewer to invite them to propose changes.</p><div className="cred-field"><label>Reviewer Link</label><input value={credentials.link} readOnly onClick={(e) => (e.target as HTMLInputElement).select()}/></div><div className="cred-field"><label>Username</label><input value={credentials.username} readOnly/></div><div className="cred-field"><label>Password</label><div><input type={passwordVisible ? "text" : "password"} value={credentials.password ?? ""} readOnly/><button type="button" onClick={() => setPasswordVisible(!passwordVisible)}>{passwordVisible ? "Hide" : "Show"}</button></div></div><div className="modal-actions"><button onClick={() => setShareOpen(false)}>Done</button></div></div></div>}

    {aiOpen && <aside className="ai-drawer"><header className="ai-drawer-header"><div><strong>✨ Pactline AI Assistant</strong><small>Contract analysis & drafting</small></div><button className="close-btn" onClick={() => setAiOpen(false)}>✕</button></header>
      {!aiAcknowledged ? <div className="ai-notice-card"><h3>External Data Processing Notice</h3><p>Pactline AI uses external AI services (Groq / Anthropic API) to analyze contract paragraphs and generate clause rewrites. Contract content will be processed according to strict data protection standards.</p><label className="ack-check"><input type="checkbox" checked={aiAcknowledged} onChange={(e) => setAiAcknowledged(e.target.checked)}/> I acknowledge and authorize external processing of contract text for AI assistance.</label></div> : <div className="ai-chat-body">
        {targetBlock && <div className="ai-target-banner"><span>Targeting Paragraph {targetBlock.order_index + 1}: &quot;{targetBlock.current_text.slice(0, 60)}…&quot;</span><button onClick={() => setAiTargetBlockId(null)}>Clear target</button></div>}
        <div className="ai-messages-list">{currentMessages.map((msg) => <div className={`ai-message ${msg.role}`} key={msg.id}><p>{msg.content}</p></div>)}{aiBusy && <div className="ai-message assistant loading"><span className="spinner-mark"/>Analyzing contract…</div>}<div ref={aiMessagesEndRef}/></div>
        {aiDraft && <div className="ai-draft-card"><h4>Proposed AI Change</h4>{aiDraft.heading && <strong>{aiDraft.heading}</strong>}{aiDraft.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}{aiDraft.replacementText && <p>{aiDraft.replacementText}</p>}<div className="ai-draft-actions"><button disabled={aiBusy} onClick={() => void applyAiDraft()}>Apply to document as Version {contract.current_version + 1}</button><button className="discard" onClick={() => setAiDraft(null)}>Discard</button></div></div>}
        <div className="ai-input-bar"><input value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendAiMessage(); } }} placeholder={aiMode === "rewrite" ? "Describe how to rewrite this paragraph…" : "Ask about terms, risks, or requested changes…"} disabled={aiBusy}/><button disabled={aiBusy || !aiInput.trim()} onClick={() => void sendAiMessage()}>Send</button></div>
      </div>}
    </aside>}
  </div>;
}
