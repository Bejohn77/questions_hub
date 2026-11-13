import { createHash } from "node:crypto";
import { Prisma, QuestionType, TokenTransactionType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { authenticate, requirePasswordChanged } from "../middleware/auth";
import { selectCqQuestionsBySet, selectRandomQuestions } from "../paper-generator";
import { calculateTokenCost, tokenRates } from "../token-pricing";

const router = Router();
router.use(authenticate, requirePasswordChanged);

const cqSetSchema = z.object({
  setNumber: z.number().int().min(1).max(4),
  chapters: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
  questionCount: z.number().int().min(1).max(12),
}).strict();

const paperSettingsSchema = z.object({
  institution: z.string().max(180),
  exam: z.string().max(180),
  duration: z.string().max(80),
  marks: z.number().int().min(0).max(100_000),
  instructions: z.string().max(2000),
  className: z.string().max(60),
  group: z.string().max(60),
  subject: z.string().max(120),
  chapter: z.string().max(8000),
  topic: z.string().max(8000),
  fontSize: z.number().min(5).max(24),
  margin: z.number().min(4).max(30),
  columnGap: z.number().min(0).max(30),
  lineSpacing: z.number().min(1).max(3),
  cqPageLayout: z.enum(["one", "two"]).optional(),
  cqSetCount: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  cqSetAssignments: z.record(z.string(), z.number().int().min(1).max(4)).optional(),
  cqSets: z.array(cqSetSchema).max(4).optional(),
}).strict();

const generatedPaperSchema = z.object({
  title: z.string().trim().min(1).max(180),
  settings: paperSettingsSchema.partial(),
  classLevel: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1).max(120),
  chapters: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  topics: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  type: z.enum([QuestionType.MCQ, QuestionType.CQ, QuestionType.SHORT]),
  mode: z.enum(["auto", "manual"]),
  questionCount: z.number().int().min(1).max(500).optional(),
  questionIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  blueprint: z.object({
    marks: z.number().int().min(1).max(1000),
    difficultyCounts: z.object({
      easy: z.number().int().min(0).max(500),
      medium: z.number().int().min(0).max(500),
      hard: z.number().int().min(0).max(500),
    }).strict(),
  }).strict().optional(),
  cqSetCount: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  cqSets: z.array(cqSetSchema).max(4).optional(),
  cqSetAssignments: z.array(z.object({
    questionId: z.string().min(1).max(64),
    setNumber: z.number().int().min(1).max(4),
  }).strict()).max(12).optional(),
  idempotencyKey: z.string().uuid(),
}).superRefine((input, context) => {
  if (new Set(input.chapters).size !== input.chapters.length) {
    context.addIssue({ code: "custom", path: ["chapters"], message: "Duplicate chapters are not allowed" });
  }
  if (new Set(input.topics).size !== input.topics.length) {
    context.addIssue({ code: "custom", path: ["topics"], message: "Duplicate topics are not allowed" });
  }
  if (input.mode === "auto" && input.questionCount === undefined) {
    context.addIssue({ code: "custom", path: ["questionCount"], message: "Automatic generation requires a question count" });
  }
  if (input.blueprint) {
    const blueprintCount = Object.values(input.blueprint.difficultyCounts).reduce((total, count) => total + count, 0);
    if (input.mode !== "auto") {
      context.addIssue({ code: "custom", path: ["blueprint"], message: "Blueprint selection requires automatic generation" });
    }
    if (blueprintCount < 1 || blueprintCount !== input.questionCount) {
      context.addIssue({ code: "custom", path: ["blueprint.difficultyCounts"], message: "Difficulty counts must add up to the requested question count" });
    }
    if (input.cqSetCount !== undefined || input.cqSets !== undefined || input.cqSetAssignments !== undefined) {
      context.addIssue({ code: "custom", path: ["blueprint"], message: "Blueprint selection cannot be combined with CQ sets" });
    }
  }
  if (input.mode === "auto" && input.type === QuestionType.CQ && (input.questionCount ?? 0) > 12) {
    context.addIssue({ code: "custom", path: ["questionCount"], message: "Creative-question papers can contain at most 12 questions" });
  }
  const setCount = input.cqSetCount ?? 0;
  if (input.type !== QuestionType.CQ && (
    input.cqSetCount !== undefined || input.cqSets !== undefined || input.cqSetAssignments !== undefined
  )) {
    context.addIssue({ code: "custom", path: ["cqSetCount"], message: "Set distribution is only available for creative-question papers" });
  }
  if (input.type === QuestionType.CQ && input.mode === "manual" && setCount !== 0) {
    context.addIssue({ code: "custom", path: ["cqSetCount"], message: "Set distribution requires automatic generation" });
  }
  if (input.type === QuestionType.CQ && input.mode === "auto" && setCount > 0) {
    const sets = input.cqSets ?? [];
    if (sets.length !== setCount || sets.some((set, index) => set.setNumber !== index + 1)) {
      context.addIssue({ code: "custom", path: ["cqSets"], message: "Provide one configuration for each selected set, in order" });
    }
    if (sets.some((set) => new Set(set.chapters).size !== set.chapters.length)) {
      context.addIssue({ code: "custom", path: ["cqSets"], message: "Duplicate chapters are not allowed within a set" });
    }
    const totalSetQuestions = sets.reduce((total, set) => total + set.questionCount, 0);
    if (totalSetQuestions > 12 || input.questionCount !== totalSetQuestions) {
      context.addIssue({ code: "custom", path: ["questionCount"], message: "The total CQ question count must match the set counts and cannot exceed 12" });
    }
    if (input.questionIds !== undefined && (
      input.cqSetAssignments?.length !== totalSetQuestions ||
      input.cqSetAssignments?.some((assignment) =>
        !input.questionIds?.includes(assignment.questionId) ||
        assignment.setNumber > setCount) ||
      new Set(input.cqSetAssignments?.map((assignment) => assignment.questionId)).size !== totalSetQuestions
    )) {
      context.addIssue({ code: "custom", path: ["cqSetAssignments"], message: "Every selected question must be assigned to exactly one set" });
    }
  } else if (input.type === QuestionType.CQ && (
    (input.cqSets?.length ?? 0) > 0 || (input.cqSetAssignments?.length ?? 0) > 0
  )) {
    context.addIssue({ code: "custom", path: ["cqSets"], message: "Set configurations require a non-zero automatic set selection" });
  }
  if (
    input.mode === "auto" &&
    input.questionCount !== undefined &&
    input.questionIds !== undefined &&
    input.questionIds.length !== input.questionCount
  ) {
    context.addIssue({ code: "custom", path: ["questionIds"], message: "The selected question count does not match the requested count" });
  }
  if (input.mode === "manual" && (input.questionIds === undefined || input.questionCount !== undefined)) {
    context.addIssue({ code: "custom", path: ["questionIds"], message: "Manual mode requires a question selection and does not accept a question count" });
  }
  if (input.questionIds && new Set(input.questionIds).size !== input.questionIds.length) {
    context.addIssue({ code: "custom", path: ["questionIds"], message: "Duplicate questions are not allowed" });
  }
});

const paperSchema = z.object({
  title: z.string().trim().min(1).max(180),
  settings: z.record(z.string(), z.unknown()),
  questionIds: z.array(z.string().min(1).max(64)).min(1).max(500),
}).refine((paper) => new Set(paper.questionIds).size === paper.questionIds.length, "Duplicate questions are not allowed");

const settingsOnlySchema = z.object({
  title: z.string().trim().min(1).max(180),
  settings: paperSettingsSchema.required().extend({
    showAnswers: z.boolean(),
    questionType: z.enum([QuestionType.MCQ, QuestionType.CQ, QuestionType.SHORT]),
    cqPageLayout: z.enum(["one", "two"]).optional(),
    cqSetCount: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    cqSetAssignments: z.record(z.string(), z.number().int().min(1).max(4)).optional(),
    cqSets: z.array(cqSetSchema).max(4).optional(),
  }).strict(),
}).strict();

const ownerFilter = (request: Express.Request) =>
  request.user?.role === "ADMIN" ? {} : { ownerId: request.user!.id };

const questionAccessFilter = (request: Express.Request): Prisma.QuestionWhereInput =>
  request.user!.role === "ADMIN" ? {} : {
    OR: [{ authorId: request.user!.id }, { author: { role: "ADMIN" } }],
  };

type PaperQuestionType = typeof QuestionType.MCQ | typeof QuestionType.CQ | typeof QuestionType.SHORT;

function storedQuestionType(settings: Prisma.JsonValue): PaperQuestionType | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const questionType = settings.questionType;
  return questionType === QuestionType.MCQ || questionType === QuestionType.CQ || questionType === QuestionType.SHORT
    ? questionType
    : null;
}

type QuestionRecord = Awaited<ReturnType<typeof prisma.question.findMany>>[number];
type SelectionResult =
  | { error: string; status: 400 | 422; availableCount?: number; setNumber?: number; requestedCount?: number }
  | {
    questions: QuestionRecord[];
    candidates?: QuestionRecord[];
    availableCount: number;
    setAssignments?: { questionId: string; setNumber: number }[];
  };

type QuestionClass = { id: string; classLevel: string; subject: string };

function classSelectionError(questions: QuestionClass[], expectedCount: number): string | null {
  if (questions.length !== expectedCount) return "One or more selected questions are unavailable";
  if (new Set(questions.map(({ classLevel, subject }) => JSON.stringify([classLevel, subject]))).size > 1) {
    return "Questions from different classes or subjects cannot be combined in one paper";
  }
  return null;
}

function candidateFilter(request: Express.Request, input: z.infer<typeof generatedPaperSchema>): Prisma.QuestionWhereInput {
  return {
    classLevel: input.classLevel,
    subject: input.subject,
    ...(input.chapters.length ? { chapter: { in: input.chapters } } : {}),
    ...(input.topics.length ? { topic: { in: input.topics } } : {}),
    type: input.type,
    marks: input.blueprint ? input.blueprint.marks : { gt: 0 },
    ...questionAccessFilter(request),
  };
}

function storedDifficulty(question: QuestionRecord): "easy" | "medium" | "hard" | null {
  const content = question.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const difficulty = (content as Prisma.JsonObject).difficulty;
  return difficulty === "easy" || difficulty === "medium" || difficulty === "hard"
    ? difficulty
    : null;
}

async function getSelectedQuestions(
  request: Express.Request,
  input: z.infer<typeof generatedPaperSchema>,
): Promise<SelectionResult> {
  const setCount = input.type === QuestionType.CQ && input.mode === "auto" ? input.cqSetCount ?? 0 : 0;
  const where = candidateFilter(request, input);
  if (setCount > 0) {
    where.chapter = { in: [...new Set((input.cqSets ?? []).flatMap((set) => set.chapters))] };
  }
  const candidates = await prisma.question.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (input.mode === "manual" && candidates.length > 2000) {
    return { error: "Too many eligible questions; narrow chapters or topics", status: 400 as const };
  }

  if (input.mode === "auto") {
    const questionCount = input.questionCount!;
    if (input.blueprint) {
      const { difficultyCounts } = input.blueprint;
      const eligible = candidates.filter((question) => storedDifficulty(question) !== null);
      const selected: QuestionRecord[] = [];
      for (const difficulty of ["easy", "medium", "hard"] as const) {
        const requestedCount = difficultyCounts[difficulty];
        const tierCandidates = eligible.filter((question) => storedDifficulty(question) === difficulty);
        if (input.questionIds !== undefined) {
          const selectedById = new Map(candidates.map((question) => [question.id, question]));
          const tierSelected = input.questionIds.flatMap((id) => {
            const question = selectedById.get(id);
            return question && storedDifficulty(question) === difficulty ? [question] : [];
          });
          if (tierSelected.length !== requestedCount) {
            return {
              error: `Selected questions do not match the ${difficulty} blueprint count`,
              status: 400,
            };
          }
          selected.push(...tierSelected);
        } else {
          if (tierCandidates.length < requestedCount) {
            return {
              error: `Insufficient ${difficulty} questions: ${tierCandidates.length} available, ${requestedCount} requested`,
              status: 422,
              availableCount: tierCandidates.length,
            };
          }
          selected.push(...selectRandomQuestions(tierCandidates, requestedCount));
        }
      }
      if (selected.length !== questionCount ||
        (input.questionIds !== undefined &&
          (new Set(input.questionIds).size !== questionCount ||
            selected.some((question, index) => question.id !== input.questionIds?.[index])))) {
        return { error: "One or more selected questions do not match the blueprint filters", status: 400 };
      }
      return { questions: selected, availableCount: eligible.length };
    }
    if (setCount > 0) {
      const sets = input.cqSets ?? [];
      const selection = selectCqQuestionsBySet(
        candidates,
        sets,
        input.questionIds === undefined ? undefined : input.cqSetAssignments,
      );
      if ("error" in selection) {
        return {
          error: `Set ${selection.error.setNumber} has ${selection.error.availableCount} eligible questions; ${selection.error.requestedCount} requested`,
          status: input.questionIds === undefined ? 422 : 400,
          availableCount: selection.error.availableCount,
          setNumber: selection.error.setNumber,
          requestedCount: selection.error.requestedCount,
        };
      }
      if (input.questionIds !== undefined &&
        (selection.questions.length !== questionCount ||
          selection.questions.some((question, index) => question.id !== input.questionIds?.[index]))) {
        return {
          error: "One or more selected questions do not match their assigned set, chapters, or requested count",
          status: 400,
        };
      }
      return {
        questions: selection.questions,
        availableCount: candidates.length,
        setAssignments: selection.assignments,
      };
    }
    if (candidates.length < questionCount) {
      return {
        error: `Insufficient eligible questions: ${candidates.length} available, ${questionCount} requested`,
        status: 422,
        availableCount: candidates.length,
      };
    }
    if (input.questionIds !== undefined) {
      const selectedIds = new Set(input.questionIds);
      const candidateById = new Map(candidates.map((question) => [question.id, question]));
      const selected = input.questionIds.flatMap((id) => {
        const question = candidateById.get(id);
        return question ? [question] : [];
      });
      if (selected.length !== questionCount) {
        return {
          error: "One or more selected questions do not match the chosen class, subject, chapters, topics, or type",
          status: 400,
        };
      }
      return { questions: selected, availableCount: candidates.length };
    }
    return {
      questions: selectRandomQuestions(candidates, questionCount),
      availableCount: candidates.length,
    };
  }

  const selectedIds = new Set(input.questionIds);
  if (input.type === QuestionType.CQ && selectedIds.size > 12) {
    return { error: "Creative-question papers can contain at most 12 questions", status: 400 };
  }
  if (selectedIds.size > 0) {
    const selectedClasses = await prisma.question.findMany({
      where: { id: { in: [...selectedIds] }, ...questionAccessFilter(request) },
      select: { id: true, classLevel: true, subject: true },
    });
    const classError = classSelectionError(selectedClasses, selectedIds.size);
    if (classError?.includes("different classes")) {
      return { error: classError, status: 400 };
    }
  }
  const selected = candidates.filter((question) => selectedIds.has(question.id));
  if (selected.length !== selectedIds.size) {
    return { error: "One or more selected questions do not match the chosen class, subject, chapters, topics, or type", status: 400 as const };
  }
  return { questions: selected, candidates, availableCount: candidates.length };
}

router.post("/preview", async (request, response) => {
  const input = generatedPaperSchema.parse(request.body);
  const selection = await getSelectedQuestions(request, input);
  if ("error" in selection) {
    response.status(selection.status).json({
      error: selection.error,
      ...("availableCount" in selection ? { availableCount: selection.availableCount } : {}),
      ...("setNumber" in selection ? { setNumber: selection.setNumber } : {}),
      ...("requestedCount" in selection ? { requestedCount: selection.requestedCount } : {}),
    });
    return;
  }
  const totalMarks = selection.questions.reduce((total, question) => total + question.marks, 0);
  const estimatedTokens = calculateTokenCost(selection.questions);
  const account = await prisma.user.findUnique({
    where: { id: request.user!.id },
    select: { tokenBalance: true },
  });
  response.json({
    questions: selection.questions.map((question) => ({
      ...question,
      ...(selection.setAssignments
        ? { setNumber: selection.setAssignments.find((assignment) => assignment.questionId === question.id)?.setNumber }
        : {}),
    })),
    ...("setAssignments" in selection ? { setAssignments: selection.setAssignments } : {}),
    ...("candidates" in selection ? { candidates: selection.candidates } : {}),
    availableCount: selection.availableCount,
    totalMarks,
    tokenRates,
    estimatedTokens,
    balance: account?.tokenBalance ?? 0,
    affordable: (account?.tokenBalance ?? 0) >= estimatedTokens,
  });
});

router.post("/generate", async (request, response) => {
  const input = generatedPaperSchema.parse(request.body);
  const selection = await getSelectedQuestions(request, input);
  if ("error" in selection) {
    response.status(selection.status).json({
      error: selection.error,
      ...("availableCount" in selection ? { availableCount: selection.availableCount } : {}),
      ...("setNumber" in selection ? { setNumber: selection.setNumber } : {}),
      ...("requestedCount" in selection ? { requestedCount: selection.requestedCount } : {}),
    });
    return;
  }
  if (input.mode === "manual" && selection.questions.length === 0) {
    response.status(400).json({ error: "Select at least one question before generating" });
    return;
  }

  const totalMarks = selection.questions.reduce((total, question) => total + question.marks, 0);
  if (totalMarks <= 0) {
    response.status(400).json({ error: "A generated paper must contain questions with positive marks" });
    return;
  }
  const charge = calculateTokenCost(selection.questions);
  if (!Number.isSafeInteger(charge) || charge > 2_147_483_647) {
    response.status(400).json({ error: "The paper token cost is too large" });
    return;
  }
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const previous = await prisma.tokenTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { paper: { include: { items: { orderBy: { position: "asc" }, include: { question: true } } } } },
  });
  if (previous) {
    if (previous.userId !== request.user!.id || previous.type !== TokenTransactionType.CHARGE ||
      previous.requestHash !== requestHash || !previous.paper) {
      response.status(409).json({ error: "This generation request key has already been used" });
      return;
    }
    response.json({
      paper: previous.paper,
      totalMarks: previous.paper.items.reduce((total, item) => total + item.question.marks, 0),
      chargedTokens: -previous.amount,
      balance: (await prisma.user.findUnique({ where: { id: request.user!.id }, select: { tokenBalance: true } }))?.tokenBalance ?? 0,
      duplicate: true,
    });
    return;
  }

  try {
    const generated = await prisma.$transaction(async (transaction) => {
      const balanceUpdate = await transaction.user.updateMany({
        where: { id: request.user!.id, tokenBalance: { gte: charge } },
        data: { tokenBalance: { decrement: charge } },
      });
      if (balanceUpdate.count !== 1) return null;

      const paper = await transaction.paper.create({
        data: {
          title: input.title,
          settings: {
            ...input.settings,
            questionType: input.type,
            marks: totalMarks,
            classLevel: input.classLevel,
            className: input.classLevel,
            subject: input.subject,
            chapter: input.chapters.join(", "),
            topic: input.topics.join(", "),
            ...(input.type === QuestionType.CQ ? {
              cqSetCount: input.cqSetCount ?? 0,
              cqSets: input.cqSets ?? [],
              cqSetAssignments: Object.fromEntries(
                (selection.setAssignments ?? []).map(({ questionId, setNumber }) => [questionId, setNumber]),
              ),
            } : {}),
          },
          ownerId: request.user!.id,
          items: { create: selection.questions.map((question, position) => ({ questionId: question.id, position })) },
        },
        include: { items: { orderBy: { position: "asc" }, include: { question: true } } },
      });
      await transaction.tokenTransaction.create({
        data: {
          userId: request.user!.id,
          paperId: paper.id,
          type: TokenTransactionType.CHARGE,
          amount: -charge,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      });
      const account = await transaction.user.findUniqueOrThrow({
        where: { id: request.user!.id },
        select: { tokenBalance: true },
      });
      return { paper, balance: account.tokenBalance };
    });

    if (!generated) {
      const account = await prisma.user.findUnique({
        where: { id: request.user!.id },
        select: { tokenBalance: true },
      });
      response.status(402).json({
        error: "Insufficient tokens to generate this paper",
        requiredTokens: charge,
        balance: account?.tokenBalance ?? 0,
      });
      return;
    }
    response.status(201).json({
      paper: generated.paper,
      totalMarks,
      chargedTokens: charge,
      balance: generated.balance,
      duplicate: false,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const retry = await prisma.tokenTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { paper: { include: { items: { orderBy: { position: "asc" }, include: { question: true } } } } },
      });
      if (retry?.userId === request.user!.id && retry.type === TokenTransactionType.CHARGE &&
        retry.requestHash === requestHash && retry.paper) {
        response.json({
          paper: retry.paper,
          totalMarks: retry.paper.items.reduce((total, item) => total + item.question.marks, 0),
          chargedTokens: -retry.amount,
          balance: (await prisma.user.findUnique({ where: { id: request.user!.id }, select: { tokenBalance: true } }))?.tokenBalance ?? 0,
          duplicate: true,
        });
        return;
      }
    }
    throw error;
  }
});

router.get("/", async (request, response) => {
  const papers = await prisma.paper.findMany({
    where: ownerFilter(request),
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { items: true } } },
  });
  response.json({ papers });
});

router.get("/settings", async (request, response) => {
  const papers = await prisma.paper.findMany({
    where: { ownerId: request.user!.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, settings: true },
  });
  const settings: Record<PaperQuestionType, { id: string; title: string; settings: Prisma.JsonValue } | null> = {
    [QuestionType.MCQ]: null,
    [QuestionType.CQ]: null,
    [QuestionType.SHORT]: null,
  };
  for (const paper of papers) {
    const questionType = storedQuestionType(paper.settings);
    if (
      questionType !== null && settings[questionType] === null
    ) {
      settings[questionType] = {
        id: paper.id,
        title: paper.title,
        settings: paper.settings,
      };
    }
  }
  response.json({ settings });
});

router.post("/settings", async (request, response) => {
  const input = settingsOnlySchema.parse(request.body);
  const savedPapers = await prisma.paper.findMany({
    where: { ownerId: request.user!.id, items: { none: {} } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, settings: true },
  });
  const existing = savedPapers.find(({ settings }) => storedQuestionType(settings) === input.settings.questionType);
  const paper = existing
    ? await prisma.paper.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        settings: input.settings as Prisma.InputJsonObject,
      },
    })
    : await prisma.paper.create({
      data: {
        title: input.title,
        settings: input.settings as Prisma.InputJsonObject,
        ownerId: request.user!.id,
      },
    });
  response.status(existing ? 200 : 201).json({ paper });
});

router.put("/:id/settings", async (request, response) => {
  const input = settingsOnlySchema.parse(request.body);
  const existing = await prisma.paper.findFirst({
    where: { id: request.params.id, ownerId: request.user!.id },
    select: { id: true },
  });
  if (!existing) {
    response.status(404).json({ error: "Paper not found" });
    return;
  }
  const paper = await prisma.paper.update({
    where: { id: existing.id },
    data: {
      title: input.title,
      settings: input.settings as Prisma.InputJsonObject,
    },
  });
  response.json({ paper });
});

router.get("/:id", async (request, response) => {
  const paper = await prisma.paper.findFirst({
    where: { id: request.params.id, ...ownerFilter(request) },
    include: { items: { orderBy: { position: "asc" }, include: { question: true } } },
  });
  if (!paper) {
    response.status(404).json({ error: "Paper not found" });
    return;
  }
  response.json({ paper });
});

router.post("/", async (request, response) => {
  const input = paperSchema.parse(request.body);
  const available = await prisma.question.findMany({
    where: {
      id: { in: input.questionIds },
      ...questionAccessFilter(request),
    },
    select: { id: true, classLevel: true, subject: true },
  });
  const classError = classSelectionError(available, input.questionIds.length);
  if (classError) {
    response.status(400).json({ error: classError });
    return;
  }
  const paper = await prisma.paper.create({
    data: {
      title: input.title,
      settings: input.settings as Prisma.InputJsonObject,
      ownerId: request.user!.id,
      items: { create: input.questionIds.map((questionId, position) => ({ questionId, position })) },
    },
    include: { items: { orderBy: { position: "asc" } } },
  });
  response.status(201).json({ paper });
});

router.put("/:id", async (request, response) => {
  const input = paperSchema.parse(request.body);
  const existing = await prisma.paper.findFirst({ where: { id: request.params.id, ...ownerFilter(request) }, select: { id: true } });
  if (!existing) {
    response.status(404).json({ error: "Paper not found" });
    return;
  }
  const available = await prisma.question.findMany({
    where: {
      id: { in: input.questionIds },
      ...questionAccessFilter(request),
    },
    select: { id: true, classLevel: true, subject: true },
  });
  const classError = classSelectionError(available, input.questionIds.length);
  if (classError) {
    response.status(400).json({ error: classError });
    return;
  }
  const paper = await prisma.$transaction(async (transaction) => {
    await transaction.paperItem.deleteMany({ where: { paperId: existing.id } });
    return transaction.paper.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        settings: input.settings as Prisma.InputJsonObject,
        items: { create: input.questionIds.map((questionId, position) => ({ questionId, position })) },
      },
      include: { items: { orderBy: { position: "asc" } } },
    });
  });
  response.json({ paper });
});

router.delete("/:id", async (request, response) => {
  const result = await prisma.paper.deleteMany({ where: { id: request.params.id, ...ownerFilter(request) } });
  if (result.count === 0) {
    response.status(404).json({ error: "Paper not found" });
    return;
  }
  response.status(204).end();
});

export default router;