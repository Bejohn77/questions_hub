import { Router, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { authenticate } from "../middleware/auth";
import { passwordResetMailer } from "../password-reset-mailer";

const router = Router();
const credentialsSchema = z.object({
  email: z.string().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
});
const strongPasswordSchema = z.string().min(12).max(128);
const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(120),
  password: strongPasswordSchema,
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: strongPasswordSchema,
});
const forgotPasswordSchema = z.object({
  email: z.string().email().max(254).transform((email) => email.toLowerCase()),
});
const resetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: strongPasswordSchema,
});
const createResetLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const forgotPasswordLimiter = createResetLimiter();
const resetPasswordLimiter = createResetLimiter();
const resetTokenLifetimeMs = 30 * 60 * 1000;

function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function setSession(response: Response, user: { id: string }) {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const token = jwt.sign({}, config.jwtSecret, { subject: user.id, jwtid: jti, expiresIn: "8h" });
  await prisma.authSession.create({ data: { id: jti, userId: user.id, expiresAt } });
  response.cookie("session", token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });
}

router.post("/register", async (request, response) => {
  const input = registrationSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.user.create({
    data: { email: input.email, name: input.name, passwordHash },
    select: { id: true, email: true, name: true, role: true, mustChangePassword: true },
  });
  await setSession(response, user);
  response.status(201).json({ user });
});

async function login(request: import("express").Request, response: Response, adminOnly = false) {
  const input = credentialsSchema.parse(request.body);
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      role: true,
      mustChangePassword: true,
    },
  });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    response.status(401).json({ error: "Email or password is incorrect" });
    return;
  }
  if (adminOnly && user.role !== "ADMIN") {
    response.status(403).json({ error: "Administrator access required" });
    return;
  }
  await setSession(response, user);
  response.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
  });
}

router.post("/login", async (request, response) => {
  await login(request, response);
});

router.post("/admin-login", async (request, response) => {
  await login(request, response, true);
});

router.post("/logout", async (request, response) => {
  const authorization = request.header("authorization");
  const token = request.cookies?.session ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
  if (token) {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (error) {
      if (!(error instanceof jwt.JsonWebTokenError)) throw error;
      payload = "";
    }
    if (typeof payload !== "string" && payload.jti && payload.sub) {
      await prisma.authSession.deleteMany({
        where: { id: payload.jti, userId: payload.sub },
      });
    }
  }
  response.clearCookie("session", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/" });
  response.status(204).end();
});

router.post("/forgot-password", forgotPasswordLimiter, async (request, response) => {
  const { email } = forgotPasswordSchema.parse(request.body);
  if (!passwordResetMailer.isConfigured()) {
    response.status(503).json({ error: "Password reset is temporarily unavailable" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (user) {
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + resetTokenLifetimeMs);
    await prisma.$transaction(async (transaction) => {
      await transaction.passwordResetToken.upsert({
        where: { userId: user.id },
        update: { tokenHash, expiresAt, usedAt: null },
        create: { userId: user.id, tokenHash, expiresAt },
      });
    });
    const resetUrl = `${config.webOrigin.replace(/\/$/, "")}/reset-password?token=${token}`;
    try {
      await passwordResetMailer.send(user.email, resetUrl);
    } catch (error) {
      await prisma.passwordResetToken.deleteMany({ where: { tokenHash } });
      console.error("Password reset email delivery failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  response.status(202).json({
    message: "If an account exists for that email, password reset instructions will be sent.",
  });
});

router.post("/reset-password", resetPasswordLimiter, async (request, response) => {
  const { token, password } = resetPasswordSchema.parse(request.body);
  const tokenHash = hashResetToken(token);
  const resetRecord = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true, expiresAt: true, usedAt: true },
  });
  const now = new Date();
  if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt <= now) {
    response.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const consumedAt = new Date();
  const consumed = await prisma.$transaction(async (transaction) => {
    const result = await transaction.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: consumedAt } },
      data: { usedAt: consumedAt },
    });
    if (result.count !== 1) return false;
    await transaction.user.update({
      where: { id: resetRecord.userId },
      data: { passwordHash },
    });
    await transaction.authSession.deleteMany({ where: { userId: resetRecord.userId } });
    return true;
  });
  if (!consumed) {
    response.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  response.clearCookie("session", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/" });
  response.json({ message: "Password reset successfully. Please sign in with your new password." });
});

router.get("/me", authenticate, async (request, response) => {
  response.json({ user: request.user });
});

router.post("/change-password", authenticate, async (request, response) => {
  const input = changePasswordSchema.parse(request.body);
  const user = await prisma.user.findUnique({
    where: { id: request.user!.id },
    select: { id: true, passwordHash: true },
  });
  if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    response.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    await transaction.authSession.deleteMany({
      where: { userId: user.id, id: { not: request.sessionId } },
    });
  });
  response.json({ message: "Password changed successfully" });
});

export default router;