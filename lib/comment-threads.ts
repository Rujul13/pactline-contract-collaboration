import { env } from "cloudflare:workers";

type ParentRow = { id: string; block_id: string; status: string; parent_comment_id: string | null };
export type ParentValidationReason = "not_found" | "not_root" | "wrong_block" | "resolved";
export type ParentValidation = { ok: true } | { ok: false; reason: ParentValidationReason };

export async function validateReplyParent(contractId: string, parentCommentId: string, blockId: string): Promise<ParentValidation> {
  const parent = await env.DB.prepare("SELECT id, block_id, status, parent_comment_id FROM paragraph_comments WHERE id=? AND contract_id=?").bind(parentCommentId, contractId).first<ParentRow>();
  if (!parent) return { ok: false, reason: "not_found" };
  if (parent.parent_comment_id !== null) return { ok: false, reason: "not_root" };
  if (parent.block_id !== blockId) return { ok: false, reason: "wrong_block" };
  if (parent.status === "resolved") return { ok: false, reason: "resolved" };
  return { ok: true };
}
