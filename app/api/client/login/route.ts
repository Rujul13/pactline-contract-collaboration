import { loginClient } from "@/lib/client-auth";

const COOKIE_NAME_HOST = "__Host-pactline_client";
const COOKIE_NAME_DEV = "pactline_client";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 8_192) return Response.json({ error: "Request is too large" }, { status: 413 });
  let body: { username?: string; password?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!body.username || !body.password) return Response.json({ error: "Username and password are required" }, { status: 400 });
  const result = await loginClient(body.username, body.password, request);
  if (!result) return Response.json({ error: "The username or password is incorrect, expired, or locked" }, { status: 401, headers: { "cache-control": "no-store" } });
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("Set-Cookie", `${COOKIE_NAME_HOST}=${result.token}; Path=/; Expires=${new Date(result.expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`);
  if (process.env.NODE_ENV !== "production") {
    headers.append("Set-Cookie", `${COOKIE_NAME_DEV}=${result.token}; Path=/; Expires=${new Date(result.expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`);
  }
  return Response.json({ account: result.account }, { headers });
}
