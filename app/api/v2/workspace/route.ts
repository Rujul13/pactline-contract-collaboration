import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ensureDemoWorkspace } from "@/lib/demo";
import { ensureV2Workspace, getOwnerOrganizationId } from "@/lib/v2";
import { refreshAlerts } from "@/lib/alerts";

export async function GET(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  await ensureDemoWorkspace(auth.user); await ensureV2Workspace(auth.user);
  const organizationId = await getOwnerOrganizationId(auth.user.userId);
  if (!organizationId) return Response.json({ error: "Organization not found" }, { status: 404 });
  await refreshAlerts(organizationId);
  const [organization, suppliers, contracts, documents, templates, clauseModules, alerts] = await Promise.all([
    env.DB.prepare("SELECT id,name,kind,timezone FROM organizations WHERE id=?").bind(organizationId).first(),
    env.DB.prepare(`SELECT r.id AS relationship_id,o.id,o.name,o.status,(SELECT COUNT(*) FROM contracts c WHERE c.owner_organization_id=r.customer_organization_id AND c.counterparty_organization_id=o.id) AS contract_count,(SELECT COUNT(*) FROM vault_documents d WHERE d.owner_organization_id=r.customer_organization_id AND d.supplier_organization_id=o.id AND d.status='active') AS document_count FROM supplier_relationships r JOIN organizations o ON o.id=r.supplier_organization_id WHERE r.customer_organization_id=? ORDER BY o.name`).bind(organizationId).all(),
    env.DB.prepare(`SELECT c.id,c.title,c.status,c.current_version,c.origin,c.effective_date,c.expiration_date,c.updated_at,s.name AS supplier_name,(SELECT COUNT(*) FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending') AS pending_proposals FROM contracts c LEFT JOIN organizations s ON s.id=c.counterparty_organization_id WHERE c.owner_organization_id=? ORDER BY c.updated_at DESC`).bind(organizationId).all(),
    env.DB.prepare(`SELECT d.id,d.title,d.category,d.visibility,d.status,d.effective_date,d.expiration_date,d.current_version,d.extraction_status,d.supplier_organization_id,s.name AS supplier_name,v.filename,v.content_type,v.byte_size,v.created_at FROM vault_documents d LEFT JOIN organizations s ON s.id=d.supplier_organization_id JOIN vault_document_versions v ON v.document_id=d.id AND v.version_number=d.current_version WHERE d.owner_organization_id=? ORDER BY d.updated_at DESC`).bind(organizationId).all(),
    env.DB.prepare("SELECT id,name,contract_type,filename,fields,status,version_number,created_at FROM contract_templates WHERE organization_id=? ORDER BY created_at DESC").bind(organizationId).all(),
    env.DB.prepare("SELECT id,name,heading,body FROM clause_modules WHERE organization_id=? AND status='active' ORDER BY name").bind(organizationId).all(),
    env.DB.prepare("SELECT id,kind,severity,title,message,due_at,status,supplier_organization_id,contract_id,document_id FROM alerts WHERE organization_id=? AND status IN ('open','acknowledged','snoozed') ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END,due_at").bind(organizationId).all(),
  ]);
  return Response.json({ organization, suppliers: suppliers.results, contracts: contracts.results, documents: documents.results, templates: templates.results, clauseModules: clauseModules.results, alerts: alerts.results }, { headers: { "cache-control": "private, no-store" } });
}
