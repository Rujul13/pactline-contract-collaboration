import { createOwnerSessionCookie, ownerLoginAllowed, recordOwnerLoginResult, safeOwnerReturnPath, verifyOwnerPassword } from "@/lib/owner-auth";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 8_192) return Response.json({ error: "Request is too large" }, { status: 413 });
  const limit = await ownerLoginAllowed(request);
  if (!limit.allowed) return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429, headers: { "cache-control": "no-store", "retry-after": "900" } });
  const body = await request.json().catch(() => null) as { password?: unknown; returnTo?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  const verified = await verifyOwnerPassword(password);
  await recordOwnerLoginResult(limit.key, verified);
  if (!verified) {
    return Response.json({ error: "Incorrect owner password" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  return Response.json(
    { ok: true, returnTo: safeOwnerReturnPath(body?.returnTo) },
    { headers: { "cache-control": "no-store", "set-cookie": await createOwnerSessionCookie() } },
  );
}
