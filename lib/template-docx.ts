import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function paragraphText(paragraph: string) {
  return [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join("");
}

function replaceParagraphText(paragraph: string, transform: (value: string) => string) {
  const text = paragraphText(paragraph);
  const next = transform(text);
  if (next === text) return paragraph;
  let written = false;
  return paragraph.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (_match, open: string, _value: string, close: string) => {
    if (written) return `${open}${close}`;
    written = true;
    return `${open}${next}${close}`;
  });
}

function clauseParagraph(text: string, bold = false) {
  return `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

export function discoverTemplateFields(bytes: ArrayBuffer) {
  const archive = unzipSync(new Uint8Array(bytes));
  const source = archive["word/document.xml"];
  if (!source) throw new Error("The template is missing its Word document content");
  const documentText = [...strFromU8(source).matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join("");
  const fields = [...documentText.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map((match) => match[1]).filter((key) => key !== "optional_clauses");
  return [...new Set(fields)].map((key) => ({ key, label: key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), required: true }));
}

export function fillTemplateDocx(bytes: ArrayBuffer, values: Record<string, string>, clauses: Array<{ heading: string; body: string }>) {
  const archive = unzipSync(new Uint8Array(bytes));
  const source = archive["word/document.xml"];
  if (!source) throw new Error("The template is missing its Word document content");
  let documentXml = strFromU8(source);
  documentXml = documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!/\{\{\s*optional_clauses\s*\}\}/.test(paragraphText(paragraph))) return paragraph;
    if (!clauses.length) return replaceParagraphText(paragraph, (text) => text.replace(/\{\{\s*optional_clauses\s*\}\}/g, ""));
    return clauses.map((clause) => `${clauseParagraph(clause.heading, true)}${clauseParagraph(clause.body)}`).join("");
  });
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g");
    documentXml = documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => replaceParagraphText(paragraph, (text) => text.replace(pattern, xml(value))));
  }
  archive["word/document.xml"] = strToU8(documentXml);
  return zipSync(archive, { level: 6 });
}
