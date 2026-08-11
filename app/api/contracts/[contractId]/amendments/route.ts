import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const source = await ownerContract(contractId, auth.user.userId); if (!source) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (source.status !== "locked") return Response.json({ error: "Only a locked contract can be reopened through an amendment" }, { status: 409 });
  let body: { title?: string; relationshipType?: "amends" | "renews" }; try { body = await request.json() as typeof body; } catch { body = {}; }
  const relationshipType = body.relationshipType === "renews" ? "renews" : "amends"; const title = body.title?.trim() || `${relationshipType === "renews" ? "Renewal of" : "Amendment to"} ${String(source.title)}`;
  if (title.length < 3 || title.length > 180) return Response.json({ error: "Amendment title must contain 3 to 180 characters" }, { status: 400 });
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  const [blocks, parties] = await Promise.all([env.DB.prepare("SELECT * FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all<Record<string, unknown>>(), env.DB.prepare("SELECT * FROM parties WHERE contract_id=? ORDER BY role").bind(contractId).all<Record<string, unknown>>()]);
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const snapshot = blocks.results.map((block) => ({ id: crypto.randomUUID(), block_key: block.block_key, order_index: block.order_index, kind: block.kind, current_text: block.current_text })); const relationshipId = crypto.randomUUID();
  const statements = [env.DB.prepare(`INSERT INTO contracts (id,title,initiator_id,approver_id,status,owner_organization_id,counterparty_organization_id,origin,effective_date,expiration_date,lifecycle_stage,notice_period_days,responsible_owner_id,currency,risk_level,current_version,created_at,updated_at) VALUES (?,?,?,?, 'draft',?,?, 'direct_upload',?,?, 'draft',?,?,?,?,1,?,?)`).bind(id, title, source.initiator_id, source.approver_id, source.owner_organization_id, source.counterparty_organization_id, source.effective_date, source.expiration_date, source.notice_period_days, source.responsible_owner_id ?? source.initiator_id, source.currency, source.risk_level, now, now)];
  for (const party of parties.results) statements.push(env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), id, party.role, party.name, party.company, party.email, now, now));
  for (const block of snapshot) statements.push(env.DB.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)").bind(block.id, id, block.block_key, block.order_index, block.kind, block.current_text, "amendment-copy", now, now));
  statements.push(env.DB.prepare("INSERT INTO contract_versions (id,contract_id,version_number,created_by,snapshot,created_at) VALUES (?,?,1,?,json(?),?)").bind(crypto.randomUUID(), id, auth.user.userId, JSON.stringify(snapshot), now));
  statements.push(env.DB.prepare("INSERT INTO contract_relationships (id,source_contract_id,target_contract_id,relationship_type,created_by,created_at) VALUES (?,?,?,?,?,?)").bind(relationshipId, id, contractId, relationshipType, auth.user.userId, now));
  statements.push(env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,version_number,request_id,metadata,created_at) VALUES (?,?,?,?, 'contract.amendment_created','contract',?,1,?,json(?),?)").bind(crypto.randomUUID(), id, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ sourceContractId: contractId, relationshipType }), now));
  await env.DB.batch(statements); return Response.json({ contract: { id, title, status: "draft", currentVersion: 1 }, relationshipId }, { status: 201 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/amendments", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to create the linked contract", requestId }, { status: 500 });
  }
}
