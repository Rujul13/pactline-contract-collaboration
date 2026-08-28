import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ensureDemoWorkspace } from "@/lib/demo";
import { ensureV2Workspace } from "@/lib/v2";
import { captureError } from "@/lib/monitoring";

export async function GET(request: Request) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  try {
    await ensureDemoWorkspace(user);
    await ensureV2Workspace(user);
  } catch (error) {
    console.error("Unable to prepare the owner workspace", error);
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    await captureError(error, { requestId, route: "/api/workspace", method: "GET", actorScope: "owner", severity: "critical" });
    return Response.json(
      {
        error: "Unable to prepare workspace",
        requestId,
      },
      { status: 500 },
    );
  }
  try {
    const contracts = await env.DB.prepare(`
      SELECT c.id, c.title, c.status, c.current_version, c.locked_at, c.updated_at,
        counterparty.name AS reviewer_name, counterparty.company AS client_company,
        counterparty.email AS reviewer_email,
        (SELECT COUNT(*) FROM paragraph_proposals p WHERE p.contract_id = c.id AND p.status = 'pending') AS pending_proposals,
        (SELECT filename FROM document_objects d WHERE d.contract_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS filename
      FROM contracts c
      JOIN users u ON u.id = c.initiator_id
      LEFT JOIN parties counterparty ON counterparty.contract_id = c.id AND counterparty.role = 'counterparty'
      WHERE u.external_identity_id = ?
      ORDER BY c.updated_at DESC
    `).bind(user.userId).all();
    return Response.json({ owner: { name: "Vendor Admin", email: user.email }, contracts: contracts.results }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    console.error("Unable to load the owner workspace", error);
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    await captureError(error, { requestId, route: "/api/workspace", method: "GET", actorScope: "owner" });
    return Response.json(
      {
        error: "Unable to load workspace",
        requestId,
      },
      { status: 500 },
    );
  }
}
