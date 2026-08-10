import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); const body = await request.json().catch(() => null) as { name?: string; heading?: string; body?: string } | null;
  const name = body?.name?.trim().slice(0, 160); const heading = body?.heading?.trim().slice(0, 300); const text = body?.body?.trim().slice(0, 20_000);
  if (!organizationId || !name || !heading || !text) return Response.json({ error: "Name, heading, and clause text are required" }, { status: 400 });
  const id = crypto.randomUUID(); const now = new Date().toISOString(); await env.DB.prepare("INSERT INTO clause_modules (id,organization_id,name,heading,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?)").bind(id, organizationId, name, heading, text, now, now).run();
  return Response.json({ clauseModule: { id, name, heading, body: text } }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response; const organizationId = await getOwnerOrganizationId(auth.user.userId);
  const rows = await env.DB.prepare("SELECT id,name,heading,body,status FROM clause_modules WHERE organization_id=? AND status='active' ORDER BY name").bind(organizationId).all();
  return Response.json({ clauseModules: rows.results });
}
