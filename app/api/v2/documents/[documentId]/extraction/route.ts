import { env } from "cloudflare:workers";
import { processVaultDocument } from "@/lib/extraction";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getOwnerOrganizationId } from "@/lib/v2";

async function ownerContext(request: Request, documentId: string) {
  const auth = await requireOwnerApi(request); if (auth.response) return { response: auth.response };
  const organizationId = await getOwnerOrganizationId(auth.user.userId); const document = await env.DB.prepare("SELECT id FROM vault_documents WHERE id=? AND owner_organization_id=?").bind(documentId, organizationId).first();
  return document ? { organizationId: organizationId!, user: auth.user } : { response: Response.json({ error: "Document not found" }, { status: 404 }) };
}

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await context.params; const owner = await ownerContext(request, documentId); if (owner.response) return owner.response;
  const run = await env.DB.prepare("SELECT id,status,model,error,completed_at,created_at FROM extraction_runs WHERE document_id=? ORDER BY created_at DESC LIMIT 1").bind(documentId).first<{ id: string }>();
  if (!run) return Response.json({ run: null, fields: [], clauses: [] });
  const [fields, clauses] = await Promise.all([
    env.DB.prepare("SELECT id,field_key,value,confidence,source_reference,review_status,corrected_value FROM extracted_fields WHERE extraction_run_id=? ORDER BY field_key").bind(run.id).all(),
    env.DB.prepare("SELECT id,clause_type,heading,clause_text,confidence,source_reference,review_status FROM extracted_clauses WHERE extraction_run_id=? ORDER BY id").bind(run.id).all(),
  ]);
  return Response.json({ run, fields: fields.results, clauses: clauses.results }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await context.params; const owner = await ownerContext(request, documentId); if (owner.response) return owner.response;
  try { return Response.json(await processVaultDocument(documentId, owner.organizationId!)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Extraction failed" }, { status: 500 }); }
}
