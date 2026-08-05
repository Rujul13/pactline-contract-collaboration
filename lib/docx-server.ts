import { strFromU8, unzipSync } from "fflate";
import type { DocumentBlock } from "./docx";

const MAX_DOCX_BYTES = 15 * 1024 * 1024;

export async function sha256BufferHex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseDocxBytes(bytes: ArrayBuffer): Omit<DocumentBlock, "id">[] {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_DOCX_BYTES) {
    throw new Error("The DOCX document must be between 1 byte and 15 MB");
  }
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error("The uploaded file is not a valid DOCX package");
  }
  if (archive["word/vbaProject.bin"]) throw new Error("Macro-enabled Word documents are not accepted");
  if (!archive["[Content_Types].xml"] || !archive["word/document.xml"]) {
    throw new Error("The uploaded file is not a valid Word document");
  }

  const documentXml = strFromU8(archive["word/document.xml"]);
  const paragraphXml = documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  const blocks = paragraphXml.map((paragraph) => {
    const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXml(match[1]))
      .join("")
      .trim();
    const style = paragraph.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1]?.toLowerCase() ?? "";
    const kind: DocumentBlock["kind"] = style.includes("title")
      ? "title"
      : style.includes("heading") || /^\d+[.)]\s/.test(text)
        ? "heading"
        : "body";
    return { text, kind };
  }).filter((block) => block.text);

  if (!blocks.length) throw new Error("No editable paragraphs were found in this Word document");
  return blocks;
}
