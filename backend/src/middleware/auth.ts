import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config";
import { prisma } from "../db";

export async function authenticate(request: Request, response: Response, next: NextFunction) {
  const authorization = request.header("authorization");
  const token = request.cookies?.session ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
  if (!token) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    response.status(401).json({ error: "Invalid or expired session" });
    return;
  }
  if (typeof payload === "string" || !payload.sub || !payload.jti) {
    response.status(401).json({ error: "Invalid session" });
    return;
  }
  const isSessionVerification = request.method === "GET" && request.path === "/me";
  const lookupStartedAt = isSessionVerification ? performance.now() : 0;
  const sessionLookup = prisma.authSession.findUnique({
    where: { id: payload.jti },
    select: {
      userId: true,
      expiresAt: true,
      user: {
        select: { id: true, email: true, name: true, role: true, mustChangePassword: true },
      },
    },
  });
  const session = await sessionLookup.catch((error: unknown) => {
    if (isSessionVerification && config.nodeEnv === "development") {
      console.info(JSON.stringify({
        event: "auth_session_lookup_failed",
        error: error && typeof error === "object" && "code" in error ? String(error.code) : "UnknownError",
        durationMs: Math.round(performance.now() - lookupStartedAt),
      }));
    }
    throw error;
  });
  if (isSessionVerification && config.nodeEnv === "development") {
    console.info(JSON.stringify({
      event: "auth_session_lookup_completed",
      sessionFound: Boolean(session),
      durationMs: Math.round(performance.now() - lookupStartedAt),
    }));
  }
  if (!session || session.userId !== payload.sub || session.expiresAt <= new Date()) {
    response.status(401).json({ error: "Invalid or expired session" });
    return;
  }
  if (session.user.id !== payload.sub) {
    response.status(401).json({ error: "Invalid session" });
    return;
  }
  request.user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    mustChangePassword: session.user.mustChangePassword,
  };
  request.sessionId = payload.jti;
  next();
}

export function requirePasswordChanged(request: Request, response: Response, next: NextFunction) {
  if (request.user?.mustChangePassword) {
    response.status(403).json({
      error: "Change your temporary password before continuing",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return;
  }
  next();
}

export function requireAdmin(request: Request, response: Response, next: NextFunction) {
  if (request.user?.role !== "ADMIN") {
    response.status(403).json({ error: "Administrator access required" });
    return;
  }
  next();
}