import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { hashPassword, temporaryPassword } from "@/lib/security";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const { contractId } = await context.params;
  const owner = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ?").bind(contractId, user.userId).first();
  if (!owner) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { partyId?: string; username?: string; permission?: "view" | "comment" | "propose_changes"; expiresAt?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const username = body.username?.trim().toLowerCase();
  if (!body.partyId || !username || !/^[a-z0-9._-]{4,64}$/.test(username)) return Response.json({ error: "A valid party and username are required" }, { status: 400 });
  const party = await env.DB.prepare("SELECT id FROM parties WHERE id = ? AND contract_id = ? AND role = 'counterparty'").bind(body.partyId, contractId).first();
  if (!party) return Response.json({ error: "Counterparty contact not found" }, { status: 404 });
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date() || expiresAt > new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)) return Response.json({ error: "Expiry must be within the next 90 days" }, { status: 400 });
  const password = temporaryPassword(); const passwordHash = await hashPassword(password); const accountId = crypto.randomUUID(); const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO access_accounts (id, contract_id, party_id, username, password_hash, permission, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?, ?)").bind(accountId, contractId, body.partyId, username, passwordHash, body.permission ?? "propose_changes", expiresAt.toISOString(), now, now),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'access.created', 'access_account', ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, accountId, request.headers.get("x-request-id") ?? crypto.randomUUID(), JSON.stringify({ username, expiresAt: expiresAt.toISOString(), permission: body.permission ?? "propose_changes" }), now),
    ]);
  } catch { return Response.json({ error: "Username already exists or access could not be created" }, { status: 409 }); }
  return Response.json({ account: { id: accountId, username, permission: body.permission ?? "propose_changes", expiresAt: expiresAt.toISOString() }, temporaryPassword: password }, { status: 201, headers: { "cache-control": "no-store" } });
}
