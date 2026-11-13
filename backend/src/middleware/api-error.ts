import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { config } from "../config";

function safeLogValue(value: string) {
  const secrets = [
    config.databaseUrl,
    config.jwtSecret,
    config.smtpPassword,
    config.supabaseServiceRoleKey,
    config.paymentWebhookSecret,
    process.env.ADMIN_PASSWORD,
  ].filter((secret): secret is string => Boolean(secret));
  return secrets.reduce(
    (result, secret) => result.replaceAll(secret, "[REDACTED]"),
    value,
  ).replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

export const apiErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  let status = 500;
  let body: Record<string, unknown> = { error: "Internal server error" };

  if (error instanceof ZodError) {
    status = 400;
    body = { error: "Invalid request", issues: error.issues };
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      status = 409;
      body = { error: "A record with those values already exists" };
    } else if (error.code === "P2003" || error.code === "P2025") {
      status = 400;
      body = { error: "The requested record could not be changed" };
    }
  } else if (error instanceof multer.MulterError) {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    body = { error: "Upload rejected", detail: error.message };
  } else if (
    error instanceof SyntaxError
    && "type" in error
    && error.type === "entity.parse.failed"
  ) {
    status = 400;
    body = { error: "Invalid JSON request body" };
  } else if (error && typeof error === "object" && "status" in error) {
    const errorStatus = Number(error.status);
    if (Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 500) {
      status = errorStatus;
      body = { error: errorStatus === 413 ? "Request body is too large" : "Invalid request" };
    }
  }

  if (status >= 500) {
    const loggedError = error instanceof Error ? error : new Error(String(error));
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
    console.error(JSON.stringify({
      event: "api_request_failed",
      method: request.method,
      path: request.path,
      name: loggedError.name,
      code,
      message: safeLogValue(loggedError.message),
      stack: loggedError.stack ? safeLogValue(loggedError.stack) : undefined,
    }));
  }

  response.status(status).json(body);
};
