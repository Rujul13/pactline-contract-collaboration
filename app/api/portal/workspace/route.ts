import { env } from "cloudflare:workers";
import { requirePortalSession } from "@/lib/portal-auth";

export async function GET(request: Request) {
  const auth = await requirePortalSession(request);
  if (auth.response) return auth.response;
  const session = auth.session!;
  const [contracts, documents, alerts] = await Promise.all([
    env.DB.prepare(`SELECT c.id,c.title,c.status,c.current_version,c.origin,c.effective_date,c.expiration_date,c.updated_at,g.permission,(SELECT COUNT(*) FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending') AS pending_proposals FROM contract_access_grants g JOIN contracts c ON c.id=g.contract_id WHERE g.portal_account_id=? AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?) ORDER BY CASE WHEN c.status='locked' THEN 1 ELSE 0 END,c.updated_at DESC`).bind(session.accountId, new Date().toISOString()).all(),
    env.DB.prepare(`SELECT d.id,d.title,d.category,d.visibility,d.status,d.effective_date,d.expiration_date,d.current_version,d.extraction_status,v.filename,v.content_type,v.byte_size,v.created_at FROM vault_documents d JOIN vault_document_versions v ON v.document_id=d.id AND v.version_number=d.current_version WHERE d.supplier_organization_id=? AND d.visibility IN ('shared','supplier_only') ORDER BY CASE WHEN d.expiration_date IS NULL THEN 1 ELSE 0 END,d.expiration_date`).bind(session.organizationId).all(),
    env.DB.prepare("SELECT id,kind,severity,title,message,due_at,status,document_id,contract_id FROM alerts WHERE supplier_organization_id=? AND status IN ('open','acknowledged','snoozed') ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END,due_at").bind(session.organizationId).all(),
  ]);
  return Response.json({ account: session, contracts: contracts.results, documents: documents.results, alerts: alerts.results }, { headers: { "cache-control": "private, no-store" } });
}
