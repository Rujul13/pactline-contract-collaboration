import { env } from "cloudflare:workers";
import { sha256Hex } from "./security";

export const APPROVER_COOKIE_HOST = "__Host-Pactline-Approver-Session";
export const APPROVER_COOKIE_DEV = "pactline_approver_session";

export type ApproverSession = {
  sessionId: string;
  delegatedApproverId: string;
  organizationId: string;
  email: string;
  displayName: string;
  titleRole: string;
};

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = val;
    }
  }
  return cookies;
}

export function getApproverTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  const cookies = parseCookies(cookieHeader);
  return cookies[APPROVER_COOKIE_HOST] || cookies[APPROVER_COOKIE_DEV] || null;
}

export async function createApprovalInvite(
  assignmentId: string,
  delegatedApproverId: string,
  createdBy: string,
  baseUrl: string
): Promise<{ inviteId: string; rawToken: string; inviteUrl: string; expiresAt: string }> {
  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours TTL
  const inviteId = crypto.randomUUID();

  // Revoke any previous unconsumed invites for this assignment
  await env.DB.prepare(
    "UPDATE approval_invites SET revoked_at = ? WHERE assignment_id = ? AND used_at IS NULL AND revoked_at IS NULL"
  ).bind(now.toISOString(), assignmentId).run();

  await env.DB.prepare(
    `INSERT INTO approval_invites
       (id, assignment_id, delegated_approver_id, token_hash, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(inviteId, assignmentId, delegatedApproverId, tokenHash, expiresAt, createdBy, now.toISOString()).run();

  const inviteUrl = `${baseUrl}/approve/invite?token=${rawToken}`;
  return { inviteId, rawToken, inviteUrl, expiresAt };
}

export async function consumeInviteToken(
  rawToken: string
): Promise<{ success: true; sessionToken: string; delegatedApproverId: string; assignmentId: string; contractId: string } | { success: false; error: string }> {
  if (!rawToken || typeof rawToken !== "string") {
    return { success: false, error: "Invalid invitation token format" };
  }

  const tokenHash = await sha256Hex(rawToken);
  const nowStr = new Date().toISOString();

  const invite = await env.DB.prepare(
    `SELECT i.id as invite_id, i.assignment_id, i.delegated_approver_id, i.expires_at, i.used_at, i.revoked_at, a.contract_id
     FROM approval_invites i
     JOIN approval_assignments a ON a.id = i.assignment_id
     WHERE i.token_hash = ?`
  ).bind(tokenHash).first<{
    invite_id: string;
    assignment_id: string;
    delegated_approver_id: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
    contract_id: string;
  }>();

  if (!invite) {
    return { success: false, error: "Invitation link not found" };
  }
  if (invite.revoked_at) {
    return { success: false, error: "Invitation link has been revoked" };
  }
  if (invite.used_at) {
    return { success: false, error: "Invitation link has already been used" };
  }
  if (invite.expires_at <= nowStr) {
    return { success: false, error: "Invitation link has expired" };
  }

  // Mark invite as consumed
  await env.DB.prepare(
    "UPDATE approval_invites SET used_at = ? WHERE id = ?"
  ).bind(nowStr, invite.invite_id).run();

  // Create approver session
  const sessionToken = generateToken();
  const sessionHash = await sha256Hex(sessionToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 hours absolute max

  await env.DB.prepare(
    `INSERT INTO approver_sessions
       (id, delegated_approver_id, token_hash, expires_at, last_active_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, invite.delegated_approver_id, sessionHash, expiresAt, nowStr, nowStr).run();

  return {
    success: true,
    sessionToken,
    delegatedApproverId: invite.delegated_approver_id,
    assignmentId: invite.assignment_id,
    contractId: invite.contract_id,
  };
}

export async function getApproverSession(request: Request): Promise<ApproverSession | null> {
  const token = getApproverTokenFromRequest(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const nowStr = now.toISOString();

  const session = await env.DB.prepare(
    `SELECT s.id as session_id, s.delegated_approver_id, s.expires_at, s.last_active_at, s.revoked_at,
            da.organization_id, da.email, da.display_name, da.title_role, da.status as approver_status
     FROM approver_sessions s
     JOIN delegated_approvers da ON da.id = s.delegated_approver_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first<{
    session_id: string;
    delegated_approver_id: string;
    expires_at: string;
    last_active_at: string;
    revoked_at: string | null;
    organization_id: string;
    email: string;
    display_name: string;
    title_role: string;
    approver_status: string;
  }>();

  if (!session || session.revoked_at || session.approver_status !== "active") {
    return null;
  }

  // Check 8-hour absolute maximum TTL
  if (session.expires_at <= nowStr) {
    return null;
  }

  // Check 30-minute sliding inactivity timeout
  const lastActiveTime = new Date(session.last_active_at).getTime();
  const inactivityMs = now.getTime() - lastActiveTime;
  if (inactivityMs > 30 * 60 * 1000) {
    // Revoke session due to inactivity
    await env.DB.prepare("UPDATE approver_sessions SET revoked_at = ? WHERE id = ?").bind(nowStr, session.session_id).run();
    return null;
  }

  // Update sliding activity timestamp asynchronously
  await env.DB.prepare("UPDATE approver_sessions SET last_active_at = ? WHERE id = ?").bind(nowStr, session.session_id).run();

  return {
    sessionId: session.session_id,
    delegatedApproverId: session.delegated_approver_id,
    organizationId: session.organization_id,
    email: session.email,
    displayName: session.display_name,
    titleRole: session.title_role,
  };
}

export function applyApproverSessionCookie(headers: Headers, sessionToken: string): void {
  // Set Host cookie as primary, and fallback cookie for dev environment non-HTTPS
  headers.append(
    "Set-Cookie",
    `${APPROVER_COOKIE_HOST}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`
  );
  headers.append(
    "Set-Cookie",
    `${APPROVER_COOKIE_DEV}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`
  );
}

export function clearApproverSessionCookie(headers: Headers): void {
  headers.append("Set-Cookie", `${APPROVER_COOKIE_HOST}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  headers.append("Set-Cookie", `${APPROVER_COOKIE_DEV}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export async function instantiateNextVersionApprovals(
  contractId: string,
  previousVersion: number,
  nextVersion: number,
  now: string
): Promise<void> {
  const prevAssignments = await env.DB.prepare(
    `SELECT DISTINCT delegated_approver_id, kind, required, assigned_by
     FROM approval_assignments
     WHERE contract_id = ? AND version_number = ? AND status != 'revoked'`
  ).bind(contractId, previousVersion).all<{
    delegated_approver_id: string;
    kind: string;
    required: number;
    assigned_by: string;
  }>();

  if (!prevAssignments || !prevAssignments.results || prevAssignments.results.length === 0) {
    return;
  }

  for (const prev of prevAssignments.results) {
    const newId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO approval_assignments
         (id, contract_id, delegated_approver_id, version_number, kind, required, status, assigned_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(newId, contractId, prev.delegated_approver_id, nextVersion, prev.kind, prev.required, prev.assigned_by, now, now).run();
  }
}
