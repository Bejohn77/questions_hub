import { Prisma, QuestionType } from "@prisma/client";
import { Router } from "express";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { z } from "zod";
import { AcademicEntryType } from "@prisma/client";
import { prisma } from "../db";
import { authenticate, requireAdmin, requirePasswordChanged } from "../middleware/auth";
import { registerAdminQuestionUploadRoutes } from "../admin-question-upload";
import { attachOwnedQuestionImages } from "../question-images";
import { questionBaseSchema, questionFingerprint, questionSchema } from "./questions";

const router = Router();
router.use(authenticate, requirePasswordChanged, requireAdmin);

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  classLevel: z.string().trim().max(60).optional(),
  group: z.string().trim().max(60).optional(),
  subject: z.string().trim().max(120).optional(),
  chapter: z.string().trim().max(160).optional(),
  topic: z.string().trim().max(160).optional(),
  type: z.enum([QuestionType.MCQ, QuestionType.CQ]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const safeSpreadsheetText = (value: string) => /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
router.get("/catalog", async (request, response) => {
  const query = z.object({
    classLevel: z.string().max(60).optional(),
    group: z.string().max(60).optional(),
    subject: z.string().max(120).optional(),
    chapter: z.string().max(160).optional(),
  }).parse(request.query);
  const rows = await prisma.question.findMany({
    where: {
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

router.get("/dashboard", async (_request, response) => {
  const [
    totalQuestions,
    mcqQuestions,
    cqQuestions,
    registeredUsers,
    totalAdmins,
    activeUserCounts,
    classGroups,
    subjectGroups,
    chapterGroups,
    topicGroups,
    academicEntries,
    recentMcqQuestions,
    recentCqQuestions,
    recentUsers,
    registrationTrend,
    questionUploadTrend,
    importStats,
    recentImports,
    recentManualUploads,
    recentActivities,
  ] = await Promise.all([
    prisma.question.count(),
    prisma.question.count({ where: { type: QuestionType.MCQ } }),
    prisma.question.count({ where: { type: QuestionType.CQ } }),
    prisma.user.count({ where: { role: "TEACHER" } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
      SELECT count(DISTINCT sessions."userId")::int AS count
      FROM "AuthSession" AS sessions
      INNER JOIN "User" AS users ON users.id = sessions."userId"
      WHERE users.role = 'TEACHER' AND sessions."expiresAt" > NOW()
    `),
    prisma.question.groupBy({ by: ["classLevel"], _count: { _all: true }, orderBy: { classLevel: "asc" } }),
    prisma.question.groupBy({ by: ["subject"], _count: { _all: true }, orderBy: { subject: "asc" } }),
    prisma.question.groupBy({ by: ["chapter"], _count: { _all: true }, orderBy: { chapter: "asc" } }),
    prisma.question.groupBy({ by: ["topic"], where: { topic: { not: "" } }, _count: { _all: true }, orderBy: { topic: "asc" } }),
    prisma.academicEntry.findMany({ select: { type: true, name: true } }),
    prisma.question.findMany({
      where: { type: QuestionType.MCQ },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        type: true,
        classLevel: true,
        subject: true,
        chapter: true,
        marks: true,
        createdAt: true,
        content: true,
        author: { select: { name: true, email: true } },
      },
    }),
    prisma.question.findMany({
      where: { type: QuestionType.CQ },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        type: true,
        classLevel: true,
        subject: true,
        chapter: true,
        marks: true,
        createdAt: true,
        content: true,
        author: { select: { name: true, email: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: "TEACHER" },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    }),
    prisma.$queryRaw<{ day: Date; count: number }[]>(Prisma.sql`
      SELECT days.day, COALESCE(registrations.count, 0)::int AS count
      FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') AS days(day)
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS count
        FROM "User"
        WHERE role = 'TEACHER' AND "createdAt" >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY date_trunc('day', "createdAt")
      ) AS registrations ON registrations.day = days.day
      ORDER BY days.day ASC
    `),
    prisma.$queryRaw<{ day: Date; mcqCount: number; cqCount: number }[]>(Prisma.sql`
      SELECT days.day,
        COALESCE(uploads.mcq_count, 0)::int AS "mcqCount",
        COALESCE(uploads.cq_count, 0)::int AS "cqCount"
      FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') AS days(day)
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day,
          count(*) FILTER (WHERE type = 'MCQ')::int AS mcq_count,
          count(*) FILTER (WHERE type = 'CQ')::int AS cq_count
        FROM "Question"
        WHERE type IN ('MCQ', 'CQ')
          AND "createdAt" >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY date_trunc('day', "createdAt")
      ) AS uploads ON uploads.day = days.day
      ORDER BY days.day ASC
    `),
    prisma.questionImport.groupBy({
      by: ["status"],
      _count: { _all: true },
      _sum: { importedRows: true, failedRows: true, duplicateRows: true },
      orderBy: { status: "asc" },
    }),
    prisma.questionImport.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        filename: true,
        questionType: true,
        status: true,
        totalRows: true,
        importedRows: true,
        failedRows: true,
        createdAt: true,
        admin: { select: { name: true, email: true } },
      },
    }),
    prisma.adminActivity.findMany({
      where: { action: "CREATE_QUESTION", entityType: "Question" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        details: true,
        admin: { select: { name: true, email: true } },
      },
    }),
    prisma.adminActivity.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        details: true,
        admin: { select: { name: true, email: true } },
      },
    }),
  ]);
  const countAcademicNames = (type: string, names: string[]) => {
    const academicNames = academicEntries.filter((entry) => entry.type === type).map(({ name }) => name);
    const missingQuestionNames = new Set(names.filter((name) => !academicNames.includes(name)));
    return academicNames.length + missingQuestionNames.size;
  };
  const aggregateCount = (value: { _all?: number } | boolean | undefined) =>
    typeof value === "object" && value ? value._all ?? 0 : 0;
  const emptyImportStats = { attempts: 0, importedRows: 0, failedRows: 0, duplicateRows: 0 };
  const uploadStats = importStats.reduce((stats, item) => ({
    attempts: stats.attempts + aggregateCount(item._count),
    importedRows: stats.importedRows + (typeof item._sum === "object" && item._sum ? item._sum.importedRows ?? 0 : 0),
    failedRows: stats.failedRows + (typeof item._sum === "object" && item._sum ? item._sum.failedRows ?? 0 : 0),
    duplicateRows: stats.duplicateRows + (typeof item._sum === "object" && item._sum ? item._sum.duplicateRows ?? 0 : 0),
  }), emptyImportStats);
  const activeUsers = Math.min(registeredUsers, activeUserCounts[0]?.count ?? 0);
  response.json({
    totals: {
      totalQuestions,
      mcqQuestions,
      cqQuestions,
      classes: countAcademicNames("CLASS", classGroups.map(({ classLevel }) => classLevel)),
      subjects: countAcademicNames("SUBJECT", subjectGroups.map(({ subject }) => subject)),
      chapters: countAcademicNames("CHAPTER", chapterGroups.map(({ chapter }) => chapter)),
      topics: countAcademicNames("TOPIC", topicGroups.map(({ topic }) => topic)),
      registeredUsers,
      admins: totalAdmins,
      activeUsers,
      inactiveUsers: registeredUsers - activeUsers,
    },
    classDistribution: classGroups.map(({ classLevel, _count }) => ({ name: classLevel, count: aggregateCount(_count) })),
    subjectDistribution: subjectGroups.map(({ subject, _count }) => ({ name: subject, count: aggregateCount(_count) })),
    recentMcqQuestions,
    recentCqQuestions,
    recentUsers,
    registrationTrend,
    questionUploadTrend,
    uploadStats,
    recentImports,
    recentManualUploads,
    recentActivities,
    capabilities: {
      activeSessions: true,
      loginAudit: false,
      userManagement: false,
    },
  });
});

router.get("/academic", async (request, response) => {
  const type = z.enum(AcademicEntryType).optional().parse(request.query.type);
  const entries = await prisma.academicEntry.findMany({
    where: type ? { type } : {},
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: { parent: { select: { id: true, type: true, name: true } } },
  });
  response.json({ entries });
});

router.post("/academic", async (request, response) => {
  const input = z.object({
    type: z.enum(AcademicEntryType),
    name: z.string().trim().min(1).max(160),
    parentId: z.string().min(1).max(64).nullable().optional(),
  }).parse(request.body);
  const parentId = input.parentId ?? null;
  const expectedParent = ({
    CLASS: null,
    GROUP: AcademicEntryType.CLASS,
    SUBJECT: AcademicEntryType.GROUP,
    CHAPTER: AcademicEntryType.SUBJECT,
    TOPIC: AcademicEntryType.CHAPTER,
    DIVISION: AcademicEntryType.CLASS,
  })[input.type];
  if ((expectedParent === null && parentId !== null) || (expectedParent !== null && !parentId)) {
    response.status(400).json({ error: "Select a valid parent academic entry" });
    return;
  }
  if (parentId) {
    const parent = await prisma.academicEntry.findUnique({ where: { id: parentId }, select: { type: true } });
    if (!parent || parent.type !== expectedParent) {
      response.status(400).json({ error: "Parent academic entry has an incompatible type" });
      return;
    }
  }
  const entry = await prisma.academicEntry.create({
    data: { type: input.type, name: input.name, parentId },
    include: { parent: { select: { id: true, type: true, name: true } } },
  });
  await prisma.adminActivity.create({
    data: { adminId: request.user!.id, action: "CREATE_ACADEMIC_ENTRY", entityType: "AcademicEntry", entityId: entry.id, details: { type: entry.type, name: entry.name } },
  });
  response.status(201).json({ entry });
});

router.delete("/academic/:id", async (request, response) => {
  const id = z.string().min(1).max(64).parse(request.params.id);
  const entry = await prisma.academicEntry.findUnique({ where: { id }, select: { id: true, type: true, name: true } });
  if (!entry) {
    response.status(404).json({ error: "Academic entry not found" });
    return;
  }
  await prisma.$transaction([
    prisma.adminActivity.create({
      data: { adminId: request.user!.id, action: "DELETE_ACADEMIC_ENTRY", entityType: "AcademicEntry", entityId: id, details: { type: entry.type, name: entry.name } },
    }),
    prisma.academicEntry.delete({ where: { id } }),
  ]);
  response.status(204).end();
});

router.get("/", async (request, response) => {
  const query = listQuerySchema.parse(request.query);
  const where: Prisma.QuestionWhereInput = {
    ...(query.classLevel ? { classLevel: query.classLevel } : {}),
    ...(query.group ? { group: query.group } : {}),
    ...(query.subject ? { subject: { contains: query.subject, mode: "insensitive" } } : {}),
    ...(query.chapter ? { chapter: { contains: query.chapter, mode: "insensitive" } } : {}),
    ...(query.topic ? { topic: { contains: query.topic, mode: "insensitive" } } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.search ? {
      OR: [
        { classLevel: { contains: query.search, mode: "insensitive" } },
        { group: { contains: query.search, mode: "insensitive" } },
        { subject: { contains: query.search, mode: "insensitive" } },
        { chapter: { contains: query.search, mode: "insensitive" } },
        { topic: { contains: query.search, mode: "insensitive" } },
        { content: { path: ["text"], string_contains: query.search, mode: "insensitive" } },
      ],
    } : {}),
  };
  const [questions, total] = await prisma.$transaction([
    prisma.question.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: query.limit,
      skip: query.offset,
    }),
    prisma.question.count({ where }),
  ]);
  response.json({ questions, total, limit: query.limit, offset: query.offset });
});

router.get("/export.csv", async (_request, response) => {
  const questions = await prisma.question.findMany({ orderBy: { createdAt: "desc" } });
  const csv = stringify(
    questions.map(({ type, classLevel, group, subject, chapter, topic, marks, content }) => {
      const fields = content as Record<string, unknown>;
      return {
        type,
        classLevel: safeSpreadsheetText(classLevel),
        group: safeSpreadsheetText(group),
        subject: safeSpreadsheetText(subject),
        chapter: safeSpreadsheetText(chapter),
        topic: safeSpreadsheetText(topic),
        marks,
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

router.get("/export.xlsx", async (_request, response) => {
  const questions = await prisma.question.findMany({ orderBy: { createdAt: "desc" } });
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

registerAdminQuestionUploadRoutes(router);

router.post("/", async (request, response) => {
  const parsed = questionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: "Question validation failed",
      issues: parsed.error.issues.map((entry) => ({
        path: entry.path,
        message: entry.message,
      })),
    });
    return;
  }
  if (parsed.data.marks <= 0) {
    response.status(400).json({
      error: "Question validation failed",
      issues: [{ path: ["marks"], message: "Marks must be greater than zero" }],
    });
    return;
  }
  const input = parsed.data;
  const question = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(741852, 2)`;
    const candidates = await transaction.question.findMany({
      where: {
        type: input.type,
        classLevel: input.classLevel,
        group: input.group,
        subject: input.subject,
        chapter: input.chapter,
        topic: input.topic,
        marks: input.marks,
      },
      select: {
        type: true,
        classLevel: true,
        group: true,
        subject: true,
        chapter: true,
        topic: true,
        marks: true,
        content: true,
      },
    });
    const fingerprint = questionFingerprint(input);
    if (candidates.some((candidate) => questionFingerprint(candidate) === fingerprint)) return null;
    const created = await transaction.question.create({
      data: { ...input, content: input.content as Prisma.InputJsonObject, authorId: request.user!.id },
    });
    await attachOwnedQuestionImages(input.content, request.user!.id, created.id, transaction);
    await transaction.adminActivity.create({
      data: { adminId: request.user!.id, action: "CREATE_QUESTION", entityType: "Question", entityId: created.id, details: { type: created.type } },
    });
    return created;
  });
  if (!question) {
    response.status(409).json({ error: "This question already exists" });
    return;
  }
  response.status(201).json({ question });
});

router.patch("/:id", async (request, response) => {
  const input = questionBaseSchema.partial().parse(request.body);
  const existing = await prisma.question.findUnique({ where: { id: request.params.id } });
  if (!existing) {
    response.status(404).json({ error: "Question not found" });
    return;
  }
  const existingContent = typeof existing.content === "object" && existing.content !== null && !Array.isArray(existing.content)
    ? existing.content
    : {};
  const content = input.content === undefined ? existingContent : { ...existingContent, ...input.content };
  const validation = questionSchema.safeParse({ ...existing, ...input, content });
  if (!validation.success) {
    response.status(400).json({ error: "Invalid question update", issues: validation.error.issues });
    return;
  }
  if (validation.data.marks <= 0) {
    response.status(400).json({
      error: "Invalid question update",
      issues: [{ path: ["marks"], message: "Marks must be greater than zero" }],
    });
    return;
  }
  const { content: _content, ...fields } = input;
  const question = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.question.update({
      where: { id: request.params.id },
      data: {
        ...fields,
        ...(input.content === undefined ? {} : { content: content as Prisma.InputJsonObject }),
      },
    });
    await attachOwnedQuestionImages(updated.content, request.user!.id, updated.id, transaction);
    await transaction.adminActivity.create({
      data: { adminId: request.user!.id, action: "UPDATE_QUESTION", entityType: "Question", entityId: updated.id, details: { type: updated.type } },
    });
    return updated;
  });
  response.json({ question });
});

router.delete("/bulk", async (request, response) => {
  const { ids } = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500).refine((values) => new Set(values).size === values.length, "Question IDs must be unique"),
  }).parse(request.body);
  const linkedItems = await prisma.paperItem.findMany({
    where: { questionId: { in: ids } },
    select: { questionId: true },
    distinct: ["questionId"],
  });
  if (linkedItems.length) {
    response.status(409).json({ error: "Some selected questions are used by saved papers", questionIds: linkedItems.map(({ questionId }) => questionId) });
    return;
  }
  const removed = await prisma.$transaction([
    prisma.question.deleteMany({ where: { id: { in: ids } } }),
    prisma.adminActivity.create({
      data: { adminId: request.user!.id, action: "BULK_DELETE_QUESTIONS", entityType: "Question", details: { requestedCount: ids.length } },
    }),
  ]);
  response.json({ deleted: removed[0].count });
});

router.delete("/:id", async (request, response) => {
  const linkedPaperItems = await prisma.paperItem.count({ where: { questionId: request.params.id } });
  if (linkedPaperItems > 0) {
    response.status(409).json({ error: "This question is used by a saved paper and cannot be deleted" });
    return;
  }
  const result = await prisma.question.deleteMany({ where: { id: request.params.id } });
  if (result.count === 0) {
    response.status(404).json({ error: "Question not found" });
    return;
  }
  await prisma.adminActivity.create({
    data: { adminId: request.user!.id, action: "DELETE_QUESTION", entityType: "Question", entityId: request.params.id },
  });
  response.status(204).end();
});

export default router;
