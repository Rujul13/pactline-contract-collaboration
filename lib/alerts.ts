import { env } from "cloudflare:workers";

const DAY = 86_400_000;

function daysUntil(value: string, now = new Date()) { return Math.ceil((new Date(`${value}T00:00:00Z`).getTime() - now.getTime()) / DAY); }
function severity(days: number) { return days < 0 ? "urgent" : days <= 7 ? "urgent" : days <= 30 ? "attention" : "information"; }

async function upsertAlert(input: { organizationId: string; supplierOrganizationId?: string | null; contractId?: string | null; documentId?: string | null; kind: string; title: string; message: string; dueAt?: string | null; dedupeKey: string; severity: string }, now: string) {
  await env.DB.prepare(`INSERT INTO alerts (id,organization_id,supplier_organization_id,contract_id,document_id,kind,severity,title,message,due_at,status,dedupe_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET severity=excluded.severity,title=excluded.title,message=excluded.message,due_at=excluded.due_at,status=CASE WHEN alerts.status='resolved' THEN 'open' ELSE alerts.status END,resolved_at=NULL,updated_at=excluded.updated_at`).bind(crypto.randomUUID(), input.organizationId, input.supplierOrganizationId ?? null, input.contractId ?? null, input.documentId ?? null, input.kind, input.severity, input.title, input.message, input.dueAt ?? null, input.dedupeKey, now, now).run();
}

export async function refreshAlerts(organizationId: string) {
  const now = new Date(); const nowIso = now.toISOString(); const activeKeys = new Set<string>();
  const documents = await env.DB.prepare("SELECT d.id,d.title,d.category,d.expiration_date,d.supplier_organization_id,s.name AS supplier_name FROM vault_documents d LEFT JOIN organizations s ON s.id=d.supplier_organization_id WHERE d.owner_organization_id=? AND d.status!='archived' AND d.expiration_date IS NOT NULL").bind(organizationId).all<{ id: string; title: string; category: string; expiration_date: string; supplier_organization_id: string | null; supplier_name: string | null }>();
  for (const document of documents.results) {
    const days = daysUntil(document.expiration_date, now); if (days > 90) continue;
    const kind = days < 0 ? "expired" : "expiration_due"; const key = `${kind}:document:${document.id}:${document.expiration_date}`; activeKeys.add(key);
    await upsertAlert({ organizationId, supplierOrganizationId: document.supplier_organization_id, documentId: document.id, kind, severity: severity(days), title: days < 0 ? `${document.title} has expired` : `${document.title} expires in ${days} days`, message: `${document.supplier_name ?? "Supplier"} · ${document.category.replaceAll("_", " ")} · ${document.expiration_date}`, dueAt: document.expiration_date, dedupeKey: key }, nowIso);
  }
  const contracts = await env.DB.prepare("SELECT c.id,c.title,c.expiration_date,c.counterparty_organization_id,s.name AS supplier_name FROM contracts c LEFT JOIN organizations s ON s.id=c.counterparty_organization_id WHERE c.owner_organization_id=? AND c.expiration_date IS NOT NULL AND c.status!='locked'").bind(organizationId).all<{ id: string; title: string; expiration_date: string; counterparty_organization_id: string | null; supplier_name: string | null }>();
  for (const contract of contracts.results) {
    const days = daysUntil(contract.expiration_date, now); if (days > 90) continue;
    const key = `renewal_due:contract:${contract.id}:${contract.expiration_date}`; activeKeys.add(key);
    await upsertAlert({ organizationId, supplierOrganizationId: contract.counterparty_organization_id, contractId: contract.id, kind: "renewal_due", severity: severity(days), title: days < 0 ? `${contract.title} passed its end date` : `${contract.title} renewal review is due`, message: `${contract.supplier_name ?? "Supplier"} · ${days < 0 ? `${Math.abs(days)} days overdue` : `${days} days remaining`}`, dueAt: contract.expiration_date, dedupeKey: key }, nowIso);
  }
  const requirements = await env.DB.prepare(`SELECT r.id,r.supplier_organization_id,o.name AS supplier_name,cr.document_category,cr.warning_days FROM compliance_requirements cr JOIN supplier_relationships r ON r.id=cr.relationship_id JOIN organizations o ON o.id=r.supplier_organization_id WHERE r.customer_organization_id=? AND r.status='active' AND cr.required=1`).bind(organizationId).all<{ id: string; supplier_organization_id: string; supplier_name: string; document_category: string; warning_days: number }>();
  for (const requirement of requirements.results) {
    const document = await env.DB.prepare("SELECT id,expiration_date FROM vault_documents WHERE owner_organization_id=? AND supplier_organization_id=? AND category=? AND status='active' ORDER BY expiration_date DESC LIMIT 1").bind(organizationId, requirement.supplier_organization_id, requirement.document_category).first<{ id: string; expiration_date: string | null }>();
    if (document) continue;
    const key = `missing_compliance:${requirement.id}:${requirement.document_category}`; activeKeys.add(key);
    await upsertAlert({ organizationId, supplierOrganizationId: requirement.supplier_organization_id, kind: "missing_compliance", severity: "urgent", title: `${requirement.supplier_name} is missing required documentation`, message: `Upload an active ${requirement.document_category.replaceAll("_", " ")} to restore compliance.`, dedupeKey: key }, nowIso);
  }
  const existing = await env.DB.prepare("SELECT id,dedupe_key FROM alerts WHERE organization_id=? AND status IN ('open','acknowledged','snoozed')").bind(organizationId).all<{ id: string; dedupe_key: string }>();
  const stale = existing.results.filter((alert) => !activeKeys.has(alert.dedupe_key));
  if (stale.length) await env.DB.batch(stale.map((alert) => env.DB.prepare("UPDATE alerts SET status='resolved',resolved_at=?,updated_at=? WHERE id=?").bind(nowIso, nowIso, alert.id)));
  return { active: activeKeys.size, resolved: stale.length };
}

export async function refreshAllOrganizationAlerts() {
  const organizations = await env.DB.prepare("SELECT id FROM organizations WHERE kind='customer' AND status='active'").all<{ id: string }>();
  const results = [];
  for (const organization of organizations.results) results.push({ organizationId: organization.id, ...(await refreshAlerts(organization.id)) });
  return results;
}
