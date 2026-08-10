import { env } from "cloudflare:workers";
import { requirePortalSession } from "@/lib/portal-auth";

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response;
  const { documentId } = await context.params;
  const row = await env.DB.prepare(`SELECT v.object_key,v.filename,v.content_type FROM vault_documents d JOIN vault_document_versions v ON v.document_id=d.id AND v.version_number=d.current_version WHERE d.id=? AND d.supplier_organization_id=? AND d.visibility IN ('shared','supplier_only')`).bind(documentId, auth.session!.organizationId).first<{ object_key: string; filename: string; content_type: string }>();
  if (!row) return Response.json({ error: "Document not found" }, { status: 404 });
  const object = await env.DOCUMENTS.get(row.object_key);
  if (!object) return Response.json({ error: "Stored document is unavailable" }, { status: 404 });
  return new Response(object.body, { headers: { "content-type": row.content_type, "content-disposition": `attachment; filename="${row.filename.replaceAll('"', '')}"`, "cache-control": "private, no-store" } });
}
