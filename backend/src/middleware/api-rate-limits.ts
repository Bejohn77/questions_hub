import { rateLimit } from "express-rate-limit";

export function createApiRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (request) => request.method === "GET" && request.path === "/auth/me",
  });
}

export function createAuthRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (request) => request.method === "GET" && request.path === "/me",
  });
}
