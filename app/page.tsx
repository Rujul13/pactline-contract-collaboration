"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createDocumentDocx, type DocumentBlock, inspectDocx } from "../lib/docx";

type ReviewStatus = "accepted" | "rejected";
type Proposal = { id: string; blockId: string; before: string; after: string; author: string; username: string; time: string };
type ContractItem = { id: string; title: string; documentTitle: string; status: string; updated: string; fileName?: string };

const initialBlocks: DocumentBlock[] = [
  { id: "p1", kind: "title", text: "MASTER SERVICES AGREEMENT" },
  { id: "p2", kind: "body", text: "This Master Services Agreement (the “Agreement”) is entered into as of August 12, 2026 by and between Northstar Labs, Inc., a Delaware corporation, and Brightline Studio LLC, a New York limited liability company." },
  { id: "p3", kind: "body", text: "The parties agree that the following terms will govern the services described in any statement of work executed under this Agreement." },
  { id: "p4", kind: "heading", text: "1. Services" },
  { id: "p5", kind: "body", text: "Northstar will provide product strategy, interface design, and implementation support as described in each applicable statement of work. Each statement of work will identify the deliverables, schedule, fees, and acceptance criteria for the services." },
  { id: "p6", kind: "body", text: "Northstar will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience." },
  { id: "p7", kind: "heading", text: "2. Fees and payment" },
  { id: "p8", kind: "body", text: "Brightline will pay all undisputed invoices within thirty (30) days after receipt. Fees are exclusive of applicable taxes and approved, reasonable out-of-pocket expenses." },
  { id: "p9", kind: "body", text: "If Brightline disputes an invoice in good faith, it will notify Northstar promptly and the parties will work together to resolve the disputed amount." },
  { id: "p10", kind: "heading", text: "3. Confidentiality" },
  { id: "p11", kind: "body", text: "Each party will protect the other party’s Confidential Information using at least the same degree of care it uses for its own information of similar importance, and no less than reasonable care." },
  { id: "p12", kind: "body", text: "Confidential Information may be used only to perform or receive services under this Agreement and may be disclosed only to personnel who need to know it and are bound by confidentiality obligations." },
  { id: "p13", kind: "heading", text: "4. Term and termination" },
  { id: "p14", kind: "body", text: "This Agreement begins on the effective date and continues for twelve months. Either party may terminate for material breach if the breach remains uncured for fifteen (15) days after written notice." },
  { id: "p15", kind: "heading", text: "5. Limitation of liability" },
  { id: "p16", kind: "body", text: "Except for excluded claims, each party’s aggregate liability under this Agreement will not exceed the fees paid or payable during the twelve months preceding the event giving rise to the claim." },
  { id: "p17", kind: "heading", text: "6. General" },
  { id: "p18", kind: "body", text: "This Agreement and its statements of work constitute the entire agreement between the parties concerning their subject matter and may be amended only in a writing signed by both parties." },
];

const companies = [
  { id: "brightline", name: "Brightline Studio", initials: "BS", contacts: [{ name: "Maya Chen", role: "General Counsel", email: "maya@brightline.studio" }, { name: "Theo Grant", role: "Finance Director", email: "theo@brightline.studio" }, { name: "Priya Shah", role: "Operations", email: "priya@brightline.studio" }], contracts: [{ id: "brightline-msa", title: "Brightline MSA", documentTitle: "Master Services Agreement", status: "Negotiating", updated: "Updated today" }, { id: "brightline-dpa", title: "Brightline DPA", documentTitle: "Data Processing Addendum", status: "Draft", updated: "Updated Jul 28" }] },
  { id: "aperture", name: "Aperture Health", initials: "AH", contacts: [{ name: "Elena Park", role: "Head of Legal", email: "elena@aperture.health" }, { name: "Marcus Bell", role: "Procurement", email: "marcus@aperture.health" }], contracts: [{ id: "aperture-msa", title: "Aperture MSA", documentTitle: "Master Services Agreement", status: "Internal review", updated: "Updated yesterday" }] },
  { id: "orbit", name: "Orbit Systems", initials: "OS", contacts: [{ name: "Noah Williams", role: "Commercial Counsel", email: "noah@orbit.systems" }, { name: "Sofia Rossi", role: "VP Partnerships", email: "sofia@orbit.systems" }], contracts: [{ id: "orbit-order", title: "Orbit Order Form", documentTitle: "Enterprise Order Form", status: "Draft", updated: "Updated Jul 26" }] },
];

function temporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#";
  const values = crypto.getRandomValues(new Uint8Array(16));
  return [...values].map((value) => alphabet[value % alphabet.length]).join("");
}

export default function Home() {
  const [blocks, setBlocks] = useState<DocumentBlock[]>(initialBlocks);
  const [mode, setMode] = useState<"owner" | "client">("owner");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [clientDrafts, setClientDrafts] = useState<Record<string, string>>({});
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ReviewStatus>>({});
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [version, setVersion] = useState(3);
  const [tab, setTab] = useState<"document" | "history" | "activity">("document");
  const [rail, setRail] = useState<"proposals" | "details">("proposals");
  const [mobilePane, setMobilePane] = useState<"document" | "review">("document");
  const [toast, setToast] = useState("");
  const [importReview, setImportReview] = useState<Awaited<ReturnType<typeof inspectDocx>> | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [loginPreview, setLoginPreview] = useState(false);
  const [clientSignedIn, setClientSignedIn] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(null);
  const [loginFields, setLoginFields] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState("brightline");
  const [activeContractId, setActiveContractId] = useState("brightline-msa");
  const [uploadedContracts, setUploadedContracts] = useState<Record<string, ContractItem[]>>({});
  const [uploadingContract, setUploadingContract] = useState(false);
  const [newContractTitle, setNewContractTitle] = useState("");
  const [newContractFile, setNewContractFile] = useState<File | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId) ?? companies[0];
  const companyContracts = [...selectedCompany.contracts, ...(uploadedContracts[selectedCompany.id] ?? [])];
  const activeContract = companies.flatMap((company) => [...company.contracts, ...(uploadedContracts[company.id] ?? [])]).find((contract) => contract.id === activeContractId) ?? companies[0].contracts[0];
  const openProposals = proposals.filter((proposal) => !statuses[proposal.id]);
  const stagedCount = Object.keys(clientDrafts).length;
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? openProposals[0];
  const paragraphNumber = useMemo(() => new Map(blocks.map((block, index) => [block.id, index + 1])), [blocks]);

  function announce(message: string, duration = 2800) {
    setToast(message);
    window.setTimeout(() => setToast(""), duration);
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    announce(`${label} copied.`);
  }

  function openShare() {
    const next = credentials ?? { username: "brightline.maya", password: temporaryPassword() };
    setCredentials(next);
    setLoginFields({ username: next.username, password: "" });
    setLoginPreview(false);
    setClientSignedIn(false);
    setLoginError("");
    setShareOpen(true);
  }

  useEffect(() => {
    if (!shareOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareOpen(false);
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shareOpen]);

  function beginEdit(block: DocumentBlock) {
    setEditingId(block.id);
    setEditDraft(clientDrafts[block.id] ?? block.text);
  }

  function saveParagraph(block: DocumentBlock) {
    const next = editDraft.trim();
    if (!next || next === block.text) { setEditingId(null); return; }
    if (mode === "client") {
      setClientDrafts((current) => ({ ...current, [block.id]: next }));
      announce("Edit staged. Submit all edits when your review is complete.");
    } else {
      setBlocks((current) => current.map((item) => item.id === block.id ? { ...item, text: next } : item));
      setVersion((current) => current + 1);
      announce("Paragraph updated in a new document version.");
    }
    setEditingId(null);
  }

  function discardClientDraft(blockId: string) {
    setClientDrafts((current) => { const next = { ...current }; delete next[blockId]; return next; });
    setEditingId(null);
  }

  function submitClientChanges() {
    const created = Object.entries(clientDrafts).map(([blockId, after], index) => ({ id: `client-${Date.now()}-${index}`, blockId, before: blocks.find((block) => block.id === blockId)?.text ?? "", after, author: "Maya Chen", username: "brightline.maya", time: "Just now" }));
    setProposals((current) => [...created, ...current]);
    setSelectedProposalId(created[0]?.id ?? null);
    setClientDrafts({});
    setRail("proposals");
    announce(`${created.length} proposed ${created.length === 1 ? "change" : "changes"} sent to Northstar.`);
  }

  function resolveProposal(proposal: Proposal, status: ReviewStatus) {
    setStatuses((current) => ({ ...current, [proposal.id]: status }));
    if (status === "accepted") {
      setBlocks((current) => current.map((block) => block.id === proposal.blockId ? { ...block, text: proposal.after } : block));
      setVersion((current) => current + 1);
    }
    announce(status === "accepted" ? "Proposed paragraph edit accepted into a new version." : "Proposed edit rejected and recorded.");
  }

  async function importWord(file?: File) {
    if (!file) return;
    try { setImportReview(await inspectDocx(file)); announce("Word document parsed. Review it before replacing the current document."); }
    catch (error) { announce(error instanceof Error ? error.message : "The Word document could not be read.", 3400); }
  }

  function useImportedDocument() {
    if (!importReview) return;
    setBlocks(importReview.blocks);
    setVersion((current) => current + 1);
    setProposals([]); setStatuses({}); setClientDrafts({});
    setImportReview(null);
    announce("The uploaded Word document is now open as editable paragraphs.");
  }

  async function addContract() {
    if (!newContractFile || !newContractTitle.trim()) return;
    try {
      const parsed = await inspectDocx(newContractFile);
      const contract: ContractItem = { id: `${selectedCompany.id}-${Date.now()}`, title: newContractTitle.trim(), documentTitle: parsed.blocks.find((block) => block.kind === "title")?.text ?? newContractTitle.trim(), status: "Draft", updated: "Added just now", fileName: parsed.name };
      setUploadedContracts((current) => ({ ...current, [selectedCompany.id]: [...(current[selectedCompany.id] ?? []), contract] }));
      setActiveContractId(contract.id); setBlocks(parsed.blocks); setVersion(1); setProposals([]); setStatuses({}); setClientDrafts({});
      setUploadingContract(false); setCompanyMenuOpen(false); setNewContractFile(null); setNewContractTitle("");
      announce(`${contract.title} uploaded and opened.`);
    } catch (error) { announce(error instanceof Error ? error.message : "Choose a valid Word document.", 3400); }
  }

  function chooseContract(companyId: string, contract: ContractItem) {
    setSelectedCompanyId(companyId); setActiveContractId(contract.id); setCompanyMenuOpen(false); setUploadingContract(false);
    setBlocks(initialBlocks); setVersion(3); setProposals([]); setStatuses({}); setClientDrafts({});
    announce(`${contract.title} opened.`);
  }

  function exportWord() {
    const blob = createDocumentDocx(activeContract.documentTitle, version, blocks);
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${activeContract.title.replace(/\s+/g, "-")}-v${version}.docx`; anchor.click(); URL.revokeObjectURL(url);
    announce(`${activeContract.title} version ${version} exported.`);
  }

  return <main className={`app-shell document-workspace ${mode === "client" ? "client-mode" : ""}`}>
    {mode === "owner" && <aside className="sidebar"><div className="brand"><span className="brand-mark">P</span><span>Pactline</span></div><nav aria-label="Main navigation"><button className="nav-item active"><span>⌂</span> Contracts <b>8</b></button><button className="nav-item"><span>▤</span> Templates</button><button className="nav-item"><span>✓</span> Approvals</button><button className="nav-item"><span>◴</span> Activity</button></nav><div className="sidebar-bottom"><button className="nav-item"><span>⚙</span> Settings</button><div className="user"><span className="avatar">AK</span><div><strong>Alex Kim</strong><small>Legal Operations</small></div></div></div></aside>}
    <section className="workspace">
      <header className="topbar">
        {mode === "owner" ? <div className="contract-switcher-wrap"><div className="crumb"><button className="crumb-back" onClick={() => setCompanyMenuOpen(true)}>All companies</button><b>/</b><button className="contract-switcher-button" aria-expanded={companyMenuOpen} onClick={() => setCompanyMenuOpen((open) => !open)}><strong>{activeContract.title}</strong><span>⌄</span></button></div>{companyMenuOpen && <section className="company-switcher" role="dialog" aria-label="Choose company and contract"><div className="company-list"><div className="switcher-heading"><span>Companies</span><small>{companies.length} active</small></div>{companies.map((company) => <button key={company.id} className={selectedCompany.id === company.id ? "active" : ""} onClick={() => { setSelectedCompanyId(company.id); setUploadingContract(false); }}><span className="company-initials">{company.initials}</span><span><strong>{company.name}</strong><small>{company.contracts.length + (uploadedContracts[company.id]?.length ?? 0)} contracts · {company.contacts.length} contacts</small></span><i>›</i></button>)}</div><div className="company-detail"><div className="switcher-heading"><div><small>Company</small><h2>{selectedCompany.name}</h2></div><button className="upload-contract-button" onClick={() => setUploadingContract(true)}>+ Upload Word document</button></div>{uploadingContract && <div className="contract-upload-form"><label>Contract name<input value={newContractTitle} onChange={(event) => setNewContractTitle(event.target.value)} placeholder="e.g. Services agreement" autoFocus /></label><label className="file-drop">Word document<input type="file" accept=".docx" onChange={(event) => setNewContractFile(event.target.files?.[0] ?? null)} /><span>{newContractFile?.name ?? "Choose a .docx file"}</span></label><div><button onClick={() => setUploadingContract(false)}>Cancel</button><button className="primary" disabled={!newContractTitle.trim() || !newContractFile} onClick={() => void addContract()}>Open document</button></div></div>}<div className="switcher-section"><h3>Contracts</h3>{companyContracts.map((contract) => <button className={`contract-option ${activeContract.id === contract.id ? "active" : ""}`} key={contract.id} onClick={() => chooseContract(selectedCompany.id, contract)}><span className="word-icon">W</span><span><strong>{contract.title}</strong><small>{contract.fileName ?? contract.documentTitle} · {contract.updated}</small></span><em>{contract.status}</em></button>)}</div><div className="switcher-section contacts"><h3>Contacts</h3>{selectedCompany.contacts.map((contact) => <div className="contact-row" key={contact.email}><span>{contact.name.split(" ").map((part) => part[0]).join("")}</span><div><strong>{contact.name}</strong><small>{contact.role} · {contact.email}</small></div></div>)}</div></div></section>}</div> : <div className="client-brand"><span className="brand-mark">P</span><div><strong>Client review</strong><small>{activeContract.title} · Signed in as Maya Chen</small></div></div>}
        <div className="top-actions">{mode === "owner" ? <><span className="saved">✓ Saved</span><button className="client-preview-button" onClick={() => { setMode("client"); setMobilePane("document"); }}>Preview client view</button><button className="word-export" onClick={exportWord}><span className="word-icon">W</span> Export .docx</button><button className="share-button" onClick={openShare}>Share access <span>↗</span></button></> : <><span className="client-safe"><b>Review mode</b> Your edits will not change the original</span><button className="return-owner" onClick={() => setMode("owner")}>Return to owner view</button></>}</div>
      </header>

      <div className="contract-header"><div><div className="title-row"><h1>{activeContract.documentTitle}</h1><span className="status-pill"><i /> {mode === "client" ? "Client review" : activeContract.status}</span></div><p>Northstar Labs <span>↔</span> {selectedCompany.name} <b>•</b> Version {version}</p></div>{mode === "client" && <div className="client-reviewer"><span>MC</span><div><strong>Maya Chen</strong><small>Edits are attributed to your account</small></div></div>}</div>

      {mode === "owner" && <div className="progress-wrap"><div className="progress-line">{[["Drafted","Jul 24"],["Approved","Jul 25"],["Shared","Jul 26"],["Negotiating",`${openProposals.length} open`],["Agreed","—"]].map(([label,meta],index)=><div className={`step ${index<3?"done":index===3?"current":""}`} key={label}><span>{index<3?"✓":index+1}</span><div><strong>{label}</strong><small>{meta}</small></div></div>)}</div></div>}

      <div className="mobile-pane-bar"><button className={mobilePane === "document" ? "active" : ""} onClick={() => setMobilePane("document")}>Document</button>{mode === "owner" && <button className={mobilePane === "review" ? "active" : ""} onClick={() => setMobilePane("review")}>Proposed edits <span>{openProposals.length}</span></button>}</div>

      <div className={`content-grid mobile-${mobilePane} ${mode === "client" ? "client-content" : ""}`}>
        <section className="document-panel">
          <div className="tabs"><button className={tab === "document" ? "active" : ""} onClick={() => setTab("document")}>Document</button>{mode === "owner" && <><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Version history <span>{version}</span></button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Audit activity</button></>}<div className="version-select">Version {version} <span>⌄</span></div></div>
          <div className="word-bar"><div className="word-file"><span className="word-icon">W</span><div><strong>{activeContract.title} v{version}.docx</strong><small>Word document · Paragraph-level editing · Stable clause controls</small></div><span className="synced">✓ Synced</span></div>{mode === "owner" ? <div className="word-controls"><label className="import-word">↑ Upload new .docx<input type="file" accept=".docx" onChange={(event) => void importWord(event.target.files?.[0])} /></label><button onClick={exportWord}>Download</button></div> : <span className="client-edit-help">Click any paragraph to propose an edit</span>}</div>

          {importReview && <div className="import-review"><span className="word-icon">W</span><div><strong>{importReview.name}</strong><p>{importReview.paragraphs.length} paragraphs found · {(importReview.size/1024).toFixed(1)} KB</p></div><button onClick={() => setImportReview(null)}>Cancel</button><button className="primary" onClick={useImportedDocument}>Use this document</button></div>}

          {tab === "document" && <div className="word-page"><div className="word-page-meta"><span>Page 1 of {blocks.length > 16 ? 2 : 1}</span><span>{blocks.length} paragraphs</span></div>{mode === "client" && <div className="client-instructions"><span>✎</span><div><strong>Suggest changes directly in the document</strong><p>Edit as many paragraphs as you need. Nothing changes until the owner accepts your proposals.</p></div></div>}<div className="document-flow">{blocks.map((block) => { const staged = clientDrafts[block.id]; const editing = editingId === block.id; return <div className={`doc-paragraph ${block.kind} ${staged ? "staged" : ""} ${editing ? "editing" : ""}`} key={block.id}>{editing ? <div className="paragraph-editor"><label htmlFor={`paragraph-${block.id}`}>{mode === "client" ? "Proposed paragraph text" : "Edit paragraph"}</label><textarea id={`paragraph-${block.id}`} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} rows={Math.max(3, Math.ceil(editDraft.length/85))} autoFocus /><div><button onClick={() => setEditingId(null)}>Cancel</button>{mode === "client" && staged && <button className="discard" onClick={() => discardClientDraft(block.id)}>Discard proposal</button>}<button className="primary" disabled={!editDraft.trim() || editDraft.trim() === block.text} onClick={() => saveParagraph(block)}>{mode === "client" ? "Stage proposal" : "Save new version"}</button></div></div> : <button className="paragraph-content" onClick={() => beginEdit(block)} aria-label={`${mode === "client" ? "Propose edit to" : "Edit"} paragraph ${paragraphNumber.get(block.id)}`}><span>{staged ?? block.text}</span><i>{staged ? "Proposed" : "Edit"}</i></button>}{staged && !editing && <div className="staged-note"><span>Proposed change</span><button onClick={() => beginEdit(block)}>Revise</button><button onClick={() => discardClientDraft(block.id)}>Discard</button></div>}</div>;})}</div></div>}

          {tab === "history" && <div className="empty-tab"><h2>Version history</h2><p>Every accepted or owner-saved paragraph change creates a full document snapshot.</p>{Array.from({length:Math.min(version,5)},(_,index)=>version-index).map((value,index)=><div className="history-row" key={value}><span className="version-dot">v{value}</span><div><strong>{index===0?"Current document":"Previous document version"}</strong><small>{index===0?"Current · Integrity hash recorded":`${index} day${index===1?"":"s"} ago · Verified actor`}</small></div><button onClick={()=>announce(`Comparing version ${value}.`)}>Compare</button></div>)}</div>}
          {tab === "activity" && <div className="empty-tab"><h2>Audit activity</h2><p>Every paragraph edit, proposal, decision, and export is attributed to a named account.</p>{["Maya Chen opened the shared Word document","Alex Kim uploaded Brightline MSA.docx","Jordan Lee approved external review"].map((item,index)=><div className="activity-row" key={item}><span>{index===0?"MC":index===1?"AK":"JL"}</span><div><strong>{item}</strong><small>{18+index*32} minutes ago · Authenticated account</small></div></div>)}</div>}
        </section>

        {mode === "owner" && <aside className="review-rail"><div className="rail-tabs"><button className={rail === "proposals" ? "active" : ""} onClick={() => setRail("proposals")}>Proposed edits <span>{openProposals.length}</span></button><button className={rail === "details" ? "active" : ""} onClick={() => setRail("details")}>Details</button></div>{rail === "proposals" ? <><div className="rail-heading"><div><h2>Client changes</h2><p>Paragraph edits submitted for your decision</p></div></div><div className="proposal-scroll">{proposals.length === 0 && <div className="all-clear"><span>✓</span><h3>No proposed edits yet</h3><p>Open “Preview client view” to see how the counterparty edits and submits the document.</p></div>}{proposals.map((proposal) => { const status = statuses[proposal.id]; return <article className={`proposal-card ${selectedProposal?.id === proposal.id ? "selected" : ""} ${status ? "resolved" : ""}`} key={proposal.id} onClick={() => setSelectedProposalId(proposal.id)}><div className="proposal-meta"><span className="mini-avatar">MC</span><div><strong>{proposal.author}</strong><small>{proposal.username} · {proposal.time}</small></div>{status ? <span className={`status-text ${status}`}>{status}</span> : <span className="pending-dot">Pending</span>}</div><h3>Paragraph {paragraphNumber.get(proposal.blockId)} edited</h3><div className="ai-label"><span>✦</span> AI-structured proposal <i>Human submitted</i></div><div className="diff"><div className="removed"><span>−</span><p>{proposal.before}</p></div><div className="added"><span>+</span><p>{proposal.after}</p></div></div>{!status && <div className="decision-row"><button className="accept" onClick={(event) => { event.stopPropagation(); resolveProposal(proposal,"accepted"); }}>✓ Accept change</button><button onClick={(event) => { event.stopPropagation(); resolveProposal(proposal,"rejected"); }}>Reject</button></div>}</article>;})}</div></> : <div className="details-panel"><h2>Document details</h2><dl><dt>Owner</dt><dd>Alex Kim</dd><dt>Counterparty</dt><dd>{selectedCompany.contacts[0]?.name}<br/><small>{selectedCompany.contacts[0]?.email}</small></dd><dt>Source</dt><dd>{activeContract.fileName ?? `${activeContract.title}.docx`}<br/><small>{blocks.length} editable paragraphs</small></dd><dt>Review model</dt><dd>Client proposals<br/><small>Owner approval required</small></dd><dt>Current version</dt><dd>Version {version}<br/><small>Full snapshot retained</small></dd></dl></div>}</aside>}
      </div>

      {mode === "client" && <div className="client-submit-bar"><div><strong>{stagedCount ? `${stagedCount} proposed ${stagedCount === 1 ? "change" : "changes"} ready` : "Review the document paragraph by paragraph"}</strong><small>{stagedCount ? "The owner will receive before-and-after text for every edit." : "Click a paragraph to begin editing."}</small></div><button disabled={!stagedCount} onClick={submitClientChanges}>Submit {stagedCount || ""} proposed {stagedCount === 1 ? "change" : "changes"}</button></div>}
    </section>

    {shareOpen && credentials && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareOpen(false); }}><section ref={modalRef} className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title"><button ref={closeRef} className="modal-close" aria-label="Close sharing dialog" onClick={() => setShareOpen(false)}>×</button>{!loginPreview ? <><div className="modal-kicker">🔒 Named, password-protected client access</div><h2 id="share-title">Share with Maya Chen</h2><p className="modal-lead">Maya can edit paragraphs and submit proposed changes. She cannot overwrite the original document.</p><div className="access-identity"><span className="client-avatar">MC</span><div><strong>Maya Chen</strong><small>maya@brightline.studio · Brightline Studio</small></div><span className="access-role">Reviewer</span></div><div className="credential-grid"><label><span>Secure contract link</span><div><code>pactline.app/review/bl-2048</code><button onClick={() => void copy("https://pactline.app/review/bl-2048","Link")}>Copy</button></div></label><label><span>Username</span><div><code>{credentials.username}</code><button onClick={() => void copy(credentials.username,"Username")}>Copy</button></div></label><label><span>Temporary password</span><div><code>{passwordVisible ? credentials.password : "••••••••••••••••"}</code><button onClick={() => setPasswordVisible((value) => !value)}>{passwordVisible?"Hide":"Show"}</button></div></label></div><div className="modal-actions"><button className="preview-login" onClick={() => setLoginPreview(true)}>Preview client login</button><button className="copy-package" onClick={() => void copy(`Contract: https://pactline.app/review/bl-2048\nUsername: ${credentials.username}\nTemporary password: ${credentials.password}`,"Access package")}>Copy access package</button></div></> : !clientSignedIn ? <form className="login-form" onSubmit={(event) => { event.preventDefault(); if(loginFields.username===credentials.username && loginFields.password===credentials.password){setClientSignedIn(true);setLoginError("");}else setLoginError("The username or password is incorrect."); }}><span className="login-lock">🔒</span><h2 id="share-title">Sign in to review</h2><p>{activeContract.documentTitle}<br/><b>Northstar Labs ↔ {selectedCompany.name}</b></p><label htmlFor="client-username">Username</label><input id="client-username" value={loginFields.username} onChange={(event)=>setLoginFields((current)=>({...current,username:event.target.value}))}/><label htmlFor="client-password">Temporary password</label><input id="client-password" type="password" value={loginFields.password} onChange={(event)=>setLoginFields((current)=>({...current,password:event.target.value}))}/>{loginError&&<p className="form-error">{loginError}</p>}<button type="submit">Sign in securely</button></form> : <div className="login-success"><span>✓</span><h2>Signed in as Maya Chen</h2><p>You can propose paragraph edits. The original stays unchanged until Northstar accepts them.</p><button onClick={() => { setShareOpen(false); setMode("client"); }}>Open client review</button></div>}</section></div>}
    <div className="toast-region" aria-live="polite">{toast && <div className="toast"><span>✓</span>{toast}</div>}</div>
  </main>;
}
