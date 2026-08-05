import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ensureDemoWorkspace } from "@/lib/demo";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required", signIn: "/owner/login?return_to=%2F" }, { status: 401 });
  await ensureDemoWorkspace(user);
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
  return Response.json({ owner: { name: "Contract Owner", email: user.email }, contracts: contracts.results }, { headers: { "cache-control": "private, no-store" } });
}
