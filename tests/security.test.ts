import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, randomToken, sha256Hex, temporaryPassword, verifyPassword } from "../lib/security.ts";

test("password hashes are salted, slow, and verifiable", async () => {
  const password = "Correct-Horse-7!Battery";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("incorrect-password", first), false);
  assert.equal(await verifyPassword(password, first.replace("100000", "1000")), false);
});

test("temporary credentials and session tokens have sufficient entropy", () => {
  const passwords = new Set(Array.from({ length: 100 }, () => temporaryPassword()));
  const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
  assert.equal(passwords.size, 100);
  assert.equal(tokens.size, 100);
  for (const password of passwords) assert.equal(password.length, 20);
  for (const token of tokens) assert.ok(token.length >= 42);
});

test("hash helper produces stable SHA-256 output", async () => {
  assert.equal(await sha256Hex("pactline"), "14fbfa4d00b4cb6015823337d431f4a5d1c3eb54a586ee7af87c9cccda902448");
});

test("weak passwords are rejected", async () => {
  await assert.rejects(() => hashPassword("too-short"), /between 12 and 256/);
});
