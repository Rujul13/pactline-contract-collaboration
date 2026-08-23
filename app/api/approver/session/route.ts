import { getApproverSession } from "@/lib/approver-auth";
import { captureError } from "@/lib/monitoring";

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const session = await getApproverSession(request);
    if (!session) {
      return Response.json({ authenticated: false, error: "No active or valid approver session" }, { status: 401 });
    }
    return Response.json({ authenticated: true, session });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/session", method: "GET", actorScope: "approver" });
    return Response.json({ error: "Failed to verify session", requestId }, { status: 500 });
  }
}
