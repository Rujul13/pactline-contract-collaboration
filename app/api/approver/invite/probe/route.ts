import { sha256Hex } from "@/lib/security";
import { captureError } from "@/lib/monitoring";
import { env } from "cloudflare:workers";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  const responseHeaders = new Headers({
    "Content-Type": "application/json",
    "Referrer-Policy": "no-referrer",
  });

  if (!token) {
    return new Response(JSON.stringify({ error: "Token query parameter is required" }), { status: 400, headers: responseHeaders });
  }

  try {
    const tokenHash = await sha256Hex(token);
    const nowStr = new Date().toISOString();

    const invite = await env.DB.prepare(
      `SELECT i.id as invite_id, i.expires_at, i.used_at, i.revoked_at,
              a.kind, a.version_number, c.title as contract_title,
              da.display_name as approver_name, da.title_role
       FROM approval_invites i
       JOIN approval_assignments a ON a.id = i.assignment_id
       JOIN contracts c ON c.id = a.contract_id
       JOIN delegated_approvers da ON da.id = i.delegated_approver_id
       WHERE i.token_hash = ?`
    ).bind(tokenHash).first<{
      invite_id: string;
      expires_at: string;
      used_at: string | null;
      revoked_at: string | null;
      kind: string;
      version_number: number;
      contract_title: string;
      approver_name: string;
      title_role: string;
    }>();

    if (!invite) {
      return new Response(JSON.stringify({ error: "Invitation link not found" }), { status: 404, headers: responseHeaders });
    }
    if (invite.revoked_at) {
      return new Response(JSON.stringify({ error: "Invitation link has been revoked" }), { status: 410, headers: responseHeaders });
    }
    if (invite.used_at) {
      return new Response(JSON.stringify({ error: "Invitation link has already been used" }), { status: 410, headers: responseHeaders });
    }
    if (invite.expires_at <= nowStr) {
      return new Response(JSON.stringify({ error: "Invitation link has expired" }), { status: 410, headers: responseHeaders });
    }

    return new Response(
      JSON.stringify({
        contractTitle: invite.contract_title,
        versionNumber: invite.version_number,
        approverName: invite.approver_name,
        titleRole: invite.title_role,
        kind: invite.kind,
        expiresAt: invite.expires_at,
      }),
      { status: 200, headers: responseHeaders }
    );
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/invite/probe", method: "GET", actorScope: "approver" });
    return new Response(JSON.stringify({ error: "Failed to probe invite token", requestId }), { status: 500, headers: responseHeaders });
  }
}
