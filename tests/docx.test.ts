import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createDocumentDocx } from "../lib/docx.ts";
import { parseDocxBytes } from "../lib/docx-server.ts";
import { discoverTemplateFields, fillTemplateDocx } from "../lib/template-docx.ts";

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

test("template generation detects split Word placeholders and renders optional clauses", async () => {
  const template = createDocumentDocx("Template", 1, [
    { id: "intro", kind: "body", text: "Agreement between {{customer_name}} and {{supplier_name}}." },
    { id: "clauses", kind: "body", text: "{{optional_clauses}}" },
  ]);
  const archive = unzipSync(new Uint8Array(await template.arrayBuffer()));
  const originalXml = strFromU8(archive["word/document.xml"]);
  archive["word/document.xml"] = strToU8(originalXml.replace("{{supplier_name}}", "{{supplier</w:t></w:r><w:r><w:t>_name}}"));
  const splitTemplate = zipSync(archive);
  const buffer = splitTemplate.buffer.slice(splitTemplate.byteOffset, splitTemplate.byteOffset + splitTemplate.byteLength) as ArrayBuffer;

  assert.deepEqual(discoverTemplateFields(buffer).map((field) => field.key), ["customer_name", "supplier_name"]);
  const generated = fillTemplateDocx(buffer, { customer_name: "Customer Co.", supplier_name: "Supplier LLC" }, [{ heading: "Data Security", body: "Supplier will protect Customer data." }]);
  const generatedBuffer = generated.buffer.slice(generated.byteOffset, generated.byteOffset + generated.byteLength) as ArrayBuffer;
  const parsed = parseDocxBytes(generatedBuffer).map((block) => block.text);
  assert.ok(parsed.some((text) => text.includes("Customer Co.") && text.includes("Supplier LLC")));
  assert.ok(parsed.includes("Data Security"));
  assert.ok(parsed.includes("Supplier will protect Customer data."));
  assert.ok(parsed.every((text) => !text.includes("{{")));
});
