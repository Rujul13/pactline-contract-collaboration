import { clearClientSessionCookie, revokeClientSession } from "@/lib/client-auth";

export async function POST(request: Request) {
  await revokeClientSession(request);
  return new Response(null, { status: 204, headers: { "set-cookie": clearClientSessionCookie(), "cache-control": "no-store" } });
}
