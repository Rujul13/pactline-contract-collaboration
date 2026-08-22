import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";
import { createApprovalInvite } from "@/lib/approver-auth";
import { enqueueNotification } from "@/lib/notifications";
import { DEMO_OWNER_ORGANIZATION_ID } from "@/lib/v2";

const KINDS = ["legal", "finance", "security", "business"];

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;

  const { contractId } = await context.params;
  const contract = await ownerContract(contractId, auth.user.userId);
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  try {
    // 1. Fetch Phase 1 approval_requests
    const legacyRequests = await env.DB.prepare(
      `SELECT r.*, u.display_name as approver_name, u.email as approver_email
       FROM approval_requests r
       JOIN users u ON u.id = r.approver_id
       WHERE r.contract_id = ?
       ORDER BY r.version_number DESC, r.created_at DESC`
    ).bind(contractId).all();

    // 2. Fetch Phase 3 approval_assignments with delegated_approvers and active invite info
    const assignments = await env.DB.prepare(
      `SELECT a.*, da.email as approver_email, da.display_name as approver_name, da.title_role as approver_title_role,
              i.id as active_invite_id, i.expires_at as invite_expires_at, i.used_at as invite_used_at, i.revoked_at as invite_revoked_at
       FROM approval_assignments a
       JOIN delegated_approvers da ON da.id = a.delegated_approver_id
       LEFT JOIN approval_invites i ON i.assignment_id = a.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
       WHERE a.contract_id = ?
       ORDER BY a.version_number DESC, a.created_at DESC`
    ).bind(new Date().toISOString(), contractId).all();

    return Response.json({
      contractId,
      currentVersion: contract.current_version,
      legacyRequests: legacyRequests.results || [],
      assignments: assignments.results || [],
    });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/approvals", method: "GET", actorScope: "owner", contractId });
    return Response.json({ error: "Failed to fetch approvals matrix", requestId }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;

  const { contractId } = await context.params;
  const contract = await ownerContract(contractId, auth.user.userId);
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });

  let body: {
    action?: "require" | "decide" | "assign_delegated" | "reassign_delegated" | "invite_delegated" | "revoke_delegated";
    kind?: string;
    approvalId?: string;
    assignmentId?: string;
    decision?: "approved" | "edits_requested" | "rejected";
    reason?: string;
    email?: string;
    displayName?: string;
    titleRole?: string;
    required?: boolean;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Valid JSON is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  try {
    // ------------------------------------------------------------------
    // Phase 1 Legacy: "require" internal user approval
    // ------------------------------------------------------------------
    if (body.action === "require") {
      const kind = String(body.kind ?? "business");
      if (!KINDS.includes(kind)) return Response.json({ error: "Invalid approval kind" }, { status: 400 });

      const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(auth.user.userId).first<{ id: string }>();
      if (!owner) return Response.json({ error: "Owner account not found" }, { status: 404 });

      const duplicate = await env.DB.prepare(
        "SELECT id FROM approval_requests WHERE contract_id = ? AND version_number=? AND kind = ? AND required = 1 AND status = 'pending'"
      ).bind(contractId, contract.current_version, kind).first();
      if (duplicate) return Response.json({ error: "That approval is already required for this version" }, { status: 409 });

      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO approval_requests (id, contract_id, approver_id, version_number, kind, required, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)"
        ).bind(id, contractId, owner.id, contract.current_version, kind, now, now),
        env.DB.prepare("UPDATE contracts SET lifecycle_stage = 'internal_review', updated_at = ? WHERE id = ?").bind(now, contractId),
        env.DB.prepare(
          "INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'approval.required', 'approval', ?, ?, ?, json(?), ?)"
        ).bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, contract.current_version, requestId, JSON.stringify({ kind }), now),
      ]);
      return Response.json({ approval: { id, kind, status: "pending", versionNumber: contract.current_version } }, { status: 201 });
    }

    // ------------------------------------------------------------------
    // Phase 1 Legacy: "decide" internal user approval
    // ------------------------------------------------------------------
    if (body.action === "decide" && body.approvalId && body.decision && ["approved", "edits_requested", "rejected"].includes(body.decision)) {
      const reason = body.reason?.trim();
      if (!reason || reason.length < 5 || reason.length > 2000) {
        return Response.json({ error: "A decision reason of at least 5 characters is required" }, { status: 400 });
      }

      const result = await env.DB.prepare(
        "UPDATE approval_requests SET status = ?, decision_reason = ?, comment = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND contract_id = ? AND status = 'pending'"
      ).bind(body.decision, reason, reason, now, now, body.approvalId, contractId).run();

      if (!result.meta.changes) return Response.json({ error: "Pending approval not found" }, { status: 404 });

      await env.DB.prepare(
        "INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'approval.decided', 'approval', ?, ?, ?, json(?), ?)"
      ).bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.approvalId, contract.current_version, requestId, JSON.stringify({ decision: body.decision, reason }), now).run();

      return Response.json({ decided: true, status: body.decision });
    }

    // ------------------------------------------------------------------
    // Phase 3: "assign_delegated" Approver
    // ------------------------------------------------------------------
    if (body.action === "assign_delegated") {
      const email = body.email?.trim().toLowerCase();
      const displayName = body.displayName?.trim();
      const titleRole = body.titleRole?.trim();
      const kind = String(body.kind ?? "business");
      const required = body.required !== false;

      if (!email || !displayName || !titleRole) {
        return Response.json({ error: "Email, display name, and title/role are required for delegated approver" }, { status: 400 });
      }
      if (!KINDS.includes(kind)) return Response.json({ error: "Invalid approval kind" }, { status: 400 });

      const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(auth.user.userId).first<{ id: string }>();
      if (!owner) return Response.json({ error: "Owner account not found" }, { status: 404 });

      const orgId = contract.owner_organization_id || DEMO_OWNER_ORGANIZATION_ID;

      // 1. Find or Create delegated_approver in organization
      let approver = await env.DB.prepare(
        "SELECT id FROM delegated_approvers WHERE organization_id = ? AND email = ?"
      ).bind(orgId, email).first<{ id: string }>();

      if (!approver) {
        const approverId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO delegated_approvers (id, organization_id, email, display_name, title_role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        ).bind(approverId, orgId, email, displayName, titleRole, now, now).run();
        approver = { id: approverId };
      } else {
        // Update display_name / title_role if changed
        await env.DB.prepare(
          "UPDATE delegated_approvers SET display_name = ?, title_role = ?, updated_at = ? WHERE id = ?"
        ).bind(displayName, titleRole, now, approver.id).run();
      }

      // Check if duplicate pending assignment exists for active version, approver, and kind
      const duplicate = await env.DB.prepare(
        "SELECT id FROM approval_assignments WHERE contract_id = ? AND version_number=? AND delegated_approver_id = ? AND kind = ? AND status = 'pending'"
      ).bind(contractId, contract.current_version, approver.id, kind).first();

      if (duplicate) {
        return Response.json({ error: "This approver is already assigned to this approval kind for the active version" }, { status: 409 });
      }

      // 2. Create approval_assignments row
      const assignmentId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO approval_assignments
           (id, contract_id, delegated_approver_id, version_number, kind, required, status, assigned_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).bind(assignmentId, contractId, approver.id, contract.current_version, kind, required ? 1 : 0, owner.id, now, now).run();

      // 3. Create approval_invite (24h TTL)
      const invite = await createApprovalInvite(assignmentId, approver.id, owner.id);

      // 4. Update contract stage to internal_review
      await env.DB.prepare("UPDATE contracts SET lifecycle_stage = 'internal_review', updated_at = ? WHERE id = ?").bind(now, contractId).run();

      // 5. Enqueue local-stub delivery notification
      await enqueueNotification(
        email,
        "approval",
        "delegated_approval_invite",
        { contractId, assignmentId, kind, inviteUrl: invite.inviteUrl },
        `invite:${assignmentId}`
      );

      // 6. Record audit log entries
      await env.DB.prepare(
        `INSERT INTO audit_log_entries
           (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'delegated_approver.assigned', 'approval_assignment', ?, ?, ?, json(?), ?)`
      ).bind(
        crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, assignmentId, contract.current_version, requestId,
        JSON.stringify({ kind, email, displayName, titleRole, delegatedApproverId: approver.id }), now
      ).run();

      await env.DB.prepare(
        `INSERT INTO audit_log_entries
           (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'approval_invite.created', 'approval_invite', ?, ?, ?, json(?), ?)`
      ).bind(
        crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, invite.inviteId, contract.current_version, requestId,
        JSON.stringify({ assignmentId, expiresAt: invite.expiresAt }), now
      ).run();

      return Response.json({
        assignment: {
          id: assignmentId,
          contractId,
          versionNumber: contract.current_version,
          kind,
          required,
          status: "pending",
          approver: { id: approver.id, email, displayName, titleRole },
          inviteUrl: invite.inviteUrl,
          expiresAt: invite.expiresAt,
        }
      }, { status: 201 });
    }

    // ------------------------------------------------------------------
    // Phase 3: "reassign_delegated" Approver (Preserves Audit History)
    // ------------------------------------------------------------------
    if (body.action === "reassign_delegated") {
      const assignmentId = body.assignmentId;
      const email = body.email?.trim().toLowerCase();
      const displayName = body.displayName?.trim();
      const titleRole = body.titleRole?.trim();

      if (!assignmentId || !email || !displayName || !titleRole) {
        return Response.json({ error: "Assignment ID, email, display name, and title/role are required for reassignment" }, { status: 400 });
      }

      const existing = await env.DB.prepare(
        "SELECT * FROM approval_assignments WHERE id = ? AND contract_id = ?"
      ).bind(assignmentId, contractId).first<{ id: string; version_number: number; kind: string; required: number; status: string }>();

      if (!existing) return Response.json({ error: "Existing assignment not found" }, { status: 404 });

      const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(auth.user.userId).first<{ id: string }>();
      if (!owner) return Response.json({ error: "Owner account not found" }, { status: 404 });

      const orgId = contract.owner_organization_id || DEMO_OWNER_ORGANIZATION_ID;

      // 1. Mark existing assignment as superseded (preserving history)
      await env.DB.prepare(
        "UPDATE approval_assignments SET status = 'superseded', updated_at = ? WHERE id = ?"
      ).bind(now, assignmentId).run();

      // Revoke any pending invites for old assignment
      await env.DB.prepare(
        "UPDATE approval_invites SET revoked_at = ? WHERE assignment_id = ? AND used_at IS NULL AND revoked_at IS NULL"
      ).bind(now, assignmentId).run();

      // 2. Find or Create new delegated_approver
      let newApprover = await env.DB.prepare(
        "SELECT id FROM delegated_approvers WHERE organization_id = ? AND email = ?"
      ).bind(orgId, email).first<{ id: string }>();

      if (!newApprover) {
        const newId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO delegated_approvers (id, organization_id, email, display_name, title_role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        ).bind(newId, orgId, email, displayName, titleRole, now, now).run();
        newApprover = { id: newId };
      }

      // 3. Create fresh approval_assignments row for new approver
      const newAssignmentId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO approval_assignments
           (id, contract_id, delegated_approver_id, version_number, kind, required, status, assigned_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).bind(newAssignmentId, contractId, newApprover.id, existing.version_number, existing.kind, existing.required, owner.id, now, now).run();

      // 4. Create fresh invite (24h TTL)
      const invite = await createApprovalInvite(newAssignmentId, newApprover.id, owner.id);

      // Audit log event
      await env.DB.prepare(
        `INSERT INTO audit_log_entries
           (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'approval_assignment.reassigned', 'approval_assignment', ?, ?, ?, json(?), ?)`
      ).bind(
        crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, newAssignmentId, existing.version_number, requestId,
        JSON.stringify({ oldAssignmentId: assignmentId, newAssignmentId, newApproverId: newApprover.id, email }), now
      ).run();

      return Response.json({
        assignment: {
          id: newAssignmentId,
          contractId,
          versionNumber: existing.version_number,
          kind: existing.kind,
          status: "pending",
          approver: { id: newApprover.id, email, displayName, titleRole },
          inviteUrl: invite.inviteUrl,
          expiresAt: invite.expiresAt,
        }
      }, { status: 201 });
    }

    // ------------------------------------------------------------------
    // Phase 3: "invite_delegated" Fresh 24h Invite Generation
    // ------------------------------------------------------------------
    if (body.action === "invite_delegated") {
      const assignmentId = body.assignmentId;
      if (!assignmentId) return Response.json({ error: "Assignment ID is required" }, { status: 400 });

      const assignment = await env.DB.prepare(
        "SELECT * FROM approval_assignments WHERE id = ? AND contract_id = ? AND status = 'pending'"
      ).bind(assignmentId, contractId).first<{ id: string; delegated_approver_id: string }>();

      if (!assignment) return Response.json({ error: "Pending assignment not found" }, { status: 404 });

      const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(auth.user.userId).first<{ id: string }>();
      if (!owner) return Response.json({ error: "Owner account not found" }, { status: 404 });

      const invite = await createApprovalInvite(assignment.id, assignment.delegated_approver_id, owner.id);

      await env.DB.prepare(
        `INSERT INTO audit_log_entries
           (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'approval_invite.created', 'approval_invite', ?, ?, ?, json(?), ?)`
      ).bind(
        crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, invite.inviteId, contract.current_version, requestId,
        JSON.stringify({ assignmentId: assignment.id, expiresAt: invite.expiresAt }), now
      ).run();

      return Response.json({ inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt });
    }

    // ------------------------------------------------------------------
    // Phase 3: "revoke_delegated" Assignment / Invite
    // ------------------------------------------------------------------
    if (body.action === "revoke_delegated") {
      const assignmentId = body.assignmentId;
      if (!assignmentId) return Response.json({ error: "Assignment ID is required" }, { status: 400 });

      await env.DB.prepare(
        "UPDATE approval_assignments SET status = 'revoked', updated_at = ? WHERE id = ? AND contract_id = ?"
      ).bind(now, assignmentId, contractId).run();

      await env.DB.prepare(
        "UPDATE approval_invites SET revoked_at = ? WHERE assignment_id = ? AND used_at IS NULL AND revoked_at IS NULL"
      ).bind(now, assignmentId).run();

      await env.DB.prepare(
        `INSERT INTO audit_log_entries
           (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'approval_invite.revoked', 'approval_assignment', ?, ?, ?, json(?), ?)`
      ).bind(
        crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, assignmentId, contract.current_version, requestId,
        JSON.stringify({ assignmentId }), now
      ).run();

      return Response.json({ revoked: true });
    }

    return Response.json({ error: "Invalid approval action" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/approvals", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update approval workflow", requestId }, { status: 500 });
  }
}
