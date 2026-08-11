import { env } from "cloudflare:workers";

type EmbeddingResponse = { data?: number[][]; shape?: number[] };
type AiBinding = { run(model: string, input: { text: string[] }): Promise<EmbeddingResponse> };
type VectorMatch = { id: string; score: number };
type VectorBinding = {
  upsert(vectors: Array<{ id: string; namespace: string; values: number[]; metadata: Record<string, string> }>): Promise<unknown>;
  query(vector: number[], options: { topK: number; namespace: string; returnMetadata: boolean }): Promise<{ matches: VectorMatch[] }>;
};
type SearchEnvironment = { AI?: AiBinding; VECTORIZE?: VectorBinding };

function bindings() { return env as unknown as SearchEnvironment; }

async function embed(text: string[]) {
  const ai = bindings().AI; if (!ai) return null;
  const result = await ai.run("@cf/baai/bge-small-en-v1.5", { text });
  return result.data?.length === text.length ? result.data : null;
}

export async function indexPendingSearchChunks(organizationId: string, documentId: string) {
  const vectorize = bindings().VECTORIZE; if (!vectorize) return { indexed: 0, available: false };
  const rows = await env.DB.prepare("SELECT id,content,document_version FROM search_chunks WHERE organization_id=? AND document_id=? AND index_status='pending' ORDER BY created_at LIMIT 100").bind(organizationId, documentId).all<{ id: string; content: string; document_version: number }>();
  if (!rows.results.length) return { indexed: 0, available: true };
  const vectors = await embed(rows.results.map((row) => row.content)); if (!vectors) return { indexed: 0, available: false };
  await vectorize.upsert(rows.results.map((row, index) => ({ id: row.id, namespace: organizationId, values: vectors[index], metadata: { organizationId, documentId, version: String(row.document_version) } })));
  await env.DB.batch(rows.results.map((row) => env.DB.prepare("UPDATE search_chunks SET vector_id=?,index_status='indexed',updated_at=? WHERE id=? AND organization_id=?").bind(row.id, new Date().toISOString(), row.id, organizationId)));
  return { indexed: rows.results.length, available: true };
}

export async function reindexPendingSearchChunks(organizationId: string) {
  const vectorize = bindings().VECTORIZE;
  const ai = bindings().AI;
  const pendingBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE organization_id=? AND index_status='pending'").bind(organizationId).first<{ count: number }>();
  if (!vectorize || !ai) return { available: false, indexed: 0, pending: Number(pendingBefore?.count ?? 0) };

  let indexed = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const documents = await env.DB.prepare("SELECT DISTINCT document_id FROM search_chunks WHERE organization_id=? AND index_status='pending' ORDER BY document_id LIMIT 25").bind(organizationId).all<{ document_id: string }>();
    if (!documents.results.length) break;
    let passIndexed = 0;
    for (const document of documents.results) {
      const result = await indexPendingSearchChunks(organizationId, document.document_id);
      indexed += result.indexed;
      passIndexed += result.indexed;
    }
    if (!passIndexed) break;
  }

  const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE organization_id=? AND index_status='pending'").bind(organizationId).first<{ count: number }>();
  return { available: true, indexed, pending: Number(remaining?.count ?? 0) };
}

function keywordTerms(query: string) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9$%]+/g) ?? [])].filter((term) => term.length > 2).slice(0, 8);
}

export async function searchKnowledgeBase(organizationId: string, query: string) {
  const vectorize = bindings().VECTORIZE; const queryEmbedding = vectorize ? await embed([query]) : null;
  let orderedIds: string[] = [];
  if (vectorize && queryEmbedding?.[0]) {
    try { orderedIds = (await vectorize.query(queryEmbedding[0], { topK: 12, namespace: organizationId, returnMetadata: false })).matches.map((match) => match.id); } catch { orderedIds = []; }
  }
  if (orderedIds.length) {
    const rows = await env.DB.prepare(`SELECT s.id,s.content,s.document_version,s.clause_id,d.id AS document_id,d.title,d.category,d.status,d.expiration_date FROM search_chunks s JOIN vault_documents d ON d.id=s.document_id WHERE s.organization_id=? AND s.id IN (${orderedIds.map(() => "?").join(",")}) AND s.index_status='indexed' AND d.status!='archived'`).bind(organizationId, ...orderedIds).all<Record<string, unknown>>();
    const byId = new Map(rows.results.map((row) => [String(row.id), row]));
    return { mode: "semantic", results: orderedIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []) };
  }
  const terms = keywordTerms(query); if (!terms.length) return { mode: "keyword", results: [] };
  const where = terms.map(() => "lower(s.content) LIKE ?").join(" OR ");
  const rows = await env.DB.prepare(`SELECT s.id,s.content,s.document_version,s.clause_id,d.id AS document_id,d.title,d.category,d.status,d.expiration_date FROM search_chunks s JOIN vault_documents d ON d.id=s.document_id WHERE s.organization_id=? AND s.index_status IN ('pending','indexed') AND d.status!='archived' AND (${where}) ORDER BY d.updated_at DESC LIMIT 20`).bind(organizationId, ...terms.map((term) => `%${term}%`)).all();
  return { mode: "keyword", results: rows.results };
}
