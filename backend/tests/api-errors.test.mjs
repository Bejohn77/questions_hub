import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test-password@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const [{ default: express }, { apiErrorHandler }, { createApiRateLimiter, createAuthRateLimiter }, { default: authRouter }] = await Promise.all([
  import("express"),
  import("../src/middleware/api-error.ts"),
  import("../src/middleware/api-rate-limits.ts"),
  import("../src/routes/auth.ts"),
]);

async function serve(app, t) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("API error middleware returns JSON statuses and logs sanitized server errors", async (t) => {
  const app = express();
  app.use(express.json());
  app.get("/failure", async () => {
    throw new Error(`Database unavailable at ${process.env.DATABASE_URL}`);
  });
  app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  app.use(apiErrorHandler);
  const origin = await serve(app, t);
  const originalError = console.error;
  const logs = [];
  console.error = (message) => logs.push(String(message));
  t.after(() => { console.error = originalError; });

  const invalidJson = await fetch(`${origin}/invalid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.match(invalidJson.headers.get("content-type") ?? "", /application\/json/i);
  assert.deepEqual(await invalidJson.json(), { error: "Invalid JSON request body" });

  const missing = await fetch(`${origin}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found" });

  const failure = await fetch(`${origin}/failure`);
  assert.equal(failure.status, 500);
  assert.match(failure.headers.get("content-type") ?? "", /application\/json/i);
  assert.deepEqual(await failure.json(), { error: "Internal server error" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"event":"api_request_failed"/);
  assert.match(logs[0], /"path":"\/failure"/);
  assert.doesNotMatch(logs[0], /test-password/);
});

test("login and registration validation failures return JSON 400 responses", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use(apiErrorHandler);
  const origin = await serve(app, t);

  for (const endpoint of ["login", "register"]) {
    const response = await fetch(`${origin}/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400, `${endpoint} should reject missing credentials`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal((await response.json()).error, "Invalid request");
  }
});

test("auth rate limiting allows session verification while limiting login attempts", async (t) => {
  const app = express();
  app.use("/api", createApiRateLimiter());
  app.use("/api/auth", createAuthRateLimiter());
  app.get("/api/auth/me", (_request, response) => response.status(401).json({ error: "Authentication required" }));
  app.post("/api/auth/login", (_request, response) => response.status(401).json({ error: "Invalid credentials" }));
  const origin = await serve(app, t);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${origin}/api/auth/me`);
    assert.equal(response.status, 401, "session checks should not consume the login rate limit");
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${origin}/api/auth/login`, { method: "POST" });
    assert.equal(response.status, 401, "login attempts below the limit should reach the login handler");
  }

  const rateLimited = await fetch(`${origin}/api/auth/login`, { method: "POST" });
  assert.equal(rateLimited.status, 429, "excessive login attempts should remain rate-limited");

  let limitedOtherEndpoint;
  for (let attempt = 0; attempt < 181; attempt += 1) {
    limitedOtherEndpoint = await fetch(`${origin}/api/other`);
  }
  assert.equal(limitedOtherEndpoint.status, 429, "the general API rate limit should remain in effect");
});
