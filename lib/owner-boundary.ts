import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getClientSession } from "@/lib/client-auth";

export type OwnerBoundary =
  | { user: ChatGPTUser; response?: never }
  | { user?: never; response: Response };

/**
 * Keeps the owner and reviewer security domains separate even when a reviewer
 * calls an owner API directly instead of using the UI.
 */
export async function requireOwnerApi(request: Request): Promise<OwnerBoundary> {
  const reviewer = await getClientSession(request);
  if (reviewer) {
    return { response: Response.json({ error: "Owner permission required" }, { status: 403 }) };
  }

  const user = await getChatGPTUser();
  if (user) return { user };
  return { response: Response.json({ error: "Authentication required" }, { status: 401 }) };
}
