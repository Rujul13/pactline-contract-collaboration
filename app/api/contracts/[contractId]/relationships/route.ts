import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getClientSession } from "@/lib/client-auth";
import { getPortalSession, portalGrant } from "@/lib/portal-auth";
import { withMonitoring } from "@/lib/monitoring";

export const GET = withMonitoring(async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await context.params;

  let hasAccess = false;

  // 1. Try owner
  const ownerAuth = await requireOwnerApi(request);
  if (!ownerAuth.response) {
    hasAccess = true;
  } else {
    // 2. Try reviewer session
    const reviewerSession = await getClientSession(request);
    if (reviewerSession) {
      if (reviewerSession.contractId === contractId) {
        hasAccess = true;
      } else {
        return Response.json({ error: "Contract not found" }, { status: 404 });
      }
    } else {
      // 3. Try supplier session
      const supplierSession = await getPortalSession(request);
      if (supplierSession) {
        const grant = await portalGrant(supplierSession, contractId);
        if (grant) {
          hasAccess = true;
        } else {
          return Response.json({ error: "Contract not found" }, { status: 404 });
        }
      }
    }
  }

  if (!hasAccess) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const isOwner = !ownerAuth.response;
  const reviewerSession = await getClientSession(request);
  const supplierSession = await getPortalSession(request);

  try {
    const predecessors = await env.DB.prepare(
      `SELECT r.relationship_type, c.id, c.title, c.lifecycle_stage, c.effective_date, c.status
       FROM contract_relationships r
       JOIN contracts c ON c.id = r.target_contract_id
       WHERE r.source_contract_id = ?`
    ).bind(contractId).all<{ relationship_type: string; id: string; title: string; lifecycle_stage: string; effective_date: string | null; status: string }>();

    const successors = await env.DB.prepare(
      `SELECT r.relationship_type, c.id, c.title, c.lifecycle_stage, c.effective_date, c.status
       FROM contract_relationships r
       JOIN contracts c ON c.id = r.source_contract_id
       WHERE r.target_contract_id = ?`
    ).bind(contractId).all<{ relationship_type: string; id: string; title: string; lifecycle_stage: string; effective_date: string | null; status: string }>();

    const authorizedPredecessors = [];
    for (const c of predecessors.results) {
      let authorized = false;
      if (isOwner) {
        authorized = true;
      } else if (reviewerSession && c.id === reviewerSession.contractId) {
        authorized = true;
      } else if (supplierSession) {
        const grant = await portalGrant(supplierSession, c.id);
        if (grant) {
          authorized = true;
        }
      }
      if (authorized) {
        authorizedPredecessors.push(c);
      }
    }

    const authorizedSuccessors = [];
    for (const c of successors.results) {
      let authorized = false;
      if (isOwner) {
        authorized = true;
      } else if (reviewerSession && c.id === reviewerSession.contractId) {
        authorized = true;
      } else if (supplierSession) {
        const grant = await portalGrant(supplierSession, c.id);
        if (grant) {
          authorized = true;
        }
      }
      if (authorized) {
        authorizedSuccessors.push(c);
      }
    }

    return Response.json({
      contractId,
      predecessors: authorizedPredecessors,
      successors: authorizedSuccessors
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}, "/api/contracts/:contractId/relationships");
