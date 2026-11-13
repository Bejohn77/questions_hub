import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { AcademicEntryType, Prisma, QuestionType } from "@prisma/client";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "./db";
import { attachOwnedQuestionImages } from "./question-images";
import {
  extractDocx,
  extractPdf,
  parseQuestionText,
  type ImportedImage,
  type ParsedDocument,
} from "./document-question-import";
import { questionFingerprint, questionSchema } from "./routes/questions";

const maximumFiles = 5;
const maximumFileBytes = 20 * 1024 * 1024;
const maximumRequestBytes = 50 * 1024 * 1024;
const maximumQuestions = 1000;
const maximumImages = 2000;
const maximumExtractedImageBytes = 50 * 1024 * 1024;
const questionTypes = [QuestionType.MCQ, QuestionType.CQ] as const;
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maximumFileBytes, files: maximumFiles, fields: 5, fieldSize: 1024 },
  fileFilter: (_request, file, callback) => {
    const extension = basename(file.originalname).toLowerCase().split(".").pop();
    if ((extension === "pdf" && file.mimetype === "application/pdf")
      || (extension === "docx" && [docxMimeType, "application/octet-stream"].includes(file.mimetype))) {
      callback(null, true);
      return;
    }
    callback(new Error("Only text-based PDF and DOCX files are supported."));
  },
});

const parseUploadFiles: RequestHandler = (request, response, next) => {
  upload.array("files", maximumFiles)(request, response, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (!(error instanceof multer.MulterError)) {
      response.status(415).json({ error: "Only text-based PDF and DOCX files are supported." });
      return;
    }
    next(error);
  });
};

function isSupportedFile(file: Express.Multer.File) {
  const extension = basename(file.originalname).toLowerCase().split(".").pop();
  if (extension === "pdf") return file.mimetype === "application/pdf" && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === "docx") {
    return [docxMimeType, "application/octet-stream"].includes(file.mimetype)
      && file.buffer.subarray(0, 2).toString("ascii") === "PK";
  }
  return false;
}

function safeOriginalFilename(value: string) {
  return basename(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255) || "question-document";
}

const saveRequestSchema = z.object({
  type: z.enum(questionTypes),
  classLevel: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1).max(120),
  chapter: z.string().trim().min(1).max(160),
  questions: z.array(z.object({
    marks: z.number().int().min(1).max(1000),
    topic: z.string().trim().max(160).default(""),
    sourceNumber: z.string().trim().max(20).optional(),
    content: z.object({
      text: z.string().trim().min(1).max(500),
      options: z.array(z.string().max(120)).max(8).optional(),
      subs: z.array(z.string().max(90)).max(4).optional(),
      answer: z.string().max(120).optional(),
      imageUrls: z.array(z.string().max(300)).max(maximumImages).optional(),
    }),
  })).min(1).max(maximumQuestions),
});

async function ensureAcademicEntries(
  transaction: Prisma.TransactionClient,
  className: string,
  subjectName: string,
  chapterName: string,
  topics: string[],
) {
  let classEntry = await transaction.academicEntry.findFirst({
    where: { type: AcademicEntryType.CLASS, name: { equals: className, mode: "insensitive" }, parentId: null },
    select: { id: true },
  });
  if (!classEntry) {
    classEntry = await transaction.academicEntry.create({
      data: { type: AcademicEntryType.CLASS, name: className },
      select: { id: true },
    });
  }
  let subject = await transaction.academicEntry.findFirst({
    where: {
      type: AcademicEntryType.SUBJECT,
      name: { equals: subjectName, mode: "insensitive" },
      parent: { type: AcademicEntryType.GROUP, parentId: classEntry.id },
    },
    select: { id: true },
  });
  if (!subject) {
    let group = await transaction.academicEntry.findFirst({
      where: { type: AcademicEntryType.GROUP, name: { equals: "General", mode: "insensitive" }, parentId: classEntry.id },
      select: { id: true },
    });
    if (!group) {
      group = await transaction.academicEntry.create({
        data: { type: AcademicEntryType.GROUP, name: "General", parentId: classEntry.id },
        select: { id: true },
      });
    }
    subject = await transaction.academicEntry.create({
      data: { type: AcademicEntryType.SUBJECT, name: subjectName, parentId: group.id },
      select: { id: true },
    });
  }
  let chapter = await transaction.academicEntry.findFirst({
    where: { type: AcademicEntryType.CHAPTER, name: { equals: chapterName, mode: "insensitive" }, parentId: subject.id },
    select: { id: true },
  });
  if (!chapter) {
    chapter = await transaction.academicEntry.create({
      data: { type: AcademicEntryType.CHAPTER, name: chapterName, parentId: subject.id },
      select: { id: true },
    });
  }
  for (const name of topics) {
    const existing = await transaction.academicEntry.findFirst({
      where: { type: AcademicEntryType.TOPIC, name: { equals: name, mode: "insensitive" }, parentId: chapter.id },
      select: { id: true },
    });
    if (!existing) {
      await transaction.academicEntry.create({
        data: { type: AcademicEntryType.TOPIC, name, parentId: chapter.id },
        select: { id: true },
      });
    }
  }
}

function rebaseImages(document: ParsedDocument, pageOffset: number, imageOffset: number) {
  const tokenMap = new Map(document.images.map((image, index) => [
    image.token,
    `[[IMPORT_IMAGE_${imageOffset + index}]]`,
  ]));
  return {
    lines: document.lines.map((line) => ({
      ...line,
      page: line.page + pageOffset,
      text: [...tokenMap].reduce((text, [from, to]) => text.replaceAll(from, to), line.text),
    })),
    images: document.images.map((image, index) => ({
      ...image,
      token: `[[IMPORT_IMAGE_${imageOffset + index}]]`,
    })),
  };
}

export function registerAdminQuestionUploadRoutes(router: Router) {
  router.post("/upload/extract", parseUploadFiles, async (request, response) => {
    const selection = z.object({
      type: z.enum(questionTypes),
      classLevel: z.string().trim().min(1).max(60),
      subject: z.string().trim().min(1).max(120),
      chapter: z.string().trim().min(1).max(160),
      topic: z.string().trim().min(1).max(160),
    }).safeParse(request.body);
    if (!selection.success) {
      response.status(400).json({ error: "Select a question type and enter class, subject, chapter, and topic." });
      return;
    }
    const files = request.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      response.status(400).json({ error: "Upload one or more text-based PDF or DOCX files." });
      return;
    }
    if (files.some((file) => !isSupportedFile(file))) {
      response.status(415).json({ error: "Only genuine text-based PDF and DOCX files are supported." });
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > maximumRequestBytes) {
      response.status(413).json({ error: "The combined upload size cannot exceed 50 MB." });
      return;
    }

    const lines: ParsedDocument["lines"] = [];
    const images: ImportedImage[] = [];
    let pageOffset = 0;
    for (const file of files) {
      let parsed: ParsedDocument;
      try {
        parsed = file.mimetype === "application/pdf"
          ? await extractPdf(file.buffer)
          : await extractDocx(file.buffer);
      } catch (error) {
        if (error instanceof Error && "status" in error && Number(error.status) === 422) {
          response.status(422).json({ error: error.message });
          return;
        }
        throw error;
      }
      const rebased = rebaseImages(parsed, pageOffset, images.length);
      lines.push(...rebased.lines);
      images.push(...rebased.images);
      pageOffset += parsed.lines.reduce((maxPage, { page }) => Math.max(maxPage, page), 1);
    }
    const textLength = lines.reduce((total, line) => total + line.text.replace(/\[\[IMPORT_IMAGE_\d+\]\]/gu, "").trim().length, 0);
    if (!textLength) {
      response.status(422).json({ error: "No editable text was found. Scanned and image-only documents are not supported; OCR is never used." });
      return;
    }
    if (images.length > maximumImages) {
      response.status(413).json({ error: `A document can contain at most ${maximumImages} embedded images.` });
      return;
    }
    if (images.reduce((total, image) => total + image.data.length, 0) > maximumExtractedImageBytes) {
      response.status(413).json({ error: "The extracted images exceed the 50 MB storage limit. Reduce the source document size and try again." });
      return;
    }

    const questions = parseQuestionText(lines, selection.data.type, selection.data.topic);
    if (!questions.length) {
      response.status(422).json({ error: "No questions could be extracted from the document text." });
      return;
    }
    if (questions.length > maximumQuestions) {
      response.status(413).json({ error: `A single import can contain at most ${maximumQuestions} questions.` });
      return;
    }

    const imageRecords = images.length
      ? await prisma.questionImage.createManyAndReturn({
        data: images.map((image) => ({
          id: randomUUID(),
          ownerId: request.user!.id,
          originalFilename: safeOriginalFilename(image.filename),
          mimeType: image.mimeType,
          data: Uint8Array.from(image.data),
          size: image.data.length,
        })),
        select: { id: true },
      })
      : [];
    const imageUrls = new Map(images.map((image, index) => [
      image.token,
      `/api/uploads/images/${imageRecords[index].id}`,
    ]));
    const previewQuestions = questions.map(({ imageTokens, ...question }) => {
      const urls = imageTokens.flatMap((token) => {
        const url = imageUrls.get(token);
        return url ? [url] : [];
      });
      return {
        ...question,
        content: { ...question.content, ...(urls.length ? { imageUrls: urls } : {}) },
      };
    });
    response.json({
      questions: previewQuestions,
      totalQuestions: previewQuestions.length,
      pageCount: [...new Set(lines.map(({ page }) => page))].length,
      imageCount: images.length,
    });
  });

  router.post("/upload/save", async (request, response) => {
    const parsed = saveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Review the extracted questions and fill every required field before saving.",
        issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      });
      return;
    }
    const { type, classLevel, subject, chapter, questions } = parsed.data;
    const validated = questions.map((question) => questionSchema.safeParse({
      type,
      classLevel,
      group: "General",
      subject,
      chapter,
      topic: question.topic,
      marks: question.marks,
      content: { ...question.content, ...(question.sourceNumber ? { sourceNumber: question.sourceNumber } : {}) },
    }));
    const errors = validated.flatMap((result, index) => result.success
      ? []
      : result.error.issues.map(({ path, message }) => ({ question: index + 1, path, message })));
    if (errors.length) {
      response.status(400).json({ error: "One or more questions are invalid.", errors });
      return;
    }
    const inputQuestions = validated.map((result) => {
      if (!result.success) throw new Error("Validated question unexpectedly failed.");
      return result.data;
    });
    const duplicateIndices = new Set<number>();
    const seen = new Set<string>();
    inputQuestions.forEach((question, index) => {
      const fingerprint = questionFingerprint(question);
      if (seen.has(fingerprint)) duplicateIndices.add(index);
      seen.add(fingerprint);
    });
    let created: Array<{ id: string }> = [];
    try {
      created = await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(741852, 2)`;
        const candidates = await transaction.question.findMany({
          where: {
            type,
            classLevel,
            group: "General",
            subject,
            chapter,
            topic: { in: inputQuestions.map(({ topic }) => topic) },
          },
          select: { type: true, classLevel: true, group: true, subject: true, chapter: true, topic: true, marks: true, content: true },
        });
        const fingerprints = new Set(candidates.map(questionFingerprint));
        inputQuestions.forEach((question, index) => {
          if (fingerprints.has(questionFingerprint(question))) duplicateIndices.add(index);
        });
        if (duplicateIndices.size) {
          throw Object.assign(new Error(`Duplicate questions found at preview item${duplicateIndices.size > 1 ? "s" : ""} ${[...duplicateIndices].map((index) => index + 1).join(", ")}. Nothing was saved.`), {
            status: 409,
          });
        }
        await ensureAcademicEntries(
          transaction,
          classLevel,
          subject,
          chapter,
          [...new Set(inputQuestions.map(({ topic }) => topic).filter(Boolean))],
        );
        const saved = await transaction.question.createManyAndReturn({
          data: inputQuestions.map((question) => ({
            ...question,
            content: question.content as Prisma.InputJsonObject,
            authorId: request.user!.id,
          })),
          select: { id: true, type: true, classLevel: true, group: true, subject: true, chapter: true, topic: true, marks: true, content: true },
        });
        const byFingerprint = new Map(saved.map((question) => [questionFingerprint(question), question]));
        for (const question of inputQuestions) {
          const createdQuestion = byFingerprint.get(questionFingerprint(question));
          if (!createdQuestion) throw new Error("A saved question could not be matched to its preview item.");
          await attachOwnedQuestionImages(question.content, request.user!.id, createdQuestion.id, transaction);
        }
        await transaction.adminActivity.createMany({
          data: saved.map((question) => ({
            adminId: request.user!.id,
            action: "CREATE_QUESTION",
            entityType: "Question",
            entityId: question.id,
            details: { type, source: "DOCUMENT_IMPORT" },
          })),
        });
        return saved.map(({ id }) => ({ id }));
      }, { maxWait: 10_000, timeout: 120_000 });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && Number(error.status) === 409) {
        response.status(409).json({ error: error instanceof Error ? error.message : "Duplicate questions were found. Nothing was saved." });
        return;
      }
      throw error;
    }
    response.status(201).json({ saved: created.length, questionIds: created.map(({ id }) => id) });
  });
}
