import { createHash } from "node:crypto";
import { Prisma, TokenTransactionType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { authenticate, requireAdmin, requirePasswordChanged } from "../middleware/auth";
import { tokenRates } from "../token-pricing";

const router = Router();
router.use(authenticate, requirePasswordChanged);

router.get("/", async (request, response) => {
  const [account, transactions] = await prisma.$transaction([
    prisma.user.findUnique({
      where: { id: request.user!.id },
      select: { tokenBalance: true },
    }),
    prisma.tokenTransaction.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { type: true, amount: true, createdAt: true, paper: { select: { title: true } } },
    }),
  ]);
  response.json({
    balance: account?.tokenBalance ?? 0,
    tokenRates,
    transactions,
  });
});

router.post("/grant", requireAdmin, async (request, response) => {
  const input = z.object({
    email: z.string().email().max(254).transform((email) => email.toLowerCase()),
    amount: z.number().int().min(1).max(1_000_000),
    idempotencyKey: z.string().uuid(),
  }).parse(request.body);
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const previous = await prisma.tokenTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { userId: true, administeredBy: true, type: true, requestHash: true },
  });
  if (previous) {
    if (previous.administeredBy !== request.user!.id || previous.type !== TokenTransactionType.GRANT ||
      previous.requestHash !== requestHash) {
      response.status(409).json({ error: "This token-grant request key has already been used" });
      return;
    }
    const account = await prisma.user.findUnique({ where: { id: previous.userId }, select: { tokenBalance: true } });
    response.json({ balance: account?.tokenBalance ?? 0, duplicate: true });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (!user) {
    response.status(404).json({ error: "Account not found" });
    return;
  }

  try {
    const balance = await prisma.$transaction(async (transaction) => {
      const account = await transaction.user.update({
        where: { id: user.id },
        data: { tokenBalance: { increment: input.amount } },
        select: { tokenBalance: true },
      });
      await transaction.tokenTransaction.create({
        data: {
          userId: user.id,
          administeredBy: request.user!.id,
          type: TokenTransactionType.GRANT,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      });
      return account.tokenBalance;
    });
    response.status(201).json({ balance, duplicate: false });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "This token-grant request key has already been used" });
      return;
    }
    throw error;
  }
});

export default router;
