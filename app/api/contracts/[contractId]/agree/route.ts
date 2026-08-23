import { requireOwnerApi } from "@/lib/owner-boundary";
import { recordInitiatorAgreement } from "../../../../../lib/agreements";
import { DomainError } from "../../../../../lib/domain-error";
import { ensureFinalDocument } from "../../../../../lib/contract-download";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  try {
    const { contractId } = await context.params;
    const result = await recordInitiatorAgreement(contractId, { id: user.userId, display: user.displayName, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(), ipAddress: request.headers.get("cf-connecting-ip") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined });
    if (result.locked) await ensureFinalDocument(contractId).catch((err) => console.error("ensureFinalDocument error:", err));
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to record agreement" }, { status: 500 });
  }
}
