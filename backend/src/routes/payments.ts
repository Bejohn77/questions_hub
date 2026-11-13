import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";

const router = Router();
const paymentSchema = z.object({
  reference: z.string().min(8).max(160),
  userId: z.string().min(1).max(64),
  planCode: z.string().min(2).max(40),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  status: z.literal("paid"),
});

router.post("/webhook", raw({ type: "application/json", limit: "64kb" }), async (request, response) => {
  if (!config.paymentWebhookSecret) {
    response.status(503).json({ error: "Payment verification is not configured" });
    return;
  }
  const signature = request.header("x-payment-signature") ?? "";
  if (!/^[a-f\d]{64}$/i.test(signature)) {
    response.status(401).json({ error: "Invalid payment signature" });
    return;
  }
  const expected = createHmac("sha256", config.paymentWebhookSecret).update(request.body as Buffer).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    response.status(401).json({ error: "Invalid payment signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse((request.body as Buffer).toString("utf8"));
  } catch {
    response.status(400).json({ error: "Invalid JSON event" });
    return;
  }
  const parsed = paymentSchema.safeParse(payload);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid payment event" });
    return;
  }

  const event = parsed.data;
  const existing = await prisma.paymentEvent.findUnique({
    where: { providerReference: event.reference },
    select: { userId: true, planId: true, amountMinor: true, currency: true, status: true },
  });
  if (existing) {
    const samePayment = existing.userId === event.userId
      && existing.amountMinor === event.amountMinor
      && existing.currency === event.currency
      && existing.status === event.status.toUpperCase();
    if (!samePayment) {
      response.status(409).json({ error: "Payment reference conflicts with an existing event" });
      return;
    }
    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: event.planCode }, select: { id: true } });
    if (!plan || plan.id !== existing.planId) {
      response.status(409).json({ error: "Payment reference conflicts with an existing event" });
      return;
    }
    response.status(200).json({ received: true, duplicate: true });
    return;
  }
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: event.planCode } });
  if (!plan || !plan.active || plan.priceMinor !== event.amountMinor || plan.currency !== event.currency) {
    response.status(400).json({ error: "Payment does not match an active plan" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: event.userId }, select: { id: true } });
  if (!user) {
    response.status(400).json({ error: "Payment user was not found" });
    return;
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      const previous = await transaction.paymentEvent.findUnique({
        where: { providerReference: event.reference },
        select: { userId: true, planId: true, amountMinor: true, currency: true, status: true },
      });
      if (previous) {
        return previous.userId === user.id
          && previous.planId === plan.id
          && previous.amountMinor === event.amountMinor
          && previous.currency === event.currency
          && previous.status === event.status.toUpperCase()
          ? "duplicate"
          : "conflict";
      }

      await transaction.paymentEvent.create({
        data: {
          providerReference: event.reference,
          userId: user.id,
          planId: plan.id,
          amountMinor: event.amountMinor,
          currency: event.currency,
          status: event.status.toUpperCase(),
        },
      });
      const current = await transaction.subscription.findUnique({ where: { userId: user.id } });
      const now = new Date();
      const startsAt = current?.status === "ACTIVE" && current.endsAt > now ? current.endsAt : now;
      const endsAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
      await transaction.subscription.upsert({
        where: { userId: user.id },
        create: { userId: user.id, planId: plan.id, status: "ACTIVE", startsAt, endsAt },
        update: { planId: plan.id, status: "ACTIVE", startsAt, endsAt },
      });
      return "processed";
    });
    if (result === "conflict") {
      response.status(409).json({ error: "Payment reference conflicts with an existing event" });
      return;
    }
    response.status(200).json({ received: true, ...(result === "duplicate" ? { duplicate: true } : {}) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      const duplicate = await prisma.paymentEvent.findUnique({
        where: { providerReference: event.reference },
        select: { userId: true, planId: true, amountMinor: true, currency: true, status: true },
      });
      if (duplicate) {
        const samePayment = duplicate.userId === user.id
          && duplicate.planId === plan.id
          && duplicate.amountMinor === event.amountMinor
          && duplicate.currency === event.currency
          && duplicate.status === event.status.toUpperCase();
        if (samePayment) {
          response.status(200).json({ received: true, duplicate: true });
        } else {
          response.status(409).json({ error: "Payment reference conflicts with an existing event" });
        }
        return;
      }
    }
    throw error;
  }
});

export default router;