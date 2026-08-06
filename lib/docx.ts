import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type DocumentBlock = { id: string; text: string; kind: "title" | "heading" | "body" };

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function createDocumentDocx(title: string, version: number, blocks: DocumentBlock[]) {
  const paragraphs = blocks.map((block) => {
    const style = block.kind === "title" ? "Title" : block.kind === "heading" ? "Heading2" : "Normal";
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xml(block.text)}</w:t></w:r></w:p>`;
  }).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "word/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Pactline</dc:creator><cp:version>${version}</cp:version><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Pactline</Application></Properties>`),
  };
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export async function inspectDocx(file: File) {
  if (!file.name.toLowerCase().endsWith(".docx")) throw new Error("Choose a .docx file");
  if (file.size > 15 * 1024 * 1024) throw new Error("The DOCX file must be smaller than 15 MB");
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const documentXml = archive["word/document.xml"];
  if (!documentXml) throw new Error("This DOCX file does not contain a Word document");
  const parsed = new DOMParser().parseFromString(strFromU8(documentXml), "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("The Word document could not be parsed");
  const blocks = [...parsed.getElementsByTagName("w:p")].map((paragraph, index) => {
    const text = [...paragraph.getElementsByTagName("w:t")].map((node) => node.textContent ?? "").join("").trim();
    const style = paragraph.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val")?.toLowerCase() ?? "";
    const kind: DocumentBlock["kind"] = style.includes("title") ? "title" : style.includes("heading") || /^\d+[.)]\s/.test(text) ? "heading" : "body";
    return { id: `imported-${index + 1}`, text, kind };
  }).filter((block) => block.text);
  const paragraphs = blocks.map((block) => block.text);
  return { name: file.name, size: file.size, paragraphs, blocks, clauseCandidates: blocks.filter((block) => block.kind === "heading").length };
}
