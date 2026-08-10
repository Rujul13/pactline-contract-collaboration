import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getOwnerOrganizationId } from "@/lib/v2";
import { indexPendingSearchChunks } from "@/lib/search";

type Review = { id?: string; status?: "confirmed" | "rejected"; correctedValue?: string };

function normalizedDate(value: string | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); const { documentId } = await context.params;
  const document = await env.DB.prepare("SELECT id,linked_contract_id,current_version FROM vault_documents WHERE id=? AND owner_organization_id=?").bind(documentId, organizationId).first<{ id: string; linked_contract_id: string | null; current_version: number }>();
  if (!document) return Response.json({ error: "Document not found" }, { status: 404 });
  const run = await env.DB.prepare("SELECT id FROM extraction_runs WHERE document_id=? AND status='needs_review' ORDER BY created_at DESC LIMIT 1").bind(documentId).first<{ id: string }>();
  if (!run) return Response.json({ error: "No extraction is ready for review" }, { status: 409 });
  const body = await request.json().catch(() => null) as { fields?: Review[]; clauses?: Review[] } | null;
  if (!body || !Array.isArray(body.fields) || !Array.isArray(body.clauses)) return Response.json({ error: "Field and clause review decisions are required" }, { status: 400 });
  const now = new Date().toISOString(); const statements: D1PreparedStatement[] = [];
  for (const item of body.fields) if (item.id && ["confirmed", "rejected"].includes(item.status ?? "")) statements.push(env.DB.prepare("UPDATE extracted_fields SET review_status=?,corrected_value=?,updated_at=? WHERE id=? AND extraction_run_id=?").bind(item.status, item.correctedValue?.trim().slice(0, 5_000) || null, now, item.id, run.id));
  for (const item of body.clauses) if (item.id && ["confirmed", "rejected"].includes(item.status ?? "")) statements.push(env.DB.prepare("UPDATE extracted_clauses SET review_status=?,updated_at=? WHERE id=? AND extraction_run_id=?").bind(item.status, now, item.id, run.id));
  statements.push(
    env.DB.prepare("UPDATE extraction_runs SET status='confirmed',updated_at=? WHERE id=?").bind(now, run.id),
    env.DB.prepare("UPDATE vault_documents SET extraction_status='confirmed',updated_at=? WHERE id=?").bind(now, documentId),
    env.DB.prepare("UPDATE search_chunks SET index_status='superseded',updated_at=? WHERE document_id=? AND index_status!='superseded'").bind(now, documentId),
  );
  await env.DB.batch(statements);
  const clauses = await env.DB.prepare("SELECT id,heading,clause_text FROM extracted_clauses WHERE extraction_run_id=? AND review_status='confirmed'").bind(run.id).all<{ id: string; heading: string; clause_text: string }>();
  const fields = await env.DB.prepare("SELECT field_key,COALESCE(corrected_value,value) AS final_value FROM extracted_fields WHERE extraction_run_id=? AND review_status='confirmed'").bind(run.id).all<{ field_key: string; final_value: string }>();
  await env.DB.batch([
    ...clauses.results.map((clause) => env.DB.prepare("INSERT INTO search_chunks (id,organization_id,document_id,document_version,clause_id,content,index_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)").bind(crypto.randomUUID(), organizationId, documentId, document.current_version, clause.id, `${clause.heading}\n${clause.clause_text}`, now, now)),
    ...fields.results.map((field) => env.DB.prepare("INSERT INTO search_chunks (id,organization_id,document_id,document_version,content,index_status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)").bind(crypto.randomUUID(), organizationId, documentId, document.current_version, `${field.field_key.replaceAll('_', ' ')}: ${field.final_value}`, now, now)),
  ]);
  const fieldMap = new Map(fields.results.map((field) => [field.field_key, field.final_value]));
  const effectiveDate = normalizedDate(fieldMap.get("effective_date"));
  const expirationDate = normalizedDate(fieldMap.get("expiration_date"));
  await env.DB.prepare("UPDATE vault_documents SET effective_date=COALESCE(?,effective_date),expiration_date=COALESCE(?,expiration_date),status=CASE WHEN COALESCE(?,expiration_date) < date('now') THEN 'expired' ELSE status END,updated_at=? WHERE id=?").bind(effectiveDate, expirationDate, expirationDate, now, documentId).run();
  if (document.linked_contract_id) await env.DB.prepare("UPDATE contracts SET effective_date=COALESCE(?,effective_date),expiration_date=COALESCE(?,expiration_date),updated_at=? WHERE id=?").bind(effectiveDate, expirationDate, now, document.linked_contract_id).run();
  const indexing = await indexPendingSearchChunks(organizationId!, documentId);
  return Response.json({ confirmed: true, searchableChunks: clauses.results.length + fields.results.length, vectorIndexing: indexing });
}
