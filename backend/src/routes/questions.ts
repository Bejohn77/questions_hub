import { Prisma, QuestionType } from "@prisma/client";
import express, { Router } from "express";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { authenticate, requirePasswordChanged } from "../middleware/auth";
import { attachOwnedQuestionImages } from "../question-images";
import { calculateTokenCost } from "../token-pricing";

const router = Router();
router.use(authenticate, requirePasswordChanged);

export const questionContentSchema = z.object({
  text: z.string().max(500).optional(),
  options: z.array(z.string().max(120)).max(8).optional(),
  subs: z.array(z.string().max(90)).max(4).optional(),
  answer: z.string().max(120).optional(),
  explanation: z.string().max(120).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  equation: z.string().max(300).optional(),
  imageUrl: z.string().max(300).optional(),
  imageUrls: z.array(z.string().max(300)).max(2000).optional(),
  table: z.object({
    headers: z.array(z.string().max(60)).min(1).max(5),
    rows: z.array(z.array(z.string().max(80)).max(5)).max(12),
  }).optional(),
  diagram: z.enum(["plant-cell"]).optional(),
  subMarks: z.array(z.number().int().min(0).max(20)).max(4).optional(),
  breakAfter: z.boolean().optional(),
}).passthrough();

export const questionBaseSchema = z.object({
  type: z.enum([QuestionType.MCQ, QuestionType.CQ, QuestionType.SHORT]),
  classLevel: z.string().trim().min(1).max(60),
  group: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1).max(120),
  chapter: z.string().trim().min(1).max(160),
  topic: z.string().trim().max(160),
  marks: z.number().int().min(0).max(1000),
  content: questionContentSchema,
});
export const questionSchema = questionBaseSchema.superRefine((question, context) => {
  if (!question.content.text?.trim()) {
    context.addIssue({ code: "custom", path: ["content", "text"], message: "Question text is required" });
  }
  if (question.type === "MCQ" && (question.content.options?.filter((option) => option.trim()).length ?? 0) < 2) {
    context.addIssue({ code: "custom", path: ["content", "options"], message: "MCQ requires at least two non-empty options" });
  }
  if (question.type === "CQ" && (question.content.subs?.filter((sub) => sub.trim()).length ?? 0) < 1) {
    context.addIssue({ code: "custom", path: ["content", "subs"], message: "CQ requires at least one sub-question" });
  }
});

const ownerFilter = (request: Express.Request) =>
  request.user?.role === "ADMIN" ? {} : { authorId: request.user!.id };
const libraryFilter = (request: Express.Request): Prisma.QuestionWhereInput =>
  request.user?.role === "ADMIN"
    ? {}
    : { OR: [{ authorId: request.user!.id }, { author: { role: "ADMIN" } }] };
const safeSpreadsheetText = (value: string) => /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;

export function questionFingerprint(question: {
  type: string;
  classLevel: string;
  group: string;
  subject: string;
  chapter: string;
  topic: string;
  marks: number;
  content: unknown;
}) {
  const normalizeJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .filter(([key]) => key !== "imageUrl" && key !== "imageUrls" && key !== "sourceNumber")
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  };
  return JSON.stringify([
    question.classLevel.trim().toLowerCase(),
    question.group.trim().toLowerCase(),
    question.subject.trim().toLowerCase(),
    question.chapter.trim().toLowerCase(),
    question.topic.trim().toLowerCase(),
    question.type,
    question.marks,
    normalizeJson(question.content),
  ]);
}

router.get("/export.csv", async (request, response) => {
  const questions = await prisma.question.findMany({ where: ownerFilter(request), orderBy: { createdAt: "desc" } });
  const csv = stringify(
    questions.map(({ type, classLevel, group, subject, chapter, topic, marks, content }) => {
      const fields = content as Record<string, unknown>;
      return {
        type, classLevel: safeSpreadsheetText(classLevel), group: safeSpreadsheetText(group),
        subject: safeSpreadsheetText(subject), chapter: safeSpreadsheetText(chapter),
        topic: safeSpreadsheetText(topic), marks,
        text: safeSpreadsheetText(typeof fields.text === "string" ? fields.text : ""),
        options: JSON.stringify(fields.options ?? []),
        answer: safeSpreadsheetText(typeof fields.answer === "string" ? fields.answer : ""),
        subquestions: JSON.stringify(fields.subs ?? []),
        subMarks: JSON.stringify(fields.subMarks ?? []),
        explanation: safeSpreadsheetText(typeof fields.explanation === "string" ? fields.explanation : ""),
        equation: safeSpreadsheetText(typeof fields.equation === "string" ? fields.equation : ""),
        imageUrl: safeSpreadsheetText(typeof fields.imageUrl === "string" ? fields.imageUrl : ""),
        content: safeSpreadsheetText(JSON.stringify(content)),
      };
    }),
    { header: true, columns: ["type", "classLevel", "group", "subject", "chapter", "topic", "marks", "text", "options", "answer", "subquestions", "subMarks", "explanation", "equation", "imageUrl", "content"] },
  );
  response.type("text/csv; charset=utf-8").attachment("questions.csv").send(`\uFEFF${csv}`);
});

router.get("/export.xlsx", async (request, response) => {
  const questions = await prisma.question.findMany({ where: ownerFilter(request), orderBy: { createdAt: "desc" } });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Questions");
  sheet.addRow(["type", "classLevel", "group", "subject", "chapter", "topic", "marks", "content"]);
  for (const question of questions) {
    sheet.addRow([
      question.type,
      question.classLevel,
      question.group,
      question.subject,
      question.chapter,
      question.topic,
      question.marks,
      JSON.stringify(question.content),
    ]);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  response.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.attachment("questions.xlsx").send(Buffer.from(buffer));
});

router.get("/", async (request, response) => {
  const query = z.object({
    search: z.string().max(120).optional(),
    classLevel: z.string().max(60).optional(),
    group: z.string().max(60).optional(),
    subject: z.string().max(120).optional(),
    chapter: z.string().max(160).optional(),
    topic: z.string().max(160).optional(),
    type: z.nativeEnum(QuestionType).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }).parse(request.query);
  const questions = await prisma.question.findMany({
    where: {
      ...libraryFilter(request),
      ...(query.classLevel ? { classLevel: query.classLevel } : {}),
      ...(query.group ? { group: query.group } : {}),
      ...(query.subject ? { subject: { contains: query.subject, mode: "insensitive" } } : {}),
      ...(query.chapter ? { chapter: { contains: query.chapter, mode: "insensitive" } } : {}),
      ...(query.topic ? { topic: { contains: query.topic, mode: "insensitive" } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? {
        AND: [{
          OR: [
            { topic: { contains: query.search, mode: "insensitive" as const } },
            { subject: { contains: query.search, mode: "insensitive" as const } },
            { chapter: { contains: query.search, mode: "insensitive" as const } },
          ],
        }],
      } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    skip: query.offset,
  });
  response.json({ questions });
});

router.get("/catalog", async (request, response) => {
  const query = z.object({
    classLevel: z.string().max(60).optional(),
    group: z.string().max(60).optional(),
    subject: z.string().max(120).optional(),
    chapter: z.string().max(160).optional(),
  }).parse(request.query);
  const rows = await prisma.question.findMany({
    where: {
      ...libraryFilter(request),
      ...(query.classLevel ? { classLevel: query.classLevel } : {}),
      ...(query.group ? { group: query.group } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
      ...(query.chapter ? { chapter: query.chapter } : {}),
    },
    select: { classLevel: true, group: true, subject: true, chapter: true, topic: true },
    distinct: ["classLevel", "group", "subject", "chapter", "topic"],
    orderBy: [{ classLevel: "asc" }, { group: "asc" }, { subject: "asc" }, { chapter: "asc" }, { topic: "asc" }],
  });
  response.json({
    classes: [...new Set(rows.map((row) => row.classLevel))],
    groups: [...new Set(rows.map((row) => row.group))],
    subjects: [...new Set(rows.map((row) => row.subject))],
    chapters: [...new Set(rows.map((row) => row.chapter))],
    topics: [...new Set(rows.map((row) => row.topic))],
  });
});

router.post("/manual-create", async (request, response) => {
  const input = questionSchema.extend({ idempotencyKey: z.string().uuid() }).parse(request.body);
  const charge = calculateTokenCost([input]);
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const sendDuplicate = async (transaction: {
    userId: string;
    type: string;
    requestHash: string | null;
    amount: number;
    createdAt: Date;
    question: { id: string } | null;
  }) => {
    if (transaction.userId !== request.user!.id || transaction.type !== "CHARGE" ||
      transaction.requestHash !== requestHash || !transaction.question) {
      response.status(409).json({ error: "This manual-question request key has already been used" });
      return;
    }
    const account = await prisma.user.findUnique({
      where: { id: request.user!.id },
      select: { tokenBalance: true },
    });
    response.json({
      question: transaction.question,
      chargedTokens: -transaction.amount,
      balance: account?.tokenBalance ?? 0,
      transaction: {
        type: transaction.type,
        amount: transaction.amount,
        createdAt: transaction.createdAt,
      },
      duplicate: true,
    });
  };

  const previous = await prisma.tokenTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { question: { select: { id: true } } },
  });
  if (previous) {
    await sendDuplicate(previous);
    return;
  }

  try {
    const generated = await prisma.$transaction(async (transaction) => {
      const balanceUpdate = await transaction.user.updateMany({
        where: { id: request.user!.id, tokenBalance: { gte: charge } },
        data: { tokenBalance: { decrement: charge } },
      });
      if (balanceUpdate.count !== 1) return null;

      const question = await transaction.question.create({
        data: {
          type: input.type,
          classLevel: input.classLevel,
          group: input.group,
          subject: input.subject,
          chapter: input.chapter,
          topic: input.topic,
          marks: input.marks,
          content: input.content as Prisma.InputJsonObject,
          authorId: request.user!.id,
        },
      });
      await attachOwnedQuestionImages(input.content, request.user!.id, question.id, transaction);
      const tokenTransaction = await transaction.tokenTransaction.create({
        data: {
          userId: request.user!.id,
          questionId: question.id,
          type: "CHARGE",
          amount: -charge,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      });
      const account = await transaction.user.findUniqueOrThrow({
        where: { id: request.user!.id },
        select: { tokenBalance: true },
      });
      return { question, balance: account.tokenBalance, tokenTransaction };
    });

    if (!generated) {
      const account = await prisma.user.findUnique({
        where: { id: request.user!.id },
        select: { tokenBalance: true },
      });
      response.status(402).json({
        error: "Insufficient tokens to create this question",
        requiredTokens: charge,
        balance: account?.tokenBalance ?? 0,
      });
      return;
    }
    response.status(201).json({
      question: generated.question,
      chargedTokens: charge,
      balance: generated.balance,
      transaction: {
        type: generated.tokenTransaction.type,
        amount: generated.tokenTransaction.amount,
        createdAt: generated.tokenTransaction.createdAt,
      },
      duplicate: false,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const retry = await prisma.tokenTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { question: { select: { id: true } } },
      });
      if (retry) {
        await sendDuplicate(retry);
        return;
      }
    }
    throw error;
  }
});

router.post("/", async (request, response) => {
  const input = questionSchema.parse(request.body);
  const question = await prisma.question.create({ data: { ...input, content: input.content as Prisma.InputJsonObject, authorId: request.user!.id } });
  await attachOwnedQuestionImages(input.content, request.user!.id, question.id);
  response.status(201).json({ question });
});

router.patch("/:id", async (request, response) => {
  const input = questionBaseSchema.partial().parse(request.body);
  const existing = await prisma.question.findFirst({
    where: { id: request.params.id, ...ownerFilter(request) },
  });
  if (!existing) {
    response.status(404).json({ error: "Question not found" });
    return;
  }

  const existingContent = typeof existing.content === "object" && existing.content !== null && !Array.isArray(existing.content)
    ? existing.content
    : {};
  const content = input.content === undefined
    ? existingContent
    : { ...existingContent, ...input.content };
  const validation = questionSchema.safeParse({ ...existing, ...input, content });
  if (!validation.success) {
    response.status(400).json({ error: "Invalid question update", issues: validation.error.issues });
    return;
  }

  const { content: _content, ...questionFields } = input;
  const data: Prisma.QuestionUpdateManyMutationInput = {
    ...questionFields,
    ...(input.content === undefined ? {} : { content: content as Prisma.InputJsonObject }),
  };
  const result = await prisma.question.updateMany({ where: { id: request.params.id, ...ownerFilter(request) }, data });
  if (result.count === 0) {
    response.status(404).json({ error: "Question not found" });
    return;
  }
  const question = await prisma.question.findUnique({ where: { id: request.params.id } });
  await attachOwnedQuestionImages(question?.content, request.user!.id, request.params.id);
  response.json({ question });
});

router.delete("/:id", async (request, response) => {
  const result = await prisma.question.deleteMany({ where: { id: request.params.id, ...ownerFilter(request) } });
  if (result.count === 0) {
    response.status(404).json({ error: "Question not found" });
    return;
  }
  response.status(204).end();
});

export default router;