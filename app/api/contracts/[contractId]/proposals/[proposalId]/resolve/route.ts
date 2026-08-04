import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { DomainError, resolveProposal, type ResolveAction } from "../../../../../../../lib/contracts";

export async function POST(request: Request, context: { params: Promise<{ contractId: string; proposalId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const { contractId, proposalId } = await context.params;
    const body = await request.json() as { action?: ResolveAction; counterText?: string };
    if (!body.action || !["accept", "reject", "counter"].includes(body.action)) return Response.json({ error: "A valid action is required" }, { status: 400 });
    const result = await resolveProposal(contractId, proposalId, body.action, {
      id: user.userId,
      display: user.displayName,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      ipAddress: request.headers.get("cf-connecting-ip") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    }, body.counterText);
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to resolve proposal" }, { status: 500 });
  }
}
