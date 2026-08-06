import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { createDocumentDocx } from "../lib/docx.ts";
import { parseDocxBytes } from "../lib/docx-server.ts";

test("DOCX export and import preserve paragraph order, text, and basic styles", async () => {
  const source = [
    { id: "title", kind: "title" as const, text: "Master Services Agreement" },
    { id: "heading", kind: "heading" as const, text: "1. Services" },
    { id: "body", kind: "body" as const, text: "The provider will perform the services described in each statement of work." },
  ];
  const blob = createDocumentDocx("Agreement", 3, source);
  const parsed = parseDocxBytes(await blob.arrayBuffer());
  assert.deepEqual(parsed, source.map(({ kind, text }) => ({ kind, text })));
});

test("DOCX parser rejects invalid packages and macro-enabled documents", () => {
  assert.throws(() => parseDocxBytes(new TextEncoder().encode("not a zip").buffer), /valid DOCX package/);
  const macroPackage = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>"),
    "word/vbaProject.bin": new Uint8Array([1, 2, 3]),
  });
  assert.throws(() => parseDocxBytes(macroPackage.buffer as ArrayBuffer), /Macro-enabled/);
});
