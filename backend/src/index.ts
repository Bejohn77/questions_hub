import { mkdirSync } from "node:fs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { config } from "./config";
import { prisma } from "./db";
import { apiErrorHandler } from "./middleware/api-error";
import { createApiRateLimiter, createAuthRateLimiter } from "./middleware/api-rate-limits";
import authRouter from "./routes/auth";
import adminQuestionsRouter from "./routes/admin-questions";
import papersRouter from "./routes/papers";
import paymentRouter from "./routes/payments";
import plansRouter from "./routes/plans";
import questionsRouter from "./routes/questions";
import tokensRouter from "./routes/tokens";
import uploadsRouter from "./routes/uploads";

mkdirSync(config.uploadDirectory, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(cors({ origin: config.webOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
app.use("/api", createApiRateLimiter());
app.use("/api/auth", createAuthRateLimiter());

app.use((request, response, next) => {
  if (process.env.NODE_ENV !== "development" || !request.path.startsWith("/api/")) {
    next();
    return;
  }
  const startedAt = performance.now();
  response.once("finish", () => {
    console.info(JSON.stringify({
      event: "api_request_completed",
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  });
  next();
});

app.use("/api/payments", paymentRouter);
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());

const healthCheck: express.RequestHandler = async (_request, response) => {
  await prisma.$queryRaw`SELECT 1`;
  response.json({ status: "ok", database: "ok" });
};
app.get("/health", healthCheck);
app.get("/api/health", healthCheck);
app.use("/api/auth", authRouter);
app.use("/api/admin/questions", adminQuestionsRouter);
app.use("/api/questions", questionsRouter);
app.use("/api/papers", papersRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/plans", plansRouter);
app.use("/api/tokens", tokensRouter);

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use(apiErrorHandler);

async function startServer() {
  try {
    await prisma.$connect();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
    console.error(JSON.stringify({
      event: "database_connection_failed_at_startup",
      name: error instanceof Error ? error.name : "UnknownError",
      code,
    }));
    process.exitCode = 1;
    return;
  }

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`API listening on port ${config.port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    }));
  }
}

void startServer();