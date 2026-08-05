import { env } from "cloudflare:workers";
import { randomToken, sha256Hex, verifyPassword } from "./security";

const COOKIE_NAME = "__Host-pactline_client";
const SESSION_HOURS = 8;
const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$txVYa3yFdETfi3_MgZXwxY9NGktxRMFAMTHU2JXGB6U";

type AccountRow = { id: string; contract_id: string; party_id: string; username: string; password_hash: string; permission: string; status: string; failed_attempts: number; expires_at: string; name: string; company: string; email: string };
export type ClientSession = { sessionId: string; accountId: string; contractId: string; partyId: string; username: string; permission: string; name: string; company: string; email: string };

function cookieValue(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? null;
}

export async function loginClient(username: string, password: string, request: Request) {
  const normalized = username.trim().toLowerCase();
  const account = await env.DB.prepare(`SELECT a.*, p.name, p.company, p.email FROM access_accounts a JOIN parties p ON p.id = a.party_id WHERE lower(a.username) = ?`).bind(normalized).first<AccountRow>();
  const now = new Date();
  const allowed = account && ["invited", "active"].includes(account.status) && new Date(account.expires_at) > now && account.failed_attempts < 8;
  const passwordMatches = await verifyPassword(password, allowed ? account.password_hash : DUMMY_PASSWORD_HASH);
  const verified = Boolean(allowed && passwordMatches);
  if (!account || !verified) {
    if (account) await env.DB.prepare("UPDATE access_accounts SET failed_attempts = failed_attempts + 1, status = CASE WHEN failed_attempts + 1 >= 8 THEN 'locked' ELSE status END, updated_at = ? WHERE id = ?").bind(now.toISOString(), account.id).run();
    return null;
  }
  const token = randomToken(); const tokenHash = await sha256Hex(token); const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  const ipHash = request.headers.get("cf-connecting-ip") ? await sha256Hex(request.headers.get("cf-connecting-ip")!) : null;
  const userAgentHash = request.headers.get("user-agent") ? await sha256Hex(request.headers.get("user-agent")!) : null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO access_sessions (id, access_account_id, token_hash, expires_at, ip_hash, user_agent_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(sessionId, account.id, tokenHash, expiresAt, ipHash, userAgentHash, now.toISOString(), now.toISOString()),
    env.DB.prepare("UPDATE access_accounts SET status = 'active', failed_attempts = 0, last_signed_in_at = ?, updated_at = ? WHERE id = ?").bind(now.toISOString(), now.toISOString(), account.id),
  ]);
  return { token, expiresAt, account: { accountId: account.id, contractId: account.contract_id, partyId: account.party_id, username: account.username, permission: account.permission, name: account.name, company: account.company, email: account.email } };
}

export async function getClientSession(request: Request): Promise<ClientSession | null> {
  const token = cookieValue(request); if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT s.id AS session_id, a.id AS account_id, a.contract_id, a.party_id, a.username, a.permission, a.status, a.expires_at AS account_expires_at, s.expires_at AS session_expires_at, p.name, p.company, p.email FROM access_sessions s JOIN access_accounts a ON a.id = s.access_account_id JOIN parties p ON p.id = a.party_id WHERE s.token_hash = ? AND s.revoked_at IS NULL`).bind(tokenHash).first<Record<string, string>>();
  const now = new Date();
  if (!row || row.status !== "active" || new Date(row.account_expires_at) <= now || new Date(row.session_expires_at) <= now) return null;
  await env.DB.prepare("UPDATE access_sessions SET last_seen_at = ? WHERE id = ?").bind(now.toISOString(), row.session_id).run();
  return { sessionId: row.session_id, accountId: row.account_id, contractId: row.contract_id, partyId: row.party_id, username: row.username, permission: row.permission, name: row.name, company: row.company, email: row.email };
}

export async function revokeClientSession(request: Request) {
  const token = cookieValue(request); if (!token) return;
  await env.DB.prepare("UPDATE access_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(new Date().toISOString(), await sha256Hex(token)).run();
}

export function clientSessionCookie(token: string, expiresAt: string) {
  return `${COOKIE_NAME}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearClientSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
