import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { DEMO_CONTRACT_ID, ensureDemoWorkspace } from "@/lib/demo";
import { ensureV2Workspace } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const user = auth.user;
  const objects = await env.DB.prepare("SELECT object_key FROM document_objects WHERE contract_id=?").bind(DEMO_CONTRACT_ID).all<{ object_key: string }>().catch(() => ({ results: [] }));

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM approval_invites WHERE assignment_id IN (SELECT id FROM approval_assignments WHERE contract_id=?)").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM approval_assignments WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM approval_requests WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM agreements WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM paragraph_proposals WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM comments WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM audit_log_entries WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM reminder_schedules WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM document_blocks WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM contract_versions WHERE contract_id=?").bind(DEMO_CONTRACT_ID),
      env.DB.prepare("DELETE FROM contracts WHERE id=?").bind(DEMO_CONTRACT_ID),
    ]);
  } catch {
    await env.DB.prepare("DELETE FROM contracts WHERE id=?").bind(DEMO_CONTRACT_ID).run().catch(() => undefined);
  }

  await Promise.all(objects.results.map((item) => env.DOCUMENTS.delete(item.object_key).catch(() => undefined)));
  await ensureDemoWorkspace(user);
  await ensureV2Workspace(user);
  return Response.json({ reset: true, contractId: DEMO_CONTRACT_ID });
}
