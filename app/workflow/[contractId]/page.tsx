"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type Contract = { id: string; title: string; status: string; current_version: number; lifecycle_stage: string; renewal_date?: string; notice_period_days: number; contract_value_minor?: number; currency: string; risk_level: string; review_deadline_at?: string; responsible_owner_name?: string };
type Block = { id: string; kind: string; current_text: string };
type Version = { version_number: number };
type Comment = { id: string; block_id: string; author_display: string; body: string; status: string; created_at: string };
type Approval = { id: string; version_number: number; kind: string; status: string; decision_reason?: string };
type ReviewRound = { id: string; round_number: number; status: string; deadline_at?: string };
type Reminder = { id: string; kind: string; channel: string; due_at: string; status: string };
type Relationship = { id: string; relationship_type: string; source_title: string; target_title: string };
type ErrorEvent = { id: string; request_id: string; route: string; severity: string; message: string; occurrence_count: number; last_seen_at: string; resolved_at?: string };
type Workflow = { contract: Contract; reviewRounds: ReviewRound[]; comments: Comment[]; approvals: Approval[]; relationships: Relationship[]; reminders: Reminder[]; errors: ErrorEvent[] };
type Workspace = { blocks: Block[]; versions: Version[] };
type Segment = { text: string; changed: boolean };
type Comparison = { changedCount: number; blocks: Array<{ key: string; kind: string; changed: boolean; diff: { original: Segment[]; proposed: Segment[] } }> };

const title = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const dateInput = (value?: string) => value ? new Date(value).toISOString().slice(0, 10) : "";
const dateTimeInput = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const instantOrUndefined = (value: string) => value ? new Date(value).toISOString() : undefined;

export default function ContractWorkflowPage({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = use(params);
  const router = useRouter();
  const [workflow, setWorkflow] = useState<Workflow | null>(null); const [workspace, setWorkspace] = useState<Workspace | null>(null); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ lifecycleStage: "draft", renewalDate: "", noticePeriodDays: "30", contractValue: "", currency: "USD", riskLevel: "medium", reviewDeadlineAt: "" });
  const [roundDeadline, setRoundDeadline] = useState(""); const [roundReason, setRoundReason] = useState(""); const [approvalKind, setApprovalKind] = useState("legal"); const [approvalReason, setApprovalReason] = useState("");
  const [commentBlock, setCommentBlock] = useState(""); const [commentBody, setCommentBody] = useState(""); const [fromVersion, setFromVersion] = useState(1); const [toVersion, setToVersion] = useState(1); const [comparison, setComparison] = useState<Comparison | null>(null); const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const [workflowResponse, workspaceResponse] = await Promise.all([fetch(`/api/contracts/${contractId}/workflow`, { cache: "no-store" }), fetch(`/api/contracts/${contractId}/workspace`, { cache: "no-store" })]);
    if (workflowResponse.status === 401) { router.replace(`/owner/login?return_to=${encodeURIComponent(`/workflow/${contractId}`)}`); return; }
    const workflowResult = await workflowResponse.json() as Workflow & { error?: string }; const workspaceResult = await workspaceResponse.json() as Workspace & { error?: string };
    if (!workflowResponse.ok || !workspaceResponse.ok) { setMessage(workflowResult.error ?? workspaceResult.error ?? "Unable to load workflow"); return; }
    setWorkflow(workflowResult); setWorkspace(workspaceResult); const contract = workflowResult.contract;
    setForm({ lifecycleStage: contract.lifecycle_stage, renewalDate: dateInput(contract.renewal_date), noticePeriodDays: String(contract.notice_period_days ?? 30), contractValue: contract.contract_value_minor == null ? "" : (contract.contract_value_minor / 100).toFixed(2), currency: contract.currency ?? "USD", riskLevel: contract.risk_level ?? "medium", reviewDeadlineAt: dateTimeInput(contract.review_deadline_at) });
    setCommentBlock((current) => current || workspaceResult.blocks.find((block) => block.kind !== "title")?.id || ""); const versions = workspaceResult.versions.map((item) => item.version_number).sort((a, b) => a - b); setFromVersion(versions.at(-2) ?? versions[0] ?? 1); setToVersion(versions.at(-1) ?? 1);
  }, [contractId, router]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const blockMap = useMemo(() => new Map((workspace?.blocks ?? []).map((block, index) => [block.id, index + 1])), [workspace]); const openRound = workflow?.reviewRounds.find((item) => item.status === "open");

  async function mutate(path: string, body: Record<string, unknown>, success: string) {
    setBusy(true); setMessage(""); const response = await fetch(`/api/contracts/${contractId}/${path}`, { method: path === "lifecycle" ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const responseText = await response.text(); let result: { error?: string; contract?: { id: string } } = {}; try { result = JSON.parse(responseText) as typeof result; } catch { result = { error: response.ok ? undefined : "The server could not complete this action" }; } setBusy(false);
    if (!response.ok) { setMessage(result.error ?? "Action failed"); return result; } setMessage(success); await load(); return result;
  }
  async function compare() { setBusy(true); const response = await fetch(`/api/contracts/${contractId}/versions/compare?from=${fromVersion}&to=${toVersion}`, { cache: "no-store" }); const result = await response.json() as Comparison & { error?: string }; setBusy(false); if (!response.ok) { setMessage(result.error ?? "Unable to compare versions"); return; } setComparison(result); setMessage(""); }
  async function amendment(type: "amends" | "renews") { if (!confirm(`Create a controlled ${type === "renews" ? "renewal" : "amendment"}?`)) return; const result = await mutate("amendments", { relationshipType: type }, "Linked contract created."); if (result?.contract?.id) router.push(`/workflow/${result.contract.id}`); }

  if (!workflow || !workspace) return <main className="workflow-loading"><span className="portal-spinner"/><p>{message || "Loading contract workflow…"}</p></main>;
  const contract = workflow.contract; const redlineBlocks = comparison?.blocks.filter((block) => showAll || block.changed) ?? [];
  return <main className="workflow-shell">
    <header className="workflow-top"><Link href="/">← Contract editor</Link><div><small>Contract operations</small><h1>{contract.title}</h1><p>Version {contract.current_version} · {title(contract.lifecycle_stage)} · {title(contract.risk_level)} risk</p></div><a href={`/api/contracts/${contractId}/calendar`}>Download calendar</a></header>
    {message && <div className="workflow-message" role="status">{message}</div>}
    <section className="workflow-grid">
      <form className="workflow-card lifecycle-card" onSubmit={(event) => { event.preventDefault(); void mutate("lifecycle", { ...form, reviewDeadlineAt: instantOrUndefined(form.reviewDeadlineAt), noticePeriodDays: Number(form.noticePeriodDays), contractValue: form.contractValue }, "Lifecycle details saved and reminders rebuilt."); }}>
        <CardHead eyebrow="Business state" heading="Lifecycle management" badge={title(form.lifecycleStage)}/>
        <label>Lifecycle stage<select value={form.lifecycleStage} onChange={(event) => setForm((current) => ({ ...current, lifecycleStage: event.target.value }))}>{["draft","internal_review","external_review","approved","executed","expired","renewed"].map((item) => <option value={item} key={item}>{title(item)}</option>)}</select></label>
        <div className="workflow-form-row"><label>Risk level<select value={form.riskLevel} onChange={(event) => setForm((current) => ({ ...current, riskLevel: event.target.value }))}>{["low","medium","high","critical"].map((item) => <option value={item} key={item}>{title(item)}</option>)}</select></label><label>Responsible owner<input value={contract.responsible_owner_name ?? "Contract Owner"} disabled/></label></div>
        <div className="workflow-form-row"><label>Contract value<input type="number" min="0" step="0.01" value={form.contractValue} onChange={(event) => setForm((current) => ({ ...current, contractValue: event.target.value }))} placeholder="25000.00"/></label><label>Currency<input maxLength={3} value={form.currency} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}/></label></div>
        <div className="workflow-form-row"><label>Renewal date<input type="date" value={form.renewalDate} onChange={(event) => setForm((current) => ({ ...current, renewalDate: event.target.value }))}/></label><label>Notice period (days)<input type="number" min="0" max="3650" value={form.noticePeriodDays} onChange={(event) => setForm((current) => ({ ...current, noticePeriodDays: event.target.value }))}/></label></div>
        <label>Review deadline<input type="datetime-local" value={form.reviewDeadlineAt} onChange={(event) => setForm((current) => ({ ...current, reviewDeadlineAt: event.target.value }))}/></label><button className="workflow-primary" disabled={busy}>Save lifecycle details</button>
      </form>

      <section className="workflow-card"><CardHead eyebrow="Timed collaboration" heading="Review rounds" badge={openRound ? `Round ${openRound.round_number} open` : "No open round"}/>
        {openRound ? <><p>Deadline: {openRound.deadline_at ? new Date(openRound.deadline_at).toLocaleString() : "No deadline"}</p><label>Closing reason<textarea value={roundReason} onChange={(event) => setRoundReason(event.target.value)} placeholder="All requested changes have been addressed."/></label><button disabled={busy || roundReason.trim().length < 3} onClick={() => void mutate("review-rounds", { action: "close", roundId: openRound.id, reason: roundReason }, "Review round closed.").then(() => setRoundReason(""))}>Close review round</button></> : <><label>Deadline<input type="datetime-local" value={roundDeadline} onChange={(event) => setRoundDeadline(event.target.value)}/></label><button className="workflow-primary" disabled={busy} onClick={() => void mutate("review-rounds", { action: "open", deadlineAt: instantOrUndefined(roundDeadline) }, "New review round opened.")}>Open next review round</button></>}
        <CompactList items={workflow.reviewRounds.map((round) => ({ key: round.id, strong: `Round ${round.round_number}`, text: `${title(round.status)}${round.deadline_at ? ` · ${new Date(round.deadline_at).toLocaleDateString()}` : ""}` }))}/>
      </section>

      <section className="workflow-card"><CardHead eyebrow="Version gate" heading="Required approvals" badge={`Version ${contract.current_version}`}/><div className="workflow-inline"><select value={approvalKind} onChange={(event) => setApprovalKind(event.target.value)}>{["legal","finance","security","business"].map((item) => <option key={item}>{item}</option>)}</select><button disabled={busy} onClick={() => void mutate("approvals", { action: "require", kind: approvalKind }, `${title(approvalKind)} approval required.`)}>Add requirement</button></div><label>Decision reason<textarea value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} placeholder="Approved because the position is within policy."/></label>
        <div className="approval-list">{workflow.approvals.map((approval) => <article key={approval.id}><div><strong>{title(approval.kind)}</strong><span>v{approval.version_number} · {title(approval.status)}</span></div>{approval.status === "pending" ? <div><button disabled={approvalReason.trim().length < 3 || busy} onClick={() => void mutate("approvals", { action: "decide", approvalId: approval.id, decision: "approved", reason: approvalReason }, "Approval recorded.").then(() => setApprovalReason(""))}>Approve</button><button disabled={approvalReason.trim().length < 3 || busy} onClick={() => void mutate("approvals", { action: "decide", approvalId: approval.id, decision: "edits_requested", reason: approvalReason }, "Edits requested.").then(() => setApprovalReason(""))}>Request edits</button></div> : <p>{approval.decision_reason}</p>}</article>)}</div>
      </section>

      <section className="workflow-card comments-card"><CardHead eyebrow="Paragraph discussion" heading="Comments and threads" badge={`${workflow.comments.filter((item) => item.status === "open").length} open`}/><label>Paragraph<select value={commentBlock} onChange={(event) => setCommentBlock(event.target.value)}>{workspace.blocks.map((block, index) => <option value={block.id} key={block.id}>{index + 1}. {block.current_text.slice(0, 80)}</option>)}</select></label><label>Comment<textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Explain the business or legal concern…"/></label><button className="workflow-primary" disabled={busy || !commentBody.trim()} onClick={() => void mutate("comments", { action: "add", blockId: commentBlock, body: commentBody }, "Comment added.").then(() => setCommentBody(""))}>Add comment</button>
        <div className="comment-list">{workflow.comments.map((comment) => <article key={comment.id} className={comment.status}><div><strong>Paragraph {blockMap.get(comment.block_id) ?? "—"} · {comment.author_display}</strong><span>{new Date(comment.created_at).toLocaleString()}</span></div><p>{comment.body}</p>{comment.status === "open" && <button onClick={() => void mutate("comments", { action: "resolve", commentId: comment.id }, "Comment resolved.")}>Resolve thread</button>}</article>)}</div>
      </section>

      <section className="workflow-card redline-card"><CardHead eyebrow="Immutable snapshots" heading="Full-document redline" badge={comparison ? `${comparison.changedCount} changed paragraphs` : "Choose versions"}/><div className="workflow-inline"><VersionSelect value={fromVersion} versions={workspace.versions} onChange={setFromVersion}/><span>→</span><VersionSelect value={toVersion} versions={workspace.versions} onChange={setToVersion}/><button disabled={busy || fromVersion === toVersion} onClick={() => void compare()}>Compare</button></div>
        {comparison && <><label className="workflow-check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)}/> Show unchanged paragraphs</label><div className="redline-document">{redlineBlocks.map((block, index) => <article key={block.key} className={block.changed ? "changed" : "unchanged"}><small>{index + 1} · {title(block.kind)}</small><div><p>{block.diff.original.map((segment, item) => segment.changed ? <del key={item}>{segment.text}</del> : <span key={item}>{segment.text}</span>)}</p><p>{block.diff.proposed.map((segment, item) => segment.changed ? <ins key={item}>{segment.text}</ins> : <span key={item}>{segment.text}</span>)}</p></div></article>)}</div></>}
      </section>

      <section className="workflow-card"><CardHead eyebrow="Controlled history" heading="Amendments and renewals" badge={`${workflow.relationships.length} linked`}/><p>A locked contract remains immutable. Continuing work creates a new linked agreement.</p><div className="workflow-inline"><button disabled={contract.status !== "locked" || busy} onClick={() => void amendment("amends")}>Create amendment</button><button disabled={contract.status !== "locked" || busy} onClick={() => void amendment("renews")}>Create renewal</button></div><CompactList items={workflow.relationships.map((item) => ({ key: item.id, strong: title(item.relationship_type), text: `${item.source_title} → ${item.target_title}` }))}/></section>
      <section className="workflow-card"><CardHead eyebrow="Delivery-ready" heading="Reminder schedule" badge={<a href={`/api/contracts/${contractId}/calendar`}>Export .ics</a>}/><p>Email delivery remains provider-neutral; calendar and in-app schedules work without a paid service.</p><CompactList items={workflow.reminders.map((item) => ({ key: item.id, strong: title(item.kind), text: `${new Date(item.due_at).toLocaleString()} · ${title(item.channel)} · ${title(item.status)}` }))}/></section>
      <section className="workflow-card monitoring-card"><CardHead eyebrow="Sanitized telemetry" heading="Operational errors" badge={`${workflow.errors.filter((item) => !item.resolved_at).length} open`}/><p>Request IDs and fingerprints are stored; passwords and contract text are excluded.</p><div className="error-list">{workflow.errors.length ? workflow.errors.map((item) => <article key={item.id} className={item.resolved_at ? "resolved" : ""}><div><strong>{title(item.severity)} · {item.route}</strong><span>{item.occurrence_count} occurrence{item.occurrence_count === 1 ? "" : "s"}</span></div><p>{item.message}</p><small>Request {item.request_id} · {new Date(item.last_seen_at).toLocaleString()}</small>{!item.resolved_at && <button onClick={() => void mutate("errors", { errorId: item.id }, "Operational error resolved.")}>Resolve</button>}</article>) : <div className="workflow-empty">No operational errors recorded.</div>}</div></section>
    </section>
  </main>;
}

function CardHead({ eyebrow, heading, badge }: { eyebrow: string; heading: string; badge: ReactNode }) { return <div className="workflow-card-head"><div><small>{eyebrow}</small><h2>{heading}</h2></div><span>{badge}</span></div>; }
function CompactList({ items }: { items: Array<{ key: string; strong: string; text: string }> }) { return <div className="compact-list">{items.map((item) => <div key={item.key}><strong>{item.strong}</strong><span>{item.text}</span></div>)}</div>; }
function VersionSelect({ value, versions, onChange }: { value: number; versions: Version[]; onChange: (value: number) => void }) { return <select value={value} onChange={(event) => onChange(Number(event.target.value))}>{versions.map((item) => <option value={item.version_number} key={item.version_number}>Version {item.version_number}</option>)}</select>; }
