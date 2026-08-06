import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { hasClientSessionCookie } from "@/lib/client-auth";

export type OwnerBoundary =
  | { user: ChatGPTUser; response?: never }
  | { user?: never; response: Response };

/**
 * Keeps the owner and reviewer security domains separate even when a reviewer
 * calls an owner API directly instead of using the UI.
 */
export async function requireOwnerApi(request: Request): Promise<OwnerBoundary> {
  // A reviewer credential must never be interpreted as an owner credential.
  // Deny by cookie namespace before any owner-session fallback or route logic.
  if (hasClientSessionCookie(request)) {
    return { response: Response.json({ error: "Owner permission required" }, { status: 403 }) };
  }

  const user = await getChatGPTUser();
  if (user) return { user };
  return { response: Response.json({ error: "Authentication required" }, { status: 401 }) };
}
