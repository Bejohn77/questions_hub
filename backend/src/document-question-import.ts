import { randomUUID } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { posix } from "node:path";
import JSZip from "jszip";
import { PNG } from "pngjs";

export type QuestionKind = "MCQ" | "CQ";
export type ImportLine = { text: string; page: number; y?: number; x?: number };
export type ImportedImage = { token: string; filename: string; mimeType: string; data: Buffer };
export type ExtractedDraft = {
  id: string;
  type: QuestionKind;
  marks: number;
  topic: string;
  sourceNumber: string;
  content: { text: string; options?: string[]; subs?: string[]; answer?: string };
  imageTokens: string[];
  sourcePages: number[];
  uncertain: boolean;
  uncertainty: string[];
};
export type ParsedDocument = { lines: ImportLine[]; images: ImportedImage[] };

const imageTokenPattern = /\[\[IMPORT_IMAGE_(\d+)\]\]/gu;
const maximumImagePixels = 20_000_000;
const maximumExtractedImageBytes = 50 * 1024 * 1024;

type XmlNode = {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: ArrayLike<XmlNode>;
};
type XmlElement = XmlNode & { getAttribute(name: string): string | null };

function failure(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

function localName(node: XmlNode) {
  return node.localName ?? node.nodeName.split(":").pop() ?? node.nodeName;
}

function childElements(node: XmlNode) {
  return Array.from(node.childNodes).filter((child) => child.nodeType === 1);
}

function getAttribute(node: XmlElement, name: string) {
  const direct = node.getAttribute(name);
  if (direct) return direct;
  const attributes = (node as XmlElement & { attributes?: ArrayLike<{ name: string; localName?: string | null; value: string }> }).attributes;
  if (!attributes) return null;
  for (const attribute of Array.from(attributes)) {
    if ((attribute.localName ?? attribute.name.split(":").pop()) === name) return attribute.value;
  }
  return null;
}

function findElements(node: XmlNode, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (current: XmlNode) => {
    if (current.nodeType === 1 && localName(current) === name) found.push(current as XmlElement);
    for (const child of childElements(current)) visit(child);
  };
  visit(node);
  return found;
}

function imageMimeType(data: Buffer, filename: string) {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (data.toString("ascii", 0, 4) === "II*\0" || data.toString("ascii", 0, 4) === "MM\0*") return "image/tiff";
  if (/\.svg$/iu.test(filename) || /^\s*<svg[\s>]/iu.test(data.toString("utf8", 0, 512))) return "image/svg+xml";
  return null;
}

function safeFilename(filename: string, fallback: string) {
  return filename.split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255) || fallback;
}

function parseXml(xml: string) {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => { if (level !== "warning") errors.push(message); },
  }).parseFromString(xml, "application/xml");
  if (errors.length || document.getElementsByTagName("parsererror").length) {
    throw failure("The DOCX document contains invalid XML.");
  }
  return document as unknown as XmlNode & { getElementsByTagName(name: string): ArrayLike<XmlNode> };
}

export async function extractDocx(data: Buffer): Promise<ParsedDocument> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { createFolders: false });
  } catch {
    throw failure("The DOCX file could not be opened. Check that it is not damaged or password-protected.");
  }

  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw failure("The DOCX file does not contain a readable Word document.");
  const relationshipEntry = zip.file("word/_rels/document.xml.rels");
  const [documentXml, relationshipsXml] = await Promise.all([
    documentEntry.async("string"),
    relationshipEntry?.async("string") ?? Promise.resolve(""),
  ]);
  const document = parseXml(documentXml);
  const relationships = relationshipsXml ? parseXml(relationshipsXml) : null;
  const targets = new Map<string, string>();
  for (const relation of relationships ? findElements(relationships, "Relationship") : []) {
    const id = getAttribute(relation, "Id");
    const target = getAttribute(relation, "Target");
    if (id && target && getAttribute(relation, "TargetMode") !== "External") targets.set(id, target);
  }

  const lines: ImportLine[] = [];
  const images: ImportedImage[] = [];
  const body = findElements(document, "body")[0];
  if (!body) throw failure("The DOCX file does not contain a readable document body.");
  const paragraphs = findElements(body, "p");

  async function addImage(relationId: string) {
    const target = targets.get(relationId);
    if (!target) return "";
    const entryPath = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("word", target));
    if (entryPath.startsWith("../") || entryPath.includes("/../")) return "";
    const entry = zip.file(entryPath);
    if (!entry || entry.dir) return "";
    const bytes = await entry.async("nodebuffer");
    if (bytes.length > maximumExtractedImageBytes
      || images.reduce((total, image) => total + image.data.length, 0) + bytes.length > maximumExtractedImageBytes) {
      throw failure("The extracted images exceed the 50 MB storage limit. Reduce the source document size and try again.", 413);
    }
    const filename = safeFilename(target, `document-image-${images.length + 1}`);
    const mimeType = imageMimeType(bytes, filename);
    if (!mimeType) throw failure(`The DOCX contains an unsupported embedded image format (${filename}).`, 415);
    const index = images.length;
    images.push({ token: `[[IMPORT_IMAGE_${index}]]`, filename, mimeType, data: bytes });
    return ` ${images[index].token} `;
  }

  for (const paragraph of paragraphs) {
    const fragments: string[] = [];
    const visit = async (node: XmlNode): Promise<void> => {
      if (node.nodeType === 3) {
        fragments.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const name = localName(node);
      if (name === "t") {
        fragments.push(node.textContent ?? "");
        return;
      }
      if (name === "tab") {
        fragments.push("\t");
        return;
      }
      if (name === "br" || name === "cr") {
        fragments.push("\n");
        return;
      }
      if (name === "drawing" || name === "pict") {
        const references = findElements(node, "blip")
          .map((item) => getAttribute(item, "embed"))
          .concat(findElements(node, "imagedata").map((item) => getAttribute(item, "id")))
          .filter((id): id is string => Boolean(id));
        const preferred = references.find((id) => /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/iu.test(targets.get(id) ?? ""))
          ?? references.find((id) => /\.svg$/iu.test(targets.get(id) ?? ""));
        if (references.length && !preferred) {
          throw failure("The DOCX contains an embedded image format that cannot be previewed safely.", 415);
        }
        if (preferred) fragments.push(await addImage(preferred));
        return;
      }
      for (const child of childElements(node)) await visit(child);
    };
    for (const child of childElements(paragraph)) await visit(child);
    const text = fragments.join("").replace(/\s+/gu, " ").trim();
    if (text) lines.push({ text, page: 1 });
  }

  return { lines, images };
}

function multiplyMatrices(left: number[], right: number[]) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function rgbaImage(image: {
  width: number;
  height: number;
  data: Uint8Array;
  kind?: number;
  bitmap?: unknown;
}, imageKind: { GRAYSCALE_1BPP: number; RGB_24BPP: number; RGBA_32BPP: number }) {
  const { width, height, data, kind } = image;
  const pixelCount = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || pixelCount > maximumImagePixels) {
    throw failure("A PDF image is too large to safely preview. Reduce the image size and try again.", 413);
  }
  const rgba = Buffer.allocUnsafe(pixelCount * 4);
  if (kind === imageKind.RGBA_32BPP || data.length === pixelCount * 4) {
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(rgba, 0, 0, rgba.length);
    return { width, height, data: rgba };
  }
  if (kind === imageKind.RGB_24BPP && data.length >= pixelCount * 3) {
    for (let source = 0, target = 0; target < rgba.length; source += 3, target += 4) {
      rgba[target] = data[source];
      rgba[target + 1] = data[source + 1];
      rgba[target + 2] = data[source + 2];
      rgba[target + 3] = 255;
    }
    return { width, height, data: rgba };
  }
  if (kind === imageKind.GRAYSCALE_1BPP && data.length >= Math.ceil(width / 8) * height) {
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const bit = (data[Math.floor(pixel / width) * Math.ceil(width / 8) + Math.floor((pixel % width) / 8)]
        >> (7 - (pixel % 8))) & 1;
      const shade = bit ? 0 : 255;
      const target = pixel * 4;
      rgba[target] = shade;
      rgba[target + 1] = shade;
      rgba[target + 2] = shade;
      rgba[target + 3] = 255;
    }
    return { width, height, data: rgba };
  }
  throw failure("A PDF contains an image format that cannot be safely previewed.");
}

export async function extractPdf(data: Buffer): Promise<ParsedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let document;
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(data),
    useSystemFonts: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    useWasm: false,
    verbosity: 0,
  });
  try {
    document = await loadingTask.promise;
  } catch {
    throw failure("PDF could not be opened. Check that it is not damaged or password-protected.");
  }

  const imageKind = pdfjs.ImageKind;
  const extracted: Array<{ line: ImportLine; order: number }> = [];
  const images: ImportedImage[] = [];
  let extractedImageBytes = 0;
  let order = 0;
  try {
    if (document.numPages > 200) throw failure("PDFs can contain at most 200 pages.", 413);
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [textContent, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      const pageHeight = page.view[3] - page.view[1];
      const textRows: Array<{ y: number; x: number; endX: number; fontSize: number; text: string }> = [];
      for (const item of textContent.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const row = textRows.find((candidate) =>
          Math.abs(candidate.y - y) < 2 && x - candidate.endX < 22 && x - candidate.x > -22);
        if (!row) {
          textRows.push({ y, x, endX: x + item.width, fontSize: Math.abs(item.transform[0]) || 10, text: item.str });
        } else {
          const gap = x - row.endX;
          row.text += `${gap > Math.max(1.5, row.fontSize * 0.2) ? " " : ""}${item.str}`;
          row.endX = Math.max(row.endX, x + item.width);
        }
      }
      for (const row of textRows) {
        extracted.push({
          line: { text: row.text.trim(), page: pageNumber, y: pageHeight - row.y, x: row.x },
          order: order++,
        });
      }

      let matrix = [1, 0, 0, 1, 0, 0];
      const matrixStack: number[][] = [];
      for (let index = 0; index < operators.fnArray.length; index += 1) {
        const operation = operators.fnArray[index];
        const args = operators.argsArray[index] as unknown[];
        if (operation === pdfjs.OPS.save) {
          matrixStack.push([...matrix]);
          continue;
        }
        if (operation === pdfjs.OPS.restore) {
          matrix = matrixStack.pop() ?? matrix;
          continue;
        }
        if (operation === pdfjs.OPS.transform && Array.isArray(args[0])) {
          matrix = multiplyMatrices(matrix, args[0] as number[]);
          continue;
        }
        const isExternalImage = operation === pdfjs.OPS.paintImageXObject
          || operation === pdfjs.OPS.paintImageXObjectRepeat;
        const isInlineImage = operation === pdfjs.OPS.paintInlineImageXObject;
        if (!isExternalImage && !isInlineImage) continue;
        const imageObject = isExternalImage && typeof args[0] === "string"
          ? await new Promise<unknown>((resolve, reject) => {
            page.objs.get(args[0] as string, resolve, reject);
          })
          : args[0];
        if (!imageObject || typeof imageObject !== "object" || !("data" in imageObject)) continue;
        const rawImage = imageObject as { width: number; height: number; data: Uint8Array; kind?: number };
        const imageData = rgbaImage(rawImage, imageKind);
        const pngImage = new PNG({ width: imageData.width, height: imageData.height });
        Buffer.from(imageData.data).copy(pngImage.data);
        const png = PNG.sync.write(pngImage);
        extractedImageBytes += png.length;
        if (extractedImageBytes > maximumExtractedImageBytes) {
          throw failure("The extracted images exceed the 50 MB storage limit. Reduce the source document size and try again.", 413);
        }
        const positions = operation === pdfjs.OPS.paintImageXObjectRepeat && Array.isArray(args[3])
          ? args[3] as number[]
          : [matrix[4], matrix[5]];
        for (let position = 0; position < positions.length; position += 2) {
          const imageIndex = images.length;
          const token = `[[IMPORT_IMAGE_${imageIndex}]]`;
          const x = positions[position] ?? matrix[4];
          const y = positions[position + 1] ?? matrix[5];
          images.push({
            token,
            filename: `pdf-page-${pageNumber}-image-${imageIndex + 1}.png`,
            mimeType: "image/png",
            data: png,
          });
          extracted.push({ line: { text: token, page: pageNumber, y: pageHeight - (y + matrix[3]), x }, order: order++ });
        }
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  extracted.sort((left, right) =>
    left.line.page - right.line.page
    || (left.line.y ?? 0) - (right.line.y ?? 0)
    || (left.line.x ?? 0) - (right.line.x ?? 0)
    || left.order - right.order);
  const lines = extracted.map(({ line }) => line);
  if (!lines.some(({ text }) => text.replace(imageTokenPattern, "").trim())) {
    throw failure("This PDF has no selectable text and appears to be scanned or image-only. OCR is not used; upload a text-based PDF or DOCX.", 422);
  }
  return { lines, images };
}

function questionStarts(lines: string[]) {
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:\(?[০-৯0-9]{1,4}\s*[.)।]|(?:প্রশ্ন\s*)?[০-৯0-9]{1,4}\s*[-:])\s*(?=\S)/u.test(line)) {
      starts.push(index);
    }
  }
  return starts;
}

function splitLabeledParts(lines: string[]) {
  const starts: { index: number; label: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*[\(（]?([\u0995-\u0998]|[a-dA-D])[\)）.।:]\s*/u);
    if (match) starts.push({ index, label: match[1] });
  }
  return starts;
}

function extractParts(lines: string[], starts: { index: number; label: string }[]) {
  return starts.map(({ index }, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    return lines.slice(index, end).join("\n")
      .replace(/^\s*[\(（]?(?:[\u0995-\u0998]|[a-dA-D])[\)）.।:]\s*/u, "").trim();
  });
}

function extractMarks(text: string) {
  const match = text.match(/(?:\(([০-৯0-9]{1,4})\)|([০-৯0-9]{1,4})\s*(?:নম্বর|marks?))/iu);
  const value = match?.[1] ?? match?.[2];
  return value ? Number(value.replace(/[০-৯]/gu, (digit) => String(digit.charCodeAt(0) - 0x09e6))) : 0;
}

function isMarksLine(line: string) {
  return /^\s*(?:\([০-৯0-9]{1,4}\)|[০-৯0-9]{1,4}\s*(?:নম্বর|marks?))\s*$/iu.test(line);
}

export function parseQuestionText(lines: ImportLine[], type: QuestionKind, defaultTopic = ""): ExtractedDraft[] {
  const normalizedLines = lines.flatMap((line) => line.text.split(/\r?\n/u)
    .map((text) => ({ ...line, text: text.trim() }))
    .filter(({ text }) => Boolean(text)));
  if (!normalizedLines.length) return [];
  const starts = questionStarts(normalizedLines.map(({ text }) => text));
  const boundaries = starts.length ? starts : [0];
  return boundaries.map((start, index) => {
    const end = boundaries[index + 1] ?? normalizedLines.length;
    const leadingImages = index === 0 && starts.length
      ? normalizedLines.slice(0, starts[0]).filter(({ text }) => /\[\[IMPORT_IMAGE_\d+\]\]/u.test(text))
      : [];
    const chunk = [...leadingImages, ...normalizedLines.slice(start, end)];
    const rawText = chunk.map(({ text }) => text).join("\n").trim();
    const sourceNumber = rawText.match(/^\s*(?:\(?([০-৯0-9]{1,4})\s*[.)।]|(?:প্রশ্ন\s*)?([০-৯0-9]{1,4})\s*[-:])/u);
    const imageTokens = [...new Set([...rawText.matchAll(imageTokenPattern)].map((match) => `[[IMPORT_IMAGE_${match[1]}]]`))];
    const chunkLines = chunk.map(({ text }, lineIndex) => lineIndex === 0
      ? text.replace(/^\s*(?:\(?[০-৯0-9]{1,4}\s*[.)।]|(?:প্রশ্ন\s*)?[০-৯0-9]{1,4}\s*[-:])\s*/u, "")
      : text).map((text) => text.replace(imageTokenPattern, "").trim()).filter(Boolean);
    const contentLines = chunkLines
      .filter((line) => !isMarksLine(line))
      .map((line) => line.replace(/\s*(?:\([০-৯0-9]{1,4}\)|[০-৯0-9]{1,4}\s*(?:নম্বর|marks?))\s*$/iu, "").trim())
      .filter(Boolean);
    const answerIndex = contentLines.findIndex((line) => /^(?:উত্তর|answer|ans\.?)\s*[:：-]/iu.test(line));
    const answer = answerIndex >= 0
      ? contentLines[answerIndex].replace(/^(?:উত্তর|answer|ans\.?)\s*[:：-]\s*/iu, "").trim()
      : undefined;
    if (answerIndex >= 0) contentLines.splice(answerIndex, 1);
    const labeled = splitLabeledParts(contentLines);
    const uncertainty: string[] = [];
    if (!starts.length) uncertainty.push("প্রশ্নের আলাদা নম্বর শনাক্ত হয়নি; সম্পূর্ণ লেখাটি একসঙ্গে রাখা হয়েছে।");
    if (!extractMarks(rawText)) uncertainty.push("নম্বর শনাক্ত হয়নি; সংরক্ষণের আগে নম্বর লিখুন।");

    if (type === "MCQ") {
      const optionStarts = labeled.length >= 2 ? labeled : [];
      const textLines = optionStarts.length ? contentLines.slice(0, optionStarts[0].index) : contentLines;
      if (optionStarts.length < 2) uncertainty.push("MCQ option নির্ভরযোগ্যভাবে শনাক্ত হয়নি; প্রিভিউতে যোগ বা সংশোধন করুন।");
      return {
        id: randomUUID(),
        type,
        marks: extractMarks(rawText),
        topic: defaultTopic,
        sourceNumber: sourceNumber?.[1] ?? sourceNumber?.[2] ?? String(index + 1),
        content: {
          text: textLines.join("\n").trim(),
          ...(optionStarts.length ? { options: extractParts(contentLines, optionStarts) } : { options: [] }),
          ...(answer ? { answer } : {}),
        },
        imageTokens,
        sourcePages: [...new Set(chunk.map(({ page }) => page))],
        uncertain: uncertainty.length > 0,
        uncertainty,
      };
    }

    if (labeled.length < 1) uncertainty.push("CQ উপপ্রশ্ন নির্ভরযোগ্যভাবে শনাক্ত হয়নি; প্রিভিউতে লিখুন।");
    const content = {
      text: contentLines.slice(0, labeled[0]?.index ?? contentLines.length).join("\n").trim(),
      subs: labeled.length ? extractParts(contentLines, labeled).slice(0, 4) : [],
      ...(answer ? { answer } : {}),
    };
    return {
      id: randomUUID(),
      type,
      marks: extractMarks(rawText),
      topic: defaultTopic,
      sourceNumber: sourceNumber?.[1] ?? sourceNumber?.[2] ?? String(index + 1),
      content,
      imageTokens,
      sourcePages: [...new Set(chunk.map(({ page }) => page))],
      uncertain: uncertainty.length > 0,
      uncertainty,
    };
  });
}
