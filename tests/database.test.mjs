import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../drizzle/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  return database;
}

test("all migrations apply cleanly and match the active paragraph model", async () => {
  const database = await migratedDatabase();
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
  for (const required of ["app_settings", "document_blocks", "paragraph_proposals", "access_sessions", "mutation_guards"]) assert.ok(tables.includes(required), required);
  assert.ok(!tables.includes("clauses"));
  assert.ok(!tables.includes("proposed_changes"));
  const proposalColumns = database.prepare("PRAGMA table_info(paragraph_proposals)").all().map((row) => row.name);
  assert.ok(proposalColumns.includes("counter_text"));
  database.close();
});

test("mutation guard aborts stale writes before related statements can commit", async () => {
  const database = await migratedDatabase();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO users (id,email,display_name,external_identity_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("owner", "owner@example.test", "Owner", "owner", now, now);
  database.prepare("INSERT INTO contracts (id,title,initiator_id,approver_id,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("contract", "Agreement", "owner", "owner", "negotiating", 2, now, now);
  database.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("block", "contract", "paragraph-1", 0, "body", "Current text", "hash", now, now);

  database.exec("BEGIN");
  try {
    database.prepare("INSERT INTO mutation_guards (id,satisfied) VALUES (?,CASE WHEN (EXISTS (SELECT 1 FROM contracts c JOIN document_blocks b ON b.contract_id=c.id WHERE c.id=? AND c.current_version=? AND b.id=? AND b.current_text=?)) THEN 1 ELSE 0 END)").run("guard-ok", "contract", 2, "block", "Current text");
    database.prepare("UPDATE document_blocks SET current_text='Updated text' WHERE id='block'").run();
    database.prepare("DELETE FROM mutation_guards WHERE id='guard-ok'").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  assert.equal(database.prepare("SELECT current_text FROM document_blocks WHERE id='block'").get().current_text, "Updated text");

  assert.throws(() => {
    database.exec("BEGIN");
    try {
      database.prepare("INSERT INTO mutation_guards (id,satisfied) VALUES (?,CASE WHEN (EXISTS (SELECT 1 FROM contracts c JOIN document_blocks b ON b.contract_id=c.id WHERE c.id=? AND c.current_version=? AND b.id=? AND b.current_text=?)) THEN 1 ELSE 0 END)").run("guard-stale", "contract", 1, "block", "Current text");
      database.prepare("UPDATE document_blocks SET current_text='Should not commit' WHERE id='block'").run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }, /CHECK constraint failed/);
  assert.equal(database.prepare("SELECT current_text FROM document_blocks WHERE id='block'").get().current_text, "Updated text");
  database.close();
});

test("accepting one paragraph rebases unaffected proposals and supersedes same-paragraph siblings", async () => {
  const database = await migratedDatabase();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO users (id,email,display_name,external_identity_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("owner", "owner@example.test", "Owner", "owner", now, now);
  database.prepare("INSERT INTO contracts (id,title,initiator_id,approver_id,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("contract", "Agreement", "owner", "owner", "negotiating", 1, now, now);
  database.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("client-party", "contract", "counterparty", "Reviewer", "Client", "reviewer@example.test", now, now);
  database.prepare("INSERT INTO access_accounts (id,contract_id,party_id,username,password_hash,permission,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("reviewer", "contract", "client-party", "reviewer", "hash", "propose_changes", "active", "2099-01-01T00:00:00.000Z", now, now);
  const addBlock = database.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  addBlock.run("block-a", "contract", "a", 0, "body", "Alpha", "hash-a", now, now);
  addBlock.run("block-b", "contract", "b", 1, "body", "Beta", "hash-b", now, now);
  const addProposal = database.prepare("INSERT INTO paragraph_proposals (id,contract_id,block_id,base_version,proposed_by_account_id,original_text,proposed_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  addProposal.run("accepted", "contract", "block-a", 1, "reviewer", "Alpha", "Alpha revised", "pending", now, now);
  addProposal.run("same-block", "contract", "block-a", 1, "reviewer", "Alpha", "Alpha alternative", "pending", now, now);
  addProposal.run("unaffected", "contract", "block-b", 1, "reviewer", "Beta", "Beta revised", "pending", now, now);

  database.exec("BEGIN");
  database.prepare("UPDATE paragraph_proposals SET status='accepted' WHERE id='accepted' AND status='pending'").run();
  database.prepare("UPDATE document_blocks SET current_text='Alpha revised' WHERE id='block-a' AND current_text='Alpha'").run();
  database.prepare("UPDATE contracts SET current_version=2 WHERE id='contract' AND current_version=1").run();
  database.prepare("UPDATE paragraph_proposals SET status='superseded', resolved_at=?, resolved_by=?, updated_at=? WHERE contract_id=? AND block_id=? AND id<>? AND status='pending'").run(now, "owner", now, "contract", "block-a", "accepted");
  database.prepare("UPDATE paragraph_proposals SET base_version=?, updated_at=? WHERE contract_id=? AND status='pending' AND EXISTS (SELECT 1 FROM document_blocks b WHERE b.id=paragraph_proposals.block_id AND b.current_text=paragraph_proposals.original_text)").run(2, now, "contract");
  database.exec("COMMIT");

  const sameBlock = database.prepare("SELECT status,base_version FROM paragraph_proposals WHERE id='same-block'").get();
  const unaffected = database.prepare("SELECT status,base_version FROM paragraph_proposals WHERE id='unaffected'").get();
  assert.equal(sameBlock.status, "superseded");
  assert.equal(sameBlock.base_version, 1);
  assert.equal(unaffected.status, "pending");
  assert.equal(unaffected.base_version, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paragraph_proposals p JOIN document_blocks b ON b.id=p.block_id WHERE p.id='unaffected' AND p.status='pending' AND b.current_text=p.original_text").get().count, 1);
  database.close();
});

test("deployment workflow isolates staging from production", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8");
  assert.match(workflow, /environment:.*production.*staging/);
  assert.match(workflow, /pactline-contracts-staging/);
  assert.match(workflow, /pactline-documents-staging/);
  assert.match(workflow, /pactline-contract-collaboration-staging/);
  assert.match(workflow, /ON CONFLICT\(key\) DO NOTHING/);
  assert.match(workflow, /secret put GROQ_API_KEY --name "\$CLOUDFLARE_WORKER_NAME"/);
  assert.match(workflow, /reviewer-cookies\.txt/);
  assert.match(workflow, /paragraph-proposals\/\$PROPOSAL_ID_1\/resolve/);
  assert.match(workflow, /paragraph-proposals\/\$PROPOSAL_ID_2\/resolve/);
  assert.match(workflow, /assert_reviewer_forbidden/);
  assert.match(workflow, /result\.versionNumber !== 2/);
});
