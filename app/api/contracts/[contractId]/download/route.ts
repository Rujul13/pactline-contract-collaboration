import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { docxResponse, renderContractDocx } from "@/lib/contract-download";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const user = auth.user;
  const { contractId } = await context.params;
  const owner = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id=c.initiator_id WHERE c.id=? AND u.external_identity_id=?").bind(contractId, user.userId).first();
  if (!owner) return Response.json({ error: "Contract not found" }, { status: 404 });
  const rendered = await renderContractDocx(contractId); if (!rendered) return Response.json({ error: "Contract not found" }, { status: 404 });
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, 'Vendor Admin', 'document.downloaded', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, contractId, rendered.contract.current_version, request.headers.get("x-request-id") ?? crypto.randomUUID(), JSON.stringify({ final: rendered.contract.status === "locked" }), now).run();
  return docxResponse(rendered);
}
