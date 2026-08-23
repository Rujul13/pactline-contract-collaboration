import { getPortalSession } from "@/lib/portal-auth";
import { recordCounterpartyAgreement } from "@/lib/agreements";
import { ensureFinalDocument } from "@/lib/contract-download";
import { DomainError } from "@/lib/domain-error";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getPortalSession(request); if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params; if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  try {
    const result = await recordCounterpartyAgreement(contractId, { accountId: session.accountId, partyId: session.partyId, name: session.name, username: session.email }, request.headers.get("x-request-id") ?? crypto.randomUUID());
    if (result.locked) await ensureFinalDocument(contractId).catch((err) => console.error("ensureFinalDocument error:", err));
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to record agreement" }, { status: 500 });
  }
}
