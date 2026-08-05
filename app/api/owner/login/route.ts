import { createOwnerSessionCookie, safeOwnerReturnPath, verifyOwnerPassword } from "@/lib/owner-auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { password?: unknown; returnTo?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await verifyOwnerPassword(password))) {
    return Response.json({ error: "Incorrect owner password" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  return Response.json(
    { ok: true, returnTo: safeOwnerReturnPath(body?.returnTo) },
    { headers: { "cache-control": "no-store", "set-cookie": await createOwnerSessionCookie() } },
  );
}
