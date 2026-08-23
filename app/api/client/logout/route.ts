import { revokeClientSession } from "@/lib/client-auth";

const COOKIE_NAME_HOST = "__Host-pactline_client";
const COOKIE_NAME_DEV = "pactline_client";

export async function POST(request: Request) {
  await revokeClientSession(request);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("Set-Cookie", `${COOKIE_NAME_HOST}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  if (process.env.NODE_ENV !== "production") {
    headers.append("Set-Cookie", `${COOKIE_NAME_DEV}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  }
  return new Response(null, { status: 204, headers });
}
