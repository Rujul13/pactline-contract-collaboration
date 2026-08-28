import { env } from "cloudflare:workers";
import { randomToken, sha256Hex, verifyPassword } from "./security";

const COOKIE_NAME = "__Host-pactline_portal";
const SESSION_HOURS = 12;
const LOGIN_LOCK_MINUTES = 15;
const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$txVYa3yFdETfi3_MgZXwxY9NGktxRMFAMTHU2JXGB6U";

type PortalAccountRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  username: string;
  password_hash: string;
  display_name: string;
  email: string;
  status: string;
  failed_attempts: number;
  expires_at: string | null;
  updated_at: string;
};

export type PortalSession = {
  sessionId: string;
  accountId: string;
  organizationId: string;
  organizationName: string;
  username: string;
  displayName: string;
  email: string;
};

function cookieValue(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? null;
}

export async function loginPortal(username: string, password: string) {
  const normalized = username.trim().toLowerCase();
  const account = await env.DB.prepare(`SELECT a.*,o.name AS organization_name FROM portal_accounts a JOIN organizations o ON o.id=a.organization_id WHERE lower(a.username)=?`).bind(normalized).first<PortalAccountRow>();
  const now = new Date();
  const lockExpired = account ? now.getTime() - new Date(account.updated_at).getTime() >= LOGIN_LOCK_MINUTES * 60 * 1000 : false;
  const allowed = account && (account.status === "active" || (account.status === "locked" && lockExpired)) && (account.failed_attempts < 8 || lockExpired) && (!account.expires_at || new Date(account.expires_at) > now);
  const verified = await verifyPassword(password, allowed ? account.password_hash : DUMMY_PASSWORD_HASH);
  if (!account || !allowed || !verified) {
    if (account && (account.status !== "locked" || lockExpired)) await env.DB.prepare("UPDATE portal_accounts SET failed_attempts=CASE WHEN ? THEN 1 ELSE failed_attempts+1 END,status=CASE WHEN (CASE WHEN ? THEN 1 ELSE failed_attempts+1 END)>=8 THEN 'locked' ELSE 'active' END,updated_at=? WHERE id=?").bind(lockExpired ? 1 : 0, lockExpired ? 1 : 0, now.toISOString(), account.id).run();
    return null;
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM portal_sessions WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=datetime(?,'-7 days'))").bind(now.toISOString(), now.toISOString()),
    env.DB.prepare("INSERT INTO portal_sessions (id,portal_account_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)").bind(sessionId, account.id, tokenHash, expiresAt, now.toISOString(), now.toISOString()),
    env.DB.prepare("UPDATE portal_accounts SET failed_attempts=0,status='active',last_signed_in_at=?,updated_at=? WHERE id=?").bind(now.toISOString(), now.toISOString(), account.id),
  ]);
  return { token, expiresAt };
}

export async function getPortalSession(request: Request): Promise<PortalSession | null> {
  const token = cookieValue(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT s.id AS session_id,s.expires_at,s.last_seen_at,a.id AS account_id,a.organization_id,a.username,a.display_name,a.email,a.status,o.name AS organization_name FROM portal_sessions s JOIN portal_accounts a ON a.id=s.portal_account_id JOIN organizations o ON o.id=a.organization_id WHERE s.token_hash=? AND s.revoked_at IS NULL`).bind(tokenHash).first<Record<string, string>>();
  const now = new Date();
  if (!row || row.status !== "active" || new Date(row.expires_at) <= now) return null;
  if (now.getTime() - new Date(row.last_seen_at).getTime() >= 5 * 60 * 1000) await env.DB.prepare("UPDATE portal_sessions SET last_seen_at=? WHERE id=?").bind(now.toISOString(), row.session_id).run();
  return { sessionId: row.session_id, accountId: row.account_id, organizationId: row.organization_id, organizationName: row.organization_name, username: row.username, displayName: row.display_name, email: row.email };
}

export async function requirePortalSession(request: Request) {
  const session = await getPortalSession(request);
  return session ? { session, response: null } : { session: null, response: Response.json({ error: "Customer portal sign-in required" }, { status: 401 }) };
}

export async function revokePortalSession(request: Request) {
  const token = cookieValue(request);
  if (token) await env.DB.prepare("UPDATE portal_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").bind(new Date().toISOString(), await sha256Hex(token)).run();
}

export function portalSessionCookie(token: string, expiresAt: string) {
  return `${COOKIE_NAME}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearPortalSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function portalGrant(session: PortalSession, contractId: string) {
  return env.DB.prepare("SELECT permission FROM contract_access_grants WHERE contract_id=? AND portal_account_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").bind(contractId, session.accountId, new Date().toISOString()).first<{ permission: string }>();
}
