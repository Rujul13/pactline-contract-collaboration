import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { isValidLifecycleTransition, LIFECYCLE_STAGES, type LifecycleStage, ownerContract, RISK_LEVELS } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

const isoOrNull = (value: unknown) => value ? new Date(String(value)).toISOString() : null;

export async function PATCH(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const contract = await ownerContract(contractId, auth.user.userId); if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const stage = String(body.lifecycleStage ?? contract.lifecycle_stage); const risk = String(body.riskLevel ?? contract.risk_level);
  if (!LIFECYCLE_STAGES.includes(stage as never) || !RISK_LEVELS.includes(risk as never)) return Response.json({ error: "Invalid lifecycle stage or risk level" }, { status: 400 });
  const currentStage = String(contract.lifecycle_stage) as LifecycleStage; const nextStage = stage as LifecycleStage; const locked = contract.status === "locked";
  if (!isValidLifecycleTransition(currentStage, nextStage, locked)) return Response.json({ error: locked ? "Locked contracts can only move forward in the lifecycle" : `Invalid lifecycle transition from ${currentStage} to ${nextStage}` }, { status: 400 });
  if (nextStage === "approved" && currentStage !== "approved") {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM paragraph_proposals WHERE contract_id=? AND status='pending'").bind(contractId).first<{ total: number }>();
    if ((pending?.total ?? 0) > 0) return Response.json({ error: "Resolve every pending proposal before marking the contract approved" }, { status: 409 });
    const incompleteApprovals = await env.DB.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE contract_id=? AND version_number=? AND required=1 AND status!='approved'").bind(contractId, contract.current_version).first<{ total: number }>();
    if ((incompleteApprovals?.total ?? 0) > 0) return Response.json({ error: "Complete every required approval before marking the contract approved" }, { status: 409 });
    const incompleteDelegated = await env.DB.prepare("SELECT COUNT(*) AS total FROM approval_assignments WHERE contract_id=? AND version_number=? AND required=1 AND status!='approved'").bind(contractId, contract.current_version).first<{ total: number }>();
    if ((incompleteDelegated?.total ?? 0) > 0) return Response.json({ error: "Complete every required delegated approval before marking the contract approved" }, { status: 409 });
  }
  if (stage === "executed" && contract.status !== "locked") return Response.json({ error: "Lock the agreed document before marking it executed" }, { status: 409 });
  const noticePeriodDays = Math.max(0, Math.min(3650, Number(body.noticePeriodDays ?? contract.notice_period_days ?? 30)));
  const value = body.contractValue == null || body.contractValue === "" ? null : Math.round(Number(body.contractValue) * 100);
  if (value != null && (!Number.isSafeInteger(value) || value < 0)) return Response.json({ error: "Contract value must be a non-negative amount" }, { status: 400 });
  let renewalDate: string | null; let reviewDeadlineAt: string | null;
  try { renewalDate = isoOrNull(body.renewalDate); reviewDeadlineAt = isoOrNull(body.reviewDeadlineAt); } catch { return Response.json({ error: "Dates must be valid" }, { status: 400 }); }
  const currency = String(body.currency ?? contract.currency ?? "USD").trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) return Response.json({ error: "Currency must be a three-letter code" }, { status: 400 });
  const now = new Date().toISOString();
  try {
    const statements = [
      env.DB.prepare(`UPDATE contracts SET lifecycle_stage=?,renewal_date=?,notice_period_days=?,contract_value_minor=?,currency=?,risk_level=?,review_deadline_at=?,executed_at=CASE WHEN ?='executed' THEN COALESCE(executed_at,?) ELSE executed_at END,updated_at=? WHERE id=?`)
        .bind(stage, renewalDate, noticePeriodDays, value, currency, risk, reviewDeadlineAt, stage, now, now, contractId),
      env.DB.prepare("DELETE FROM reminder_schedules WHERE contract_id=? AND status='scheduled'").bind(contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'contract.lifecycle_updated','contract',?,?,json(?),?)")
        .bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, contractId, requestId, JSON.stringify({ stage, risk, noticePeriodDays }), now),
    ];
    const recipient = String(contract.responsible_owner_name ?? auth.user.displayName);
    if (reviewDeadlineAt) statements.push(env.DB.prepare("INSERT INTO reminder_schedules (id,contract_id,kind,channel,due_at,recipient,status,created_at,updated_at) VALUES (?,?,'review_deadline','in_app',?,?,'scheduled',?,?)").bind(crypto.randomUUID(), contractId, reviewDeadlineAt, recipient, now, now));
    if (renewalDate) {
      const renewal = new Date(renewalDate); const notice = new Date(renewal.getTime() - noticePeriodDays * 86_400_000).toISOString();
      statements.push(env.DB.prepare("INSERT INTO reminder_schedules (id,contract_id,kind,channel,due_at,recipient,status,created_at,updated_at) VALUES (?,?,'notice_window','in_app',?,?,'scheduled',?,?)").bind(crypto.randomUUID(), contractId, notice, recipient, now, now));
      statements.push(env.DB.prepare("INSERT INTO reminder_schedules (id,contract_id,kind,channel,due_at,recipient,status,created_at,updated_at) VALUES (?,?,'renewal','calendar',?,?,'scheduled',?,?)").bind(crypto.randomUUID(), contractId, renewalDate, recipient, now, now));
    }
    await env.DB.batch(statements); return Response.json({ updated: true });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/lifecycle", method: "PATCH", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update lifecycle metadata", requestId }, { status: 500 });
  }
}
