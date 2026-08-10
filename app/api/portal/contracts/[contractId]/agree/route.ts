import { env } from "cloudflare:workers";
import { recordCounterpartyAgreement } from "@/lib/agreements";
import { ensureFinalDocument } from "@/lib/contract-download";
import { DomainError } from "@/lib/domain-error";
import { portalGrant, requirePortalSession } from "@/lib/portal-auth";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const grant = await portalGrant(auth.session!, contractId);
  if (!grant) return Response.json({ error: "Contract not found" }, { status: 404 });
  const party = await env.DB.prepare("SELECT id FROM parties WHERE contract_id=? AND role='counterparty'").bind(contractId).first<{ id: string }>();
  if (!party) return Response.json({ error: "Counterparty record not found" }, { status: 409 });
  try {
    const result = await recordCounterpartyAgreement(contractId, { accountId: auth.session!.accountId, partyId: party.id, name: auth.session!.displayName, username: auth.session!.username }, crypto.randomUUID());
    if (result.locked) await ensureFinalDocument(contractId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Unable to record agreement" }, { status: 500 });
  }
}
