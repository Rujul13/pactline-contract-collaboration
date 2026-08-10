import { docxResponse, ensureFinalDocument } from "@/lib/contract-download";
import { portalGrant, requirePortalSession } from "@/lib/portal-auth";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const grant = await portalGrant(auth.session!, contractId);
  if (!grant) return Response.json({ error: "Contract not found" }, { status: 404 });
  const rendered = await ensureFinalDocument(contractId);
  if (!rendered) return Response.json({ error: "The final document is available only after both parties agree" }, { status: 409 });
  return docxResponse(rendered);
}
