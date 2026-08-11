import { requireOwnerApi } from "@/lib/owner-boundary";
import { reindexPendingSearchChunks } from "@/lib/search";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId);
  if (!organizationId) return Response.json({ error: "Organization not found" }, { status: 404 });

  try {
    const result = await reindexPendingSearchChunks(organizationId);
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Semantic indexing could not be completed. Keyword search remains available." }, { status: 503 });
  }
}
