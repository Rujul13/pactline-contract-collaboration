import { clearApproverSessionCookie, getApproverTokenFromRequest } from "@/lib/approver-auth";
import { captureError } from "@/lib/monitoring";
import { sha256Hex } from "@/lib/security";
import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const token = getApproverTokenFromRequest(request);
    if (token) {
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare(
        "UPDATE approver_sessions SET revoked_at = ? WHERE token_hash = ?"
      ).bind(new Date().toISOString(), tokenHash).run();
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    clearApproverSessionCookie(headers);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/logout", method: "POST", actorScope: "approver" });
    return Response.json({ error: "Failed to logout session", requestId }, { status: 500 });
  }
}
