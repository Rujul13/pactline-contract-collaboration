import { env } from "cloudflare:workers";
import { getClientSession } from "@/lib/client-auth";
import { docxResponse, renderContractDocx } from "@/lib/contract-download";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getClientSession(request); if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params; if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  const rendered = await renderContractDocx(contractId); if (!rendered) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (rendered.contract.status !== "locked") return Response.json({ error: "The final document is available after both parties agree" }, { status: 409 });
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'document.downloaded', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, contractId, rendered.contract.current_version, request.headers.get("x-request-id") ?? crypto.randomUUID(), JSON.stringify({ final: true }), now).run();
  return docxResponse(rendered);
}

