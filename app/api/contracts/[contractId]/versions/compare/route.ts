import { requireOwnerApi } from "@/lib/owner-boundary";
import { compareVersions, ownerContract } from "@/lib/workflow";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  const url = new URL(request.url); const from = Number(url.searchParams.get("from")); const to = Number(url.searchParams.get("to"));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from === to) return Response.json({ error: "Choose two different version numbers" }, { status: 400 });
  const comparison = await compareVersions(contractId, from, to); if (!comparison) return Response.json({ error: "One or both versions were not found" }, { status: 404 });
  return Response.json(comparison, { headers: { "cache-control": "private, no-store" } });
}
