import { clearOwnerSessionCookie, safeOwnerReturnPath } from "@/lib/owner-auth";

export async function GET(request: Request) {
  const returnTo = safeOwnerReturnPath(new URL(request.url).searchParams.get("return_to"));
  return new Response(null, {
    status: 303,
    headers: { location: `/owner/login?return_to=${encodeURIComponent(returnTo)}`, "set-cookie": clearOwnerSessionCookie() },
  });
}
