import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

const KINDS = ["legal", "finance", "security", "business"];
export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const contract = await ownerContract(contractId, auth.user.userId); if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { action?: "require" | "decide"; kind?: string; approvalId?: string; decision?: "approved" | "rejected" | "edits_requested"; reason?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  if (body.action === "require") {
    const kind = String(body.kind ?? "business"); if (!KINDS.includes(kind)) return Response.json({ error: "Invalid approval kind" }, { status: 400 });
    const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id=?").bind(auth.user.userId).first<{ id: string }>(); if (!owner) return Response.json({ error: "Owner account not found" }, { status: 404 });
    const duplicate = await env.DB.prepare("SELECT id FROM approval_requests WHERE contract_id=? AND version_number=? AND kind=? AND required=1 AND status='pending'").bind(contractId, contract.current_version, kind).first(); if (duplicate) return Response.json({ error: "That approval is already required for this version" }, { status: 409 });
    const id = crypto.randomUUID(); await env.DB.batch([env.DB.prepare("INSERT INTO approval_requests (id,contract_id,approver_id,version_number,kind,required,status,created_at,updated_at) VALUES (?,?,?,?,?,1,'pending',?,?)").bind(id, contractId, owner.id, contract.current_version, kind, now, now), env.DB.prepare("UPDATE contracts SET lifecycle_stage='internal_review',updated_at=? WHERE id=?").bind(now, contractId), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,version_number,request_id,metadata,created_at) VALUES (?,?,?,?, 'approval.required','approval',?,?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, contract.current_version, requestId, JSON.stringify({ kind }), now)]);
    return Response.json({ approval: { id, kind, status: "pending", versionNumber: contract.current_version } }, { status: 201 });
  }
  if (body.action === "decide" && body.approvalId && body.decision && ["approved", "rejected", "edits_requested"].includes(body.decision)) {
    const reason = body.reason?.trim(); if (!reason || reason.length < 3 || reason.length > 2000) return Response.json({ error: "A decision reason is required" }, { status: 400 });
    const result = await env.DB.prepare("UPDATE approval_requests SET status=?,decision_reason=?,comment=?,resolved_at=?,updated_at=? WHERE id=? AND contract_id=? AND status='pending'").bind(body.decision, reason, reason, now, now, body.approvalId, contractId).run(); if (!result.meta.changes) return Response.json({ error: "Pending approval not found" }, { status: 404 });
    await env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,version_number,request_id,metadata,created_at) VALUES (?,?,?,?, 'approval.decided','approval',?,?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.approvalId, contract.current_version, requestId, JSON.stringify({ decision: body.decision, reason }), now).run();
    return Response.json({ decided: true, status: body.decision });
  }
  return Response.json({ error: "Action must require or decide an approval" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/approvals", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update approval workflow", requestId }, { status: 500 });
  }
}
