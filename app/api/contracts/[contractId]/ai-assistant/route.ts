import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { AiProviderError, askContractAssistant, currentGroqModel, type AiHistoryMessage, type AiMode } from "@/lib/ai-assistant";

const MODES: AiMode[] = ["chat", "draft_clause", "rewrite", "check"];

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 80_000) return Response.json({ error: "AI request is too large" }, { status: 413 });
  const { contractId } = await context.params;
  let body: { mode?: AiMode; message?: string; targetBlockId?: string | null; history?: AiHistoryMessage[]; acknowledgedExternalProcessing?: boolean };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const message = body.message?.trim();
  if (!body.mode || !MODES.includes(body.mode) || !message || message.length > 4_000) return Response.json({ error: "Choose an AI mode and enter a message of 4,000 characters or fewer" }, { status: 400 });
  if (body.acknowledgedExternalProcessing !== true) return Response.json({ error: "Acknowledge external AI processing before continuing" }, { status: 400 });
  const history = Array.isArray(body.history) ? body.history.slice(-12).flatMap((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string" && item.content.trim() ? [{ role: item.role, content: item.content.trim().slice(0, 4_000) } as AiHistoryMessage] : []) : [];
  const contract = await env.DB.prepare(`SELECT c.id, c.title, c.current_version, c.status FROM contracts c JOIN users u ON u.id=c.initiator_id WHERE c.id=? AND u.external_identity_id=?`).bind(contractId, user.userId).first<{ id: string; title: string; current_version: number; status: string }>();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const blocks = await env.DB.prepare("SELECT id, order_index, kind, current_text FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all<{ id: string; order_index: number; kind: string; current_text: string }>();
  if (body.targetBlockId && !blocks.results.some((block) => block.id === body.targetBlockId)) return Response.json({ error: "Selected paragraph not found" }, { status: 404 });
  if (body.mode === "rewrite" && !body.targetBlockId) return Response.json({ error: "Select a paragraph before asking for a rewrite" }, { status: 400 });
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const usage = await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_log_entries WHERE actor_id=? AND action='ai.assistant_attempted' AND created_at>=?").bind(user.userId, hourAgo).first<{ total: number }>();
  if ((usage?.total ?? 0) >= 20) return Response.json({ error: "AI generation limit reached. Try again later." }, { status: 429 });
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const attemptedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'ai.assistant_attempted', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, contractId, contract.current_version, requestId, JSON.stringify({ mode: body.mode, model: currentGroqModel(), targetBlockId: body.targetBlockId ?? null }), attemptedAt).run();
  try {
    const result = await askContractAssistant({ mode: body.mode, message, history, title: contract.title, version: contract.current_version, blocks: blocks.results, targetBlockId: body.targetBlockId });
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'ai.assistant_invoked', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, contractId, contract.current_version, requestId, JSON.stringify({ mode: body.mode, model: currentGroqModel(), targetBlockId: body.targetBlockId ?? null, operation: result.operation, inScope: result.inScope }), now).run();
    return Response.json({ ...result, model: currentGroqModel(), contractStatus: contract.status }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AiProviderError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Contract AI assistant failed", error);
    return Response.json({ error: "The AI assistant is temporarily unavailable" }, { status: 503 });
  }
}
