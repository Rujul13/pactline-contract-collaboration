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

test("deployment workflow isolates staging from production", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8");
  assert.match(workflow, /environment:.*production.*staging/);
  assert.match(workflow, /pactline-contracts-staging/);
  assert.match(workflow, /pactline-documents-staging/);
  assert.match(workflow, /pactline-contract-collaboration-staging/);
  assert.match(workflow, /ON CONFLICT\(key\) DO NOTHING/);
  assert.match(workflow, /secret put GROQ_API_KEY --name "\$CLOUDFLARE_WORKER_NAME"/);
  assert.match(workflow, /reviewer-cookies\.txt/);
  assert.match(workflow, /paragraph-proposals\/\$PROPOSAL_ID\/resolve/);
  assert.match(workflow, /result\.versionNumber !== 2/);
});
