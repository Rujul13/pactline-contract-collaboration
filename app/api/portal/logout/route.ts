import { clearPortalSessionCookie, revokePortalSession } from "@/lib/portal-auth";

export async function POST(request: Request) {
  await revokePortalSession(request);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearPortalSessionCookie(), "cache-control": "no-store" } });
}
