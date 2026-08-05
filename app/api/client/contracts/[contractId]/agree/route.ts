import { getClientSession } from "@/lib/client-auth";
import { recordCounterpartyAgreement } from "@/lib/agreements";
import { ensureFinalDocument } from "@/lib/contract-download";
import { DomainError } from "@/lib/contracts";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getClientSession(request); if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params; if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  try {
    const result = await recordCounterpartyAgreement(contractId, session, request.headers.get("x-request-id") ?? crypto.randomUUID());
    if (result.locked) await ensureFinalDocument(contractId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to record agreement" }, { status: 500 });
  }
}
