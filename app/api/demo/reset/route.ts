import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { DEMO_CONTRACT_ID, ensureDemoWorkspace } from "@/lib/demo";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const user = auth.user;
  const owner = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id=c.initiator_id WHERE c.id=? AND u.external_identity_id=?").bind(DEMO_CONTRACT_ID, user.userId).first();
  if (owner) {
    const objects = await env.DB.prepare("SELECT object_key FROM document_objects WHERE contract_id=?").bind(DEMO_CONTRACT_ID).all<{ object_key: string }>();
    await env.DB.prepare("DELETE FROM contracts WHERE id=?").bind(DEMO_CONTRACT_ID).run();
    await Promise.all(objects.results.map((item) => env.DOCUMENTS.delete(item.object_key)));
  }
  await ensureDemoWorkspace(user);
  return Response.json({ reset: true, contractId: DEMO_CONTRACT_ID });
}
