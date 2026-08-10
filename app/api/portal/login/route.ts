import { loginPortal, portalSessionCookie } from "@/lib/portal-auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { username?: string; password?: string } | null;
  const username = body?.username?.trim() ?? "";
  const password = body?.password ?? "";
  if (!username || !password) return Response.json({ error: "Username and password are required" }, { status: 400 });
  const result = await loginPortal(username, password);
  if (!result) return Response.json({ error: "The supplied credentials were not accepted" }, { status: 401 });
  return Response.json({ ok: true }, { headers: { "set-cookie": portalSessionCookie(result.token, result.expiresAt), "cache-control": "no-store" } });
}
