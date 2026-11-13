import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appUrl = process.env.DEMO_URL ?? "http://localhost";
const outputDirectory = resolve(process.cwd(), "../demo-artifacts");
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "DEMO তৈরি / খুলুন" }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll(".page-stack .paper-page").length >= 3 &&
    document.querySelectorAll(".page-stack .paper-question").length >= 22,
  );
  await page.evaluate(() => document.fonts.ready);

  const contentChecks = await page.evaluate(() => ({
    questions: document.querySelectorAll(".page-stack .paper-question").length,
    cqParts: document.querySelectorAll(".page-stack .paper-subquestion").length,
    equations: document.querySelectorAll(".page-stack math-field").length,
    tables: document.querySelectorAll(".page-stack .paper-table").length,
    diagrams: document.querySelectorAll(".page-stack .biology-diagram").length,
    pages: document.querySelectorAll(".page-stack .paper-page").length,
  }));
  if (contentChecks.questions < 22 || contentChecks.cqParts < 28 || contentChecks.equations < 6 || contentChecks.tables !== 1 || contentChecks.diagrams !== 1 || contentChecks.pages < 3) {
    throw new Error(`DEMO content check failed: ${JSON.stringify(contentChecks)}`);
  }
  if (await page.locator(".page-stack .paper-answer").count() !== 0) {
    throw new Error("Question-paper output unexpectedly contains answer-key content");
  }

  await page.emulateMedia({ media: "print" });
  const questionPath = resolve(outputDirectory, "DEMO-question-paper.pdf");
  const questionPdf = await page.pdf({ path: questionPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  await page.emulateMedia({ media: "screen" });

  await page.locator("#answer-key").check();
  await page.evaluate(() => document.fonts.ready);
  const answerCount = await page.locator(".page-stack .paper-answer").count();
  if (answerCount !== contentChecks.questions) {
    throw new Error(`Answer-key output contains ${answerCount} of ${contentChecks.questions} answers`);
  }
  await page.emulateMedia({ media: "print" });
  const answerPath = resolve(outputDirectory, "DEMO-answer-key.pdf");
  const answerPdf = await page.pdf({ path: answerPath, format: "A4", printBackground: true, preferCSSPageSize: true });

  const questionBytes = await readFile(questionPath);
  const answerBytes = await readFile(answerPath);
  const pageCount = (bytes) => (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
  const summary = {
    ...contentChecks,
    questionPdfBytes: questionPdf.length,
    questionPdfPages: pageCount(questionBytes),
    answerPdfBytes: answerPdf.length,
    answerPdfPages: pageCount(answerBytes),
    bengaliFontEmbedded: questionBytes.includes(Buffer.from("Noto")) && answerBytes.includes(Buffer.from("Noto")),
    questionPdf: questionPath,
    answerPdf: answerPath,
  };
  if (summary.questionPdfPages < 3 || summary.answerPdfPages < 3 || !summary.bengaliFontEmbedded) {
    throw new Error(`PDF output check failed: ${JSON.stringify(summary)}`);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}