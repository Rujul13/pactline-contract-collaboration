import { requireOwnerApi } from "@/lib/owner-boundary";
import { searchKnowledgeBase } from "@/lib/search";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function GET(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 500) ?? "";
  if (!organizationId || query.length < 2) return Response.json({ error: "Enter at least two characters" }, { status: 400 });
  return Response.json(await searchKnowledgeBase(organizationId, query), { headers: { "cache-control": "private, no-store" } });
}
