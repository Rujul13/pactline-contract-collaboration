import { refreshAlerts } from "@/lib/alerts";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response; const organizationId = await getOwnerOrganizationId(auth.user.userId);
  if (!organizationId) return Response.json({ error: "Organization not found" }, { status: 404 });
  return Response.json(await refreshAlerts(organizationId));
}
