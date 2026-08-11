import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { errorId?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!body.errorId) return Response.json({ error: "Error id is required" }, { status: 400 }); const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE error_events SET resolved_at=? WHERE id=? AND (contract_id=? OR contract_id IS NULL) AND resolved_at IS NULL").bind(now, body.errorId, contractId).run();
  if (!result.meta.changes) return Response.json({ error: "Open error not found" }, { status: 404 }); return Response.json({ resolved: true });
}
