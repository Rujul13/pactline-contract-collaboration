import { getClientSession } from "@/lib/client-auth";

export async function GET(request: Request) {
  const session = await getClientSession(request);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401, headers: { "cache-control": "no-store" } });
  return Response.json({ account: session }, { headers: { "cache-control": "no-store" } });
}
