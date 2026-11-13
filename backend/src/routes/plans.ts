import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { authenticate, requireAdmin, requirePasswordChanged } from "../middleware/auth";

const router = Router();

router.get("/", async (_request, response) => {
  const plans = await prisma.subscriptionPlan.findMany({ where: { active: true }, orderBy: { priceMinor: "asc" }, select: { code: true, name: true, priceMinor: true, currency: true, durationDays: true } });
  response.json({ plans });
});

router.get("/subscription", authenticate, requirePasswordChanged, async (request, response) => {
  const subscription = await prisma.subscription.findUnique({ where: { userId: request.user!.id }, include: { plan: true } });
  response.json({ subscription });
});

router.post("/", authenticate, requirePasswordChanged, requireAdmin, async (request, response) => {
  const input = z.object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().trim().min(2).max(120),
    priceMinor: z.number().int().positive().max(100_000_000),
    currency: z.string().length(3).toUpperCase().default("BDT"),
    durationDays: z.number().int().positive().max(3650),
    active: z.boolean().default(true),
  }).parse(request.body);
  const plan = await prisma.subscriptionPlan.upsert({ where: { code: input.code }, create: input, update: input });
  response.status(201).json({ plan });
});

export default router;