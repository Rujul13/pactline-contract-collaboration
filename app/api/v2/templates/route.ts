import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { parseDocxBytes } from "@/lib/docx-server";
import { discoverTemplateFields } from "@/lib/template-docx";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); if (!organizationId) return Response.json({ error: "Organization not found" }, { status: 404 });
  const form = await request.formData(); const file = form.get("document"); const name = String(form.get("name") ?? "").trim().slice(0, 160); const contractType = String(form.get("contractType") ?? "agreement").trim().slice(0, 80);
  if (!name || !(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) return Response.json({ error: "A template name and DOCX file are required" }, { status: 400 });
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) return Response.json({ error: "Template must be between 1 byte and 15 MB" }, { status: 413 });
  const bytes = await file.arrayBuffer();
  try { parseDocxBytes(bytes); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read template" }, { status: 400 }); }
  const fields = discoverTemplateFields(bytes); const id = crypto.randomUUID(); const now = new Date().toISOString(); const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140); const objectKey = `orgs/${organizationId}/templates/${id}/v1/${filename}`;
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, customMetadata: { organizationId, templateId: id } });
  try { await env.DB.prepare("INSERT INTO contract_templates (id,organization_id,name,contract_type,object_key,filename,fields,status,version_number,created_at,updated_at) VALUES (?,?,?,?,?,?,json(?),'active',1,?,?)").bind(id, organizationId, name, contractType, objectKey, filename, JSON.stringify(fields), now, now).run(); }
  catch (error) { await env.DOCUMENTS.delete(objectKey); throw error; }
  return Response.json({ template: { id, name, contractType, filename, fields } }, { status: 201 });
}
