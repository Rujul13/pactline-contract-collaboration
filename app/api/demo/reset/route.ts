import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { DEMO_CONTRACT_ID, ensureDemoWorkspace } from "@/lib/demo";
import { ensureV2Workspace } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const user = auth.user;
  // This endpoint is owner-only and can mutate only the fixed synthetic demo
  // ID, so reset it even if an earlier seed used a different owner identity.
  const objects = await env.DB.prepare("SELECT object_key FROM document_objects WHERE contract_id=?").bind(DEMO_CONTRACT_ID).all<{ object_key: string }>();
  await env.DB.prepare("DELETE FROM contracts WHERE id=?").bind(DEMO_CONTRACT_ID).run();
  await Promise.all(objects.results.map((item) => env.DOCUMENTS.delete(item.object_key)));
  await ensureDemoWorkspace(user);
  await ensureV2Workspace(user);
  return Response.json({ reset: true, contractId: DEMO_CONTRACT_ID });
}
