import { getChatGPTUser } from "../../../../chatgpt-auth";
import { recordInitiatorAgreement } from "../../../../../lib/agreements";
import { DomainError } from "../../../../../lib/contracts";
import { ensureFinalDocument } from "../../../../../lib/contract-download";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const { contractId } = await context.params;
    const result = await recordInitiatorAgreement(contractId, { id: user.userId, display: user.displayName, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(), ipAddress: request.headers.get("cf-connecting-ip") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined });
    if (result.locked) await ensureFinalDocument(contractId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to record agreement" }, { status: 500 });
  }
}
