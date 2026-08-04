import { clientSessionCookie, loginClient } from "@/lib/client-auth";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 8_192) return Response.json({ error: "Request is too large" }, { status: 413 });
  let body: { username?: string; password?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!body.username || !body.password) return Response.json({ error: "Username and password are required" }, { status: 400 });
  const result = await loginClient(body.username, body.password, request);
  if (!result) return Response.json({ error: "The username or password is incorrect, expired, or locked" }, { status: 401, headers: { "cache-control": "no-store" } });
  return Response.json({ account: result.account }, { headers: { "set-cookie": clientSessionCookie(result.token, result.expiresAt), "cache-control": "no-store" } });
}
