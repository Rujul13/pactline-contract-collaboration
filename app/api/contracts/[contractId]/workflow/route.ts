import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract, workflowWorkspace } from "@/lib/workflow";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params;
  const contract = await ownerContract(contractId, auth.user.userId);
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  return Response.json({ contract, ...(await workflowWorkspace(contractId)) }, { headers: { "cache-control": "private, no-store" } });
}
