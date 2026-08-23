"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffText, type DiffSegment } from "@/lib/text-diff";

type ContractSummary = { id: string; title: string; status: string; current_version: number; updated_at: string; reviewer_name: string; client_company: string; reviewer_email: string; pending_proposals: number; filename?: string };
type Block = { id: string; block_key: string; order_index: number; kind: "title" | "heading" | "body"; current_text: string };
type Proposal = { id: string; block_id: string; base_version: number; original_text: string; proposed_text: string; counter_text?: string; rationale?: string; status: string; created_at: string; username: string; proposed_by_name: string };
type Party = { id: string; role: "initiator" | "counterparty"; name: string; company: string; email: string };
type Version = { id: string; version_number: number; created_by: string; document_sha256?: string; created_at: string };
type Agreement = { party_id: string; version_number: number; agreed_at: string; role: string; name: string };
type Activity = { id: string; actor_display: string; action: string; target_type: string; version_number?: number; created_at: string };
type Access = { id: string; username: string; permission: string; status: string; expires_at: string; last_signed_in_at?: string; name: string; email: string };
type Workspace = { contract: ContractSummary; blocks: Block[]; proposals: Proposal[]; parties: Party[]; documents: Array<{ id: string; filename: string; byte_size: number; sha256: string; scan_status: string; created_at: string }>; versions: Version[]; agreements: Agreement[]; activity: Activity[]; access: Access[] };
type Credentials = { username: string; password: string; link: string };
type AiMode = "chat" | "draft_clause" | "rewrite" | "check";
type AiFinding = { severity: "attention" | "information"; title: string; explanation: string; blockId: string | null; recommendation: string };
type AiResult = {
  inScope: boolean;
  refusalReason: string | null;
  reply: string;
  operation: "none" | "insert_clause" | "replace_block";
  heading: string | null;
  paragraphs: string[];
  targetBlockId: string | null;
  replacementText: string | null;
  explanation: string | null;
  assumptions: string[];
  findings: AiFinding[];
  model: string;
  baseVersion: number;
};
type AiChatMessage = { id: string; role: "user" | "assistant"; content: string; result?: AiResult };
type AiDraft = { operation: "insert_clause" | "replace_block"; heading: string; paragraphs: string[]; targetBlockId: string | null; replacementText: string; baseVersion: number };

const DEMO_CONTRACT_ID = "sample-services-agreement";
const DEMO_USERNAME = "client.reviewer";
const DEMO_PASSWORD = "ReviewDemo!2026";

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
    const nextId = preferredId || activeId || nextContracts[0]?.id;
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
    if (!switcherOpen) return;
    const closeSwitcher = () => { setSwitcherOpen(false); setNewContractOpen(false); };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeSwitcher(); };
    const handlePointerDown = (event: PointerEvent) => { if (!switcherRef.current?.contains(event.target as Node)) closeSwitcher(); };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); document.removeEventListener("pointerdown", handlePointerDown); };
  }, [switcherOpen]);

  const contract = workspace?.contract;
  const clientParty = workspace?.parties.find((party) => party.role === "counterparty");
  const ownerParty = workspace?.parties.find((party) => party.role === "initiator");
  const pending = workspace?.proposals.filter((proposal) => proposal.status === "pending") ?? [];
  const selectedProposal = workspace?.proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;
  const paragraphNumber = useMemo(() => new Map((workspace?.blocks ?? []).map((block, index) => [block.id, index + 1])), [workspace?.blocks]);
  const ownerAgreed = Boolean(contract && workspace?.agreements.some((agreement) => agreement.role === "initiator" && agreement.version_number === contract.current_version));
  const clientAgreed = Boolean(contract && workspace?.agreements.some((agreement) => agreement.role === "counterparty" && agreement.version_number === contract.current_version));
  const locked = contract?.status === "locked";
  const currentAiMessages = contract ? aiMessages[contract.id] ?? [] : [];
  const aiTargetBlock = workspace?.blocks.find((block) => block.id === aiDraft?.targetBlockId) ?? null;
  const aiApplyBlockedReason = locked ? "The final contract is locked." : pending.length ? "Resolve pending client proposals before applying an AI draft." : "";

  async function saveParagraph(block: Block) {
    if (!contract) return; setBusy(true);
    const response = await fetch(`/api/contracts/${contract.id}/blocks/${block.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: editDraft, baseVersion: contract.current_version }) });
    const result = await response.json() as { error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to save the paragraph"); return; }
    setEditingId(null); announce("Paragraph saved in a new immutable version."); await loadWorkspace(contract.id);
  }

  function focusProposal(proposal: Proposal) {
    setTab("document"); setRail("proposals"); setSidebarView("queue"); setSelectedProposalId(proposal.id); setEditingId(null);
    window.setTimeout(() => document.getElementById(`paragraph-${proposal.block_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }

  async function openReviewQueue() {
    setSidebarView("queue"); setRail("proposals"); setTab("document"); setSwitcherOpen(false);
    const queuedContract = contracts.find((item) => Number(item.pending_proposals) > 0);
    if (!queuedContract) { announce("The review queue is clear."); return; }
    if (queuedContract.id !== activeId) await loadContract(queuedContract.id);
  }

  async function resolveProposal(proposal: Proposal, action: "accept" | "reject" | "counter") {
    if (!contract) return; setBusy(true);
    const resolutionReason = decisionReason.trim() || window.prompt(`Reason for ${action === "counter" ? "countering" : `${action}ing`} this change:`)?.trim() || "";
    if (resolutionReason.length < 3) { setBusy(false); announce("A reason is required before resolving this proposal."); return; }
    const response = await fetch(`/api/contracts/${contract.id}/paragraph-proposals/${proposal.id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, counterText: action === "counter" ? counterDraft : undefined, reason: resolutionReason }) });
    const result = await response.json() as { error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to resolve the proposal"); return; }
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
    setAiBusy(false);
    if (!response.ok) { announce(result.error ?? "Unable to apply the AI draft"); return; }
    setAiDraft(null); announce(`AI draft applied as version ${result.versionNumber}.`); await loadWorkspace(contract.id);
  }

  function focusAiFinding(finding: AiFinding) {
    if (!finding.blockId) return;
    setTab("document"); window.setTimeout(() => document.getElementById(`paragraph-${finding.blockId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  }

  async function resetDemo() {
    if (!contract || contract.id !== DEMO_CONTRACT_ID || !window.confirm("Reset the generic demo contract and remove its demonstration edits?")) return;
    setBusy(true); const response = await fetch("/api/demo/reset", { method: "POST" }); const result = await response.json() as { error?: string };
    setBusy(false); if (!response.ok) { announce(result.error ?? "Unable to reset the demo"); return; }
    announce("The generic demo has been restored."); await loadWorkspace(DEMO_CONTRACT_ID);
  }

  async function copy(value: string, label: string) { await navigator.clipboard.writeText(value); announce(`${label} copied.`); }
  function download(url: string) { const anchor = document.createElement("a"); anchor.href = url; anchor.click(); }

  if (error && !workspace) return <main className="review-portal"><section className="portal-card"><span className="brand-mark">P</span><h1>Pactline</h1><p>{error}</p>{signIn && <a className="primary-link" href={signIn}>Sign in as contract owner</a>}<button onClick={() => void loadWorkspace()}>Try again</button></section></main>;
  if (loading && !workspace) return <main className="review-portal"><section className="portal-card"><span className="portal-spinner"/><p>Preparing your contract workspace…</p></section></main>;

  return <main className="app-shell document-workspace">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">P</span><span>Pactline</span></div><nav aria-label="Main navigation"><button className={`nav-item ${sidebarView === "contracts" ? "active" : ""}`} onClick={() => { setSidebarView("contracts"); setSwitcherOpen(true); }}><span>⌂</span> Contracts <b>{contracts.length}</b></button><button className={`nav-item ${sidebarView === "queue" ? "active" : ""}`} onClick={() => void openReviewQueue()}><span>✓</span> Review queue <b>{contracts.reduce((sum, item) => sum + Number(item.pending_proposals), 0)}</b></button><button className={`nav-item ${sidebarView === "activity" ? "active" : ""}`} onClick={() => { setSidebarView("activity"); setTab("activity"); setSwitcherOpen(false); }}><span>◴</span> Activity</button><a className="nav-item" href="/manage"><span>◇</span> Portfolio <b>V2</b></a></nav><div className="sidebar-bottom"><div className="user"><span className="avatar">CO</span><div><strong>Contract Owner</strong><small>Personal workspace</small></div></div></div></aside>
    <section className="workspace">
      <header className="topbar"><div className="contract-switcher-wrap" ref={switcherRef}><div className="crumb"><button className="crumb-back" onClick={() => setSwitcherOpen(true)}>All contracts</button><b>/</b><button className="contract-switcher-button" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen((value) => !value)}><strong>{contract?.title ?? "Contract"}</strong><span>⌄</span></button></div>{switcherOpen && <section className="company-switcher compact-switcher" role="dialog" aria-label="Choose contract"><div className="company-detail"><div className="switcher-heading"><div><small>Personal workspace</small><h2>Contracts</h2></div><div className="switcher-actions"><button className="upload-contract-button" onClick={() => setNewContractOpen(true)}>+ New contract</button><button className="switcher-close" aria-label="Close contract switcher" onClick={() => { setSwitcherOpen(false); setNewContractOpen(false); }}>×</button></div></div>{newContractOpen && <div className="contract-upload-form"><label>Contract name<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="e.g. Consulting Agreement" /></label><label className="file-drop">Word document<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0] ?? null; setNewFile(file); if (file && !newTitle.trim()) setNewTitle(titleFromFilename(file.name)); }} /><span>{newFile?.name ?? "Choose a .docx file"}</span></label><div><button onClick={() => { setNewContractOpen(false); setNewFile(null); setNewTitle(""); }}>Cancel</button><button className="primary" disabled={busy || !newTitle.trim() || !newFile} onClick={() => void createContract()}>{busy ? "Uploading…" : "Upload and create"}</button></div></div>}<div className="switcher-section">{contracts.map((item) => <button className={`contract-option ${item.id === activeId ? "active" : ""}`} key={item.id} onClick={() => { setSwitcherOpen(false); void loadContract(item.id); }}><span className="word-icon">W</span><span><strong>{item.title}</strong><small>{item.client_company} · Version {item.current_version}</small></span><em>{item.status}</em></button>)}</div></div></section>}</div><div className="top-actions"><span className="saved">✓ Persisted</span><a className="client-preview-button" href={contract ? `/review/${contract.id}` : "#"} target="_blank">Open client view</a><button className="word-export" onClick={() => contract && download(`/api/contracts/${contract.id}/download`)}><span className="word-icon">W</span> {contract?.id === DEMO_CONTRACT_ID ? "Download demo DOCX" : "Download"}</button><button className="share-button" disabled={busy || !contract} onClick={() => void createAccess()}>Share access <span>↗</span></button></div></header>

      <div className="contract-header"><div><div className="title-row"><h1>{contract?.title}</h1><span className={`status-pill ${locked ? "locked-pill" : ""}`}><i /> {locked ? "Agreed and locked" : contract?.status}</span></div><p>{ownerParty?.company ?? "Owner Company"} <span>↔</span> {clientParty?.company ?? "Client Company"} <b>•</b> Version {contract?.current_version}</p></div><div className="people"><span className="person-avatar p1">CO</span><span className="person-avatar p2">CR</span><div><strong>2 parties</strong><small>Every action attributed</small></div></div></div>

      <div className="progress-wrap"><div className="progress-line">{[["Drafted",true],["Shared",locked || Boolean(workspace?.access.length)],["Negotiating",locked],["Owner agreed",locked || ownerAgreed],["Final agreement",locked]].map(([label,done],index) => { const current = label === "Negotiating" && !locked; return <div className={`step ${done ? "done" : current ? "current" : ""}`} key={String(label)}><span>{done ? "✓" : index + 1}</span><div><strong>{label}</strong><small>{label === "Negotiating" && current ? `${pending.length} open` : done ? "Complete" : "Waiting"}</small></div></div>; })}</div></div>

      <div className="content-grid"><section className="document-panel"><div className="tabs"><button className={tab === "document" ? "active" : ""} onClick={() => setTab("document")}>Document</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Version history <span>{workspace?.versions.length ?? 0}</span></button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Audit activity</button>{contract && <a className="workflow-link" href={`/workflow/${contract.id}`}>Lifecycle & redlines</a>}<button className={`owner-lock-button ${clientAgreed && !ownerAgreed ? "ready" : ""}`} disabled={busy || locked || ownerAgreed || pending.length > 0} title={pending.length ? "Resolve every pending proposal first" : clientAgreed ? "The client approved this version; your approval will lock it" : "Approve this version and wait for the client"} onClick={() => void agreeAsOwner()}>{locked ? "🔒 Locked" : ownerAgreed ? "✓ Owner approved" : clientAgreed ? "🔒 Lock version" : "✓ Approve version"}</button><div className="version-select">Version {contract?.current_version}</div></div>
        <div className="word-bar"><div className="word-file"><span className="word-icon">W</span><div><strong>{workspace?.documents[0]?.filename ?? `${contract?.title}.docx`}</strong><small>{contract?.id === DEMO_CONTRACT_ID ? "Editable demo MSA · Safe to reset after every presentation" : "Private Word document · Paragraph review · Immutable versions"}</small></div><span className="synced">✓ Stored</span></div><div className="word-controls"><label className="import-word" aria-disabled={busy || locked}>↑ {contract?.id === DEMO_CONTRACT_ID ? "Upload your DOCX" : "Upload new version"}<input ref={fileRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy || locked} onChange={(event) => void uploadVersion(event.target.files?.[0])} /></label><button onClick={() => contract && download(`/api/contracts/${contract.id}/download`)}>{contract?.id === DEMO_CONTRACT_ID ? "Download demo" : "Download"}</button></div></div>
        {tab === "document" && <div className="word-page"><div className="word-page-meta"><span>{locked ? "Final agreed document" : "Editable working document"}</span><span>{workspace?.blocks.length ?? 0} paragraphs</span></div><div className="document-flow">{workspace?.blocks.map((block) => { const reviewing = selectedProposal?.block_id === block.id ? selectedProposal : null; return <section id={`paragraph-${block.id}`} className={`doc-paragraph ${block.kind} ${reviewing ? "proposal-target" : ""}`} key={block.id}>{editingId === block.id ? <div className="paragraph-editor"><label htmlFor={`block-${block.id}`}>Edit paragraph</label><textarea id={`block-${block.id}`} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} rows={Math.max(3, Math.ceil(editDraft.length / 85))} autoFocus/><div><button onClick={() => setEditingId(null)}>Cancel</button><button className="primary" disabled={busy || !editDraft.trim() || editDraft.trim() === block.current_text} onClick={() => void saveParagraph(block)}>Save new version</button></div></div> : <button className="paragraph-content" disabled={locked || Boolean(reviewing)} aria-label={`Edit paragraph ${paragraphNumber.get(block.id)}`} onClick={() => { setEditingId(block.id); setEditDraft(block.current_text); }}><span>{block.current_text}</span><i>{reviewing ? "In review" : locked ? "Locked" : "Edit"}</i></button>}{reviewing && <div className="inline-proposal-review" aria-live="polite"><div className="inline-review-heading"><div><strong>Client proposal · Paragraph {paragraphNumber.get(block.id)}</strong><span>Only changed words are highlighted below</span></div><button aria-label="Close proposal comparison" onClick={() => { setSelectedProposalId(null); setCounteringId(null); }}>×</button></div><div className="inline-diff"><div className="current-version"><b>Current version</b><p><DiffText original={reviewing.original_text} proposed={reviewing.proposed_text} side="original"/></p></div><div className="proposed-version"><b>Client proposed</b><p><DiffText original={reviewing.original_text} proposed={reviewing.proposed_text} side="proposed"/></p></div></div>{reviewing.status === "pending" && <><div className="inline-decision-row"><button className="accept" disabled={busy} onClick={() => void resolveProposal(reviewing, "accept")}>✓ Accept change</button><button className="counter" disabled={busy} onClick={() => { setCounteringId(reviewing.id); setCounterDraft(reviewing.proposed_text); }}>Counter propose</button><button className="reject" disabled={busy} onClick={() => void resolveProposal(reviewing, "reject")}>Reject change</button></div>{counteringId === reviewing.id && <div className="counter-editor"><label htmlFor={`counter-${reviewing.id}`}>Your counterproposal</label><p>Revise the client’s language below. This will be sent back as the next negotiation position.</p><textarea id={`counter-${reviewing.id}`} value={counterDraft} onChange={(event) => setCounterDraft(event.target.value)} rows={Math.max(4, Math.ceil(counterDraft.length / 85))} autoFocus/><div><button onClick={() => { setCounteringId(null); setCounterDraft(""); }}>Cancel</button><button className="primary" disabled={busy || counterDraft.trim().length < 10 || counterDraft.trim() === reviewing.original_text || counterDraft.trim() === reviewing.proposed_text} onClick={() => void resolveProposal(reviewing, "counter")}>Send counterproposal</button></div></div>}</>}</div>}</section>; })}</div></div>}
        {tab === "history" && <div className="empty-tab"><h2>Version history</h2><p>Every accepted change and owner edit creates a complete immutable snapshot.</p>{workspace?.versions.map((version) => <div className="history-row" key={version.id}><span className="version-dot">v{version.version_number}</span><div><strong>{version.version_number === contract?.current_version ? "Current document" : "Previous document version"}</strong><small>{new Date(version.created_at).toLocaleString()} · {version.document_sha256 ? "File checksum stored" : "Paragraph snapshot stored"}</small></div></div>)}</div>}
        {tab === "activity" && <div className="empty-tab"><h2>Audit activity</h2><p>Uploads, edits, proposals, decisions, agreements, and downloads are attributed.</p>{workspace?.activity.map((item) => <div className="activity-row" key={item.id}><span>{item.actor_display.split(" ").map((part) => part[0]).join("").slice(0,2)}</span><div><strong>{item.actor_display} {readableAction(item.action)}</strong><small>{new Date(item.created_at).toLocaleString()}{item.version_number ? ` · Version ${item.version_number}` : ""}</small></div></div>)}</div>}
      </section>

      <aside className="review-rail"><div className="rail-tabs"><button className={rail === "proposals" ? "active" : ""} onClick={() => setRail("proposals")}>Proposed edits <span>{pending.length}</span></button><button className={rail === "details" ? "active" : ""} onClick={() => setRail("details")}>Details</button></div>{rail === "proposals" ? <><div className="rail-heading"><div><h2>Client changes</h2><p>Changed words are highlighted for quick review</p></div></div><div className="proposal-scroll">{!workspace?.proposals.length && <div className="all-clear"><span>✓</span><h3>No proposed edits yet</h3><p>Share client access to begin a review round.</p></div>}{workspace?.proposals.map((proposal) => <article className={`proposal-card ${proposal.status !== "pending" ? "resolved" : ""} ${selectedProposalId === proposal.id ? "selected" : ""}`} key={proposal.id}><div className="proposal-meta"><span className="mini-avatar">CR</span><div><strong>{proposal.proposed_by_name}</strong><small>{proposal.username} · {new Date(proposal.created_at).toLocaleString()}</small></div><span className={proposal.status === "pending" ? "pending-dot" : `status-text ${proposal.status}`}>{proposal.status}</span></div><button className="proposal-jump" onClick={() => focusProposal(proposal)}><span>Paragraph {paragraphNumber.get(proposal.block_id)} edited</span><b>View in document →</b></button><div className="diff"><div className="removed"><span>−</span><p><DiffText original={proposal.original_text} proposed={proposal.proposed_text} side="original"/></p></div><div className="added"><span>+</span><p><DiffText original={proposal.original_text} proposed={proposal.proposed_text} side="proposed"/></p></div>{proposal.counter_text && <div className="countered-version"><span>↔</span><p><b>Owner counter:</b> {proposal.counter_text}</p></div>}</div>{proposal.status === "pending" && <div className="decision-row"><button className="accept" disabled={busy} onClick={() => void resolveProposal(proposal, "accept")}>✓ Accept</button><button className="counter" disabled={busy} onClick={() => { focusProposal(proposal); setCounteringId(proposal.id); setCounterDraft(proposal.proposed_text); }}>Counter</button><button className="reject" disabled={busy} onClick={() => void resolveProposal(proposal, "reject")}>Reject</button></div>}</article>)}</div></> : <div className="details-panel"><h2>Document details</h2><dl><dt>Owner</dt><dd>{ownerParty?.name}<br/><small>{ownerParty?.company}</small></dd><dt>Reviewer</dt><dd>{clientParty?.name}<br/><small>{clientParty?.email}</small></dd><dt>Source</dt><dd>{workspace?.documents[0]?.filename}<br/><small>Private object storage · Unscanned MVP file</small></dd><dt>Version</dt><dd>Version {contract?.current_version}<br/><small>{workspace?.versions.length} immutable snapshots</small></dd><dt>Owner agreement</dt><dd>{ownerAgreed ? "Recorded" : "Waiting"}</dd><dt>Client agreement</dt><dd>{clientAgreed ? "Recorded" : "Waiting"}</dd></dl><div className="agreement-panel"><strong>{locked ? "Final agreement complete" : clientAgreed ? "Client approved this version" : "Ready to agree?"}</strong><p>{locked ? "This version is locked. Both parties can download the same final Word document." : pending.length ? "Resolve every pending proposal before agreeing." : clientAgreed ? "Lock this exact version by adding the owner’s approval." : "Your approval applies only to the current version and resets if the document changes."}</p><button className="agreement-button" disabled={busy || locked || ownerAgreed || pending.length > 0} onClick={() => void agreeAsOwner()}>{ownerAgreed ? "Owner approval recorded" : clientAgreed ? "Lock this version" : "Approve this version"}</button>{locked && <button className="secondary-download" onClick={() => contract && download(`/api/contracts/${contract.id}/download`)}>Download final DOCX</button>}</div>{contract?.id === DEMO_CONTRACT_ID && <button className="reset-demo-button" disabled={busy} onClick={() => void resetDemo()}>Reset generic demo</button>}</div>}</aside></div>
    </section>

    {shareOpen && credentials && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareOpen(false); }}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title"><button className="modal-close" aria-label="Close sharing dialog" onClick={() => setShareOpen(false)}>×</button><div className="modal-kicker">🔒 Named, password-protected review</div><h2 id="share-title">Share with Client Reviewer</h2><p className="modal-lead">The reviewer can propose paragraph edits and agree to the final version. They cannot overwrite the owner document.</p><div className="access-identity"><span className="client-avatar">CR</span><div><strong>{clientParty?.name}</strong><small>{clientParty?.email} · {clientParty?.company}</small></div><span className="access-role">Reviewer</span></div><div className="credential-grid"><label><span>Secure contract link</span><div><code>{credentials.link}</code><button onClick={() => void copy(credentials.link, "Link")}>Copy</button></div></label><label><span>Username</span><div><code>{credentials.username}</code><button onClick={() => void copy(credentials.username, "Username")}>Copy</button></div></label><label><span>Temporary password</span><div><code>{passwordVisible ? credentials.password : "••••••••••••••••"}</code><button onClick={() => setPasswordVisible((value) => !value)}>{passwordVisible ? "Hide" : "Show"}</button></div></label></div><div className="modal-actions"><a className="preview-login" href={credentials.link} target="_blank">Open client login</a><button className="copy-package" onClick={() => void copy(`Contract: ${credentials.link}\nUsername: ${credentials.username}\nPassword: ${credentials.password}`, "Access package")}>Copy access package</button></div></section></div>}
    <button className={`ai-launcher ${aiOpen ? "open" : ""}`} aria-label="Open AI contract assistant" aria-expanded={aiOpen} onClick={() => aiOpen ? setAiOpen(false) : openAi()}><span>✦</span>{aiOpen ? "Close assistant" : "Ask AI"}</button>
    {aiOpen && <aside className="ai-drawer" role="dialog" aria-modal="false" aria-labelledby="ai-title">
      <header className="ai-drawer-header"><div><span className="ai-spark">✦</span><div><h2 id="ai-title">Contract assistant</h2><p>Owner workspace · Groq-powered</p></div></div><button aria-label="Close AI assistant" onClick={() => setAiOpen(false)}>×</button></header>
      {!aiAcknowledged ? <section className="ai-disclosure"><span className="ai-disclosure-icon">↗</span><h3>Before you begin</h3><p>Your current contract text and messages will be sent to Groq to generate a response. Pactline does not save this chat or the prompt in its audit log.</p><p className="ai-legal-note">AI output may be inaccurate and is not legal advice. You review every draft before it changes the document.</p><button onClick={() => setAiAcknowledged(true)}>I understand and continue</button></section> : <>
        <div className="ai-quick-actions" aria-label="AI actions">
          <button className={aiMode === "chat" ? "active" : ""} onClick={() => { setAiMode("chat"); setAiTargetBlockId(null); }}>Discuss</button>
          <button className={aiMode === "draft_clause" ? "active" : ""} onClick={() => { setAiMode("draft_clause"); setAiTargetBlockId(null); setAiInput("Draft a clause that "); }}>Draft clause</button>
          <button className={aiMode === "rewrite" ? "active" : ""} onClick={() => setAiMode("rewrite")}>Rewrite</button>
          <button className={aiMode === "check" ? "active" : ""} onClick={() => { setAiMode("check"); setAiTargetBlockId(null); setAiInput("Check this contract for ambiguity, missing terms, and commercial risk."); }}>Check document</button>
        </div>
        {aiMode === "rewrite" && <label className="ai-target-select">Paragraph to rewrite<select value={aiTargetBlockId ?? ""} onChange={(event) => setAiTargetBlockId(event.target.value || null)}><option value="">Choose a paragraph</option>{workspace?.blocks.filter((block) => block.kind !== "title").map((block) => <option value={block.id} key={block.id}>{paragraphNumber.get(block.id)}. {block.current_text.slice(0, 64)}</option>)}</select></label>}
        <div className="ai-conversation">
          {!currentAiMessages.length && <div className="ai-empty"><span>✦</span><h3>Work through contract language</h3><p>Ask a question, draft a new clause, rewrite a paragraph, or run a document check. Nothing is applied automatically.</p></div>}
          {currentAiMessages.map((message) => <article className={`ai-message ${message.role}`} key={message.id}><small>{message.role === "user" ? "You" : "Assistant"}</small><p>{message.content}</p>{message.result?.findings?.length ? <div className="ai-findings">{message.result.findings.map((finding, index) => <button key={`${message.id}-${index}`} onClick={() => focusAiFinding(finding)} disabled={!finding.blockId}><span className={`severity ${finding.severity}`}>{finding.severity}</span><strong>{finding.title}</strong><p>{finding.explanation} {finding.recommendation}</p>{finding.blockId && <em>View paragraph →</em>}</button>)}</div> : null}</article>)}
          {aiBusy && <div className="ai-thinking"><i/><i/><i/><span>Reviewing the contract</span></div>}
          <div ref={aiMessagesEndRef}/>
        </div>
        {aiDraft && <section className="ai-draft-card"><div className="ai-draft-heading"><div><span>Editable preview</span><strong>{aiDraft.operation === "replace_block" ? "Paragraph rewrite" : "New clause"}</strong></div><button aria-label="Discard AI draft" onClick={() => setAiDraft(null)}>×</button></div>
          {aiDraft.operation === "replace_block" ? <div className="ai-rewrite-preview"><label>Current version<p>{aiTargetBlock?.current_text ?? "Selected paragraph"}</p></label><label>Proposed version<textarea value={aiDraft.replacementText} onChange={(event) => setAiDraft({ ...aiDraft, replacementText: event.target.value })} rows={Math.max(5, Math.ceil(aiDraft.replacementText.length / 55))}/></label></div> : <div className="ai-clause-preview"><label>Clause heading<input value={aiDraft.heading} onChange={(event) => setAiDraft({ ...aiDraft, heading: event.target.value })}/></label>{aiDraft.paragraphs.map((paragraph, index) => <label key={index}>Paragraph {index + 1}<textarea value={paragraph} onChange={(event) => setAiDraft({ ...aiDraft, paragraphs: aiDraft.paragraphs.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} rows={Math.max(4, Math.ceil(paragraph.length / 55))}/></label>)}<label>Place after<select value={aiDraft.targetBlockId ?? ""} onChange={(event) => setAiDraft({ ...aiDraft, targetBlockId: event.target.value || null })}><option value="">End of document</option>{workspace?.blocks.map((block) => <option value={block.id} key={block.id}>{paragraphNumber.get(block.id)}. {block.current_text.slice(0, 58)}</option>)}</select></label></div>}
          {aiApplyBlockedReason && <p className="ai-apply-warning">{aiApplyBlockedReason}</p>}<button className="ai-apply" disabled={aiBusy || Boolean(aiApplyBlockedReason) || (aiDraft.operation === "replace_block" ? aiDraft.replacementText.trim().length < 10 : !aiDraft.heading.trim() || !aiDraft.paragraphs.some((paragraph) => paragraph.trim().length >= 10))} onClick={() => void applyAiDraft()}>Apply as new version</button><small>Creates an immutable version and audit entry. The prompt and chat remain session-only.</small>
        </section>}
        <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); void sendAiMessage(); }}><textarea value={aiInput} maxLength={4000} onChange={(event) => setAiInput(event.target.value)} placeholder={aiMode === "draft_clause" ? "Describe the clause you need…" : aiMode === "rewrite" ? "How should this paragraph change?" : aiMode === "check" ? "What should the review focus on?" : "Ask about this contract…"} rows={3}/><div><span>{aiInput.length}/4000 · not legal advice</span><button disabled={aiBusy || !aiInput.trim() || (aiMode === "rewrite" && !aiTargetBlockId)} aria-label="Send message">↑</button></div></form>
      </>}
    </aside>}
    <div className="toast-region" aria-live="polite">{toast && <div className="toast"><span>✓</span>{toast}</div>}</div>
  </main>;
}
