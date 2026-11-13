import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { extractPdf, parseQuestionText } from "../src/document-question-import.ts";

function createPdf({ text = true } = {}) {
  const image = Buffer.from([255, 0, 0]);
  const pageContent = text
    ? "q 20 0 0 20 50 650 cm /Im0 Do Q\nBT /F1 18 Tf 50 700 Td (1. What is 2 + 2? \\(1\\)) Tj 0 -24 Td (a\\) Four) Tj 0 -24 Td (b\\) Five) Tj ET"
    : "q 20 0 0 20 50 650 cm /Im0 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >>${text ? " /Font << /F1 4 0 R >>" : ""} >> /Contents 6 0 R >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([
      Buffer.from("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n"),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(pageContent)} >>\nstream\n${pageContent}\nendstream`),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) chunks.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return Buffer.concat(chunks);
}

test("PDF text extraction preserves text, question structure, and embedded image pixels", async () => {
  const extracted = await extractPdf(createPdf());
  const questions = parseQuestionText(extracted.lines, "MCQ", "Arithmetic");

  assert.equal(questions.length, 1);
  assert.equal(questions[0].sourceNumber, "1");
  assert.equal(questions[0].content.text, "What is 2 + 2?");
  assert.deepEqual(questions[0].content.options, ["Four", "Five"]);
  assert.equal(questions[0].topic, "Arithmetic");
  assert.deepEqual(questions[0].imageTokens, [extracted.images[0].token]);
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.images[0].mimeType, "image/png");
  assert.deepEqual([...PNG.sync.read(extracted.images[0].data).data], [255, 0, 0, 255]);
});

test("image-only PDFs are rejected with an explicit no-OCR explanation", async () => {
  await assert.rejects(extractPdf(createPdf({ text: false })), {
    status: 422,
    message: /scanned or image-only.*OCR is not used/i,
  });
});

test("question parsing supports a 1,000-question MCQ batch and retains source numbers", () => {
  const lines = [];
  for (let index = 1; index <= 1000; index += 1) {
    lines.push(
      { text: `${index}. Question ${index}?`, page: Math.ceil(index / 10) },
      { text: "a) Option one", page: Math.ceil(index / 10) },
      { text: "b) Option two", page: Math.ceil(index / 10) },
      { text: "(1)", page: Math.ceil(index / 10) },
    );
  }
  const questions = parseQuestionText(lines, "MCQ");

  assert.equal(questions.length, 1000);
  assert.equal(questions[0].sourceNumber, "1");
  assert.equal(questions[999].sourceNumber, "1000");
  assert.deepEqual(questions[999].content.options, ["Option one", "Option two"]);
});
