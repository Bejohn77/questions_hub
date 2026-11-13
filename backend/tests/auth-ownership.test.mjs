import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.SMTP_HOST ??= "smtp.example.test";
process.env.SMTP_PORT ??= "587";
process.env.SMTP_USER ??= "test-user";
process.env.SMTP_PASSWORD ??= "test-password";
process.env.SMTP_FROM ??= "noreply@example.test";
const testUploadDirectory = process.env.UPLOAD_DIR ? null : await mkdtemp(path.join(tmpdir(), "paper-maker-upload-tests-"));
process.env.UPLOAD_DIR ??= testUploadDirectory;
after(async () => {
  if (testUploadDirectory) await rm(testUploadDirectory, { recursive: true, force: true });
});

const [{ default: express }, { default: cookieParser }, { default: bcrypt }, { default: jwt }, { prisma }, { config }, { default: authRouter }, { default: questionsRouter }, { default: papersRouter }, { default: uploadsRouter }, { passwordResetMailer }] = await Promise.all([
  import("express"),
  import("cookie-parser"),
  import("bcryptjs"),
  import("jsonwebtoken"),
  import("../src/db.ts"),
  import("../src/config.ts"),
  import("../src/routes/auth.ts"),
  import("../src/routes/questions.ts"),
  import("../src/routes/papers.ts"),
  import("../src/routes/uploads.ts"),
  import("../src/password-reset-mailer.ts"),
]);
const [{ default: adminQuestionsRouter }, { default: tokensRouter }] = await Promise.all([
  import("../src/routes/admin-questions.ts"),
  import("../src/routes/tokens.ts"),
]);

const users = new Map([
  ["teacher-1", { id: "teacher-1", email: "teacher@example.com", name: "Teacher One", role: "TEACHER" }],
  ["teacher-2", { id: "teacher-2", email: "other@example.com", name: "Teacher Two", role: "TEACHER" }],
  ["admin-1", { id: "admin-1", email: "admin@example.com", name: "Administrator", role: "ADMIN" }],
]);
const activeSessions = new Map();

function createImageOnlyPdf() {
  const content = "q 20 0 0 20 50 650 cm /Im0 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([
      Buffer.from("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n"),
      Buffer.from([255, 0, 0]),
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) chunks.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return Buffer.concat(chunks);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api/admin/questions", adminQuestionsRouter);
  app.use("/api/questions", questionsRouter);
  app.use("/api/papers", papersRouter);
  app.use("/api/tokens", tokensRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use((error, _request, response, _next) => {
    const status = Number(error.status);
    response.status(Number.isInteger(status) && status >= 400 && status < 500
      ? status
      : error.name === "ZodError" ? 400 : 500).json({ error: error.message });
  });
  return app;
}

async function serve(t) {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function sessionCookie(userId) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  activeSessions.set(id, { userId, expiresAt });
  const token = jwt.sign({}, config.jwtSecret, { subject: userId, jwtid: id, expiresIn: "8h" });
  return `session=${token}`;
}

function stub(t, target, methodName, implementation) {
  const original = target[methodName];
  target[methodName] = implementation;
  t.after(() => {
    target[methodName] = original;
  });
}

function mockAcademicEntries(initial = []) {
  const entries = [...initial];
  return {
    entries,
    findFirst: async ({ where }) => entries.find((entry) => {
      const expectedName = typeof where.name === "string" ? where.name : where.name?.equals;
      if (entry.type !== where.type || entry.name.toLowerCase() !== expectedName.toLowerCase()) return false;
      if ("parentId" in where) return entry.parentId === (where.parentId ?? null);
      if (where.parent) {
        const parent = entries.find(({ id }) => id === entry.parentId);
        return parent?.type === where.parent.type && parent.parentId === where.parent.parentId;
      }
      return true;
    }) ?? null,
    create: async ({ data }) => {
      const entry = { id: `academic-${entries.length + 1}`, ...data, parentId: data.parentId ?? null };
      entries.push(entry);
      return entry;
    },
  };
}

function mockUserLookup(t, lookup = (idOrEmail) => users.get(idOrEmail) ?? null) {
  stub(t, prisma.user, "findUnique", async ({ where }) => lookup(where.id ?? where.email));
  stub(t, prisma.authSession, "findUnique", async ({ where }) => {
    const session = activeSessions.get(where.id);
    if (!session) return null;
    const user = lookup(session.userId);
    return user ? { ...session, user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    } } : null;
  });
}

function resetTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

const baseQuestion = {
  classLevel: "Class 9",
  group: "Science",
  subject: "Physics",
  chapter: "Motion",
  topic: "Speed",
  marks: 1,
};

test("registration and login issue HttpOnly sessions; /me recognizes valid sessions and logout revokes them", async (t) => {
  const password = "Correct-Horse-Battery-42";
  const passwordHash = await bcrypt.hash(password, 4);
  const registeredUser = {
    id: "teacher-1",
    email: "teacher@example.com",
    name: "Teacher One",
    role: "TEACHER",
    passwordHash,
  };
  mockUserLookup(t, (idOrEmail) => idOrEmail === registeredUser.id || idOrEmail === registeredUser.email
    ? registeredUser
    : null);
  stub(t, prisma.user, "create", async ({ data }) => ({ ...registeredUser, ...data, id: registeredUser.id }));
  stub(t, prisma.authSession, "create", async ({ data }) => {
    activeSessions.set(data.id, { userId: data.userId, expiresAt: data.expiresAt });
    return data;
  });
  stub(t, prisma.authSession, "deleteMany", async ({ where }) => {
    const session = activeSessions.get(where.id);
    const deleted = Boolean(session && session.userId === where.userId);
    if (deleted) activeSessions.delete(where.id);
    return { count: Number(deleted) };
  });
  const origin = await serve(t);

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredUser.email, name: registeredUser.name, password }),
  });
  assert.equal(registered.status, 201);
  assert.match(registered.headers.get("set-cookie") ?? "", /HttpOnly/i);
  assert.equal((await registered.json()).user.role, "TEACHER");

  const unauthenticated = await fetch(`${origin}/api/auth/me`);
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredUser.email, password }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^session=/);

  const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, {
    id: registeredUser.id,
    email: registeredUser.email,
    name: registeredUser.name,
    role: "TEACHER",
    mustChangePassword: false,
  });

  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /session=;/);
  const revokedSession = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
  assert.equal(revokedSession.status, 401);

  const invalidPassword = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredUser.email, password: "Not-the-password-123" }),
  });
  assert.equal(invalidPassword.status, 401);
});

test("admin bootstrap credentials allow case-insensitive email login and require a forced password change", async (t) => {
  const temporaryPassword = "1234";
  const admin = {
    ...users.get("admin-1"),
    email: "admin@gmail.com",
    passwordHash: await bcrypt.hash(temporaryPassword, 4),
    mustChangePassword: true,
  };
  const teacher = {
    ...users.get("teacher-1"),
    passwordHash: await bcrypt.hash("Teacher-Strong-Password-42", 4),
    mustChangePassword: false,
  };
  mockUserLookup(t, (idOrEmail) => [admin, teacher].find((user) =>
    user.id === idOrEmail || user.email === idOrEmail) ?? null);
  stub(t, prisma.authSession, "create", async ({ data }) => {
    activeSessions.set(data.id, { userId: data.userId, expiresAt: data.expiresAt });
    return data;
  });
  stub(t, prisma.authSession, "deleteMany", async ({ where }) => {
    let count = 0;
    for (const [id, session] of activeSessions) {
      if (session.userId === where.userId && id !== where.id?.not) {
        activeSessions.delete(id);
        count += 1;
      }
    }
    return { count };
  });
  stub(t, prisma.user, "update", async ({ data }) => Object.assign(admin, data));
  stub(t, prisma.paper, "findMany", async () => []);
  stub(t, prisma, "$transaction", async (callback) => callback(prisma));
  const origin = await serve(t);

  const nonAdminLogin = await fetch(`${origin}/api/auth/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: teacher.email, password: "Teacher-Strong-Password-42" }),
  });
  assert.equal(nonAdminLogin.status, 403);

  const invalidPasswordLogin = await fetch(`${origin}/api/auth/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: admin.email, password: `${temporaryPassword}-invalid` }),
  });
  assert.equal(invalidPasswordLogin.status, 401);
  assert.deepEqual(await invalidPasswordLogin.json(), { error: "Email or password is incorrect" });

  const login = await fetch(`${origin}/api/auth/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ADMIN@gmail.com", password: temporaryPassword }),
  });
  assert.equal(login.status, 200);
  const { user } = await login.json();
  assert.equal(user.role, "ADMIN");
  assert.equal(user.mustChangePassword, true);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const blocked = await fetch(`${origin}/api/papers/settings`, { headers: { cookie } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "PASSWORD_CHANGE_REQUIRED");

  const weakPassword = await fetch(`${origin}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: "short" }),
  });
  assert.equal(weakPassword.status, 400);

  const change = await fetch(`${origin}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: "New-Admin-Password-42" }),
  });
  assert.equal(change.status, 200);
  assert.equal(admin.mustChangePassword, false);
  assert.notEqual(admin.passwordHash, temporaryPassword);

  const access = await fetch(`${origin}/api/papers/settings`, { headers: { cookie } });
  assert.equal(access.status, 200);
});

test("admin login rejects missing accounts without creating a session", async (t) => {
  let sessionCount = 0;
  mockUserLookup(t, () => null);
  stub(t, prisma.authSession, "create", async ({ data }) => {
    sessionCount += 1;
    return data;
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/auth/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "missing-admin@example.com", password: "Some-Password-123" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Email or password is incorrect" });
  assert.equal(sessionCount, 0);
});

test("forgot password gives a generic response and stores only an expiring token hash", async (t) => {
  const user = users.get("teacher-1");
  mockUserLookup(t, (idOrEmail) => idOrEmail === user.email ? user : null);
  const storedTokens = [];
  const delivered = [];
  stub(t, passwordResetMailer, "isConfigured", () => true);
  stub(t, passwordResetMailer, "send", async (recipient, resetUrl) => {
    delivered.push({ recipient, resetUrl });
  });
  stub(t, prisma, "$transaction", async (callback) => callback(prisma));
  stub(t, prisma.passwordResetToken, "upsert", async ({ where, update, create }) => {
    let data = storedTokens.find((item) => item.userId === where.userId);
    if (data) Object.assign(data, update);
    else {
      data = create;
      storedTokens.push(data);
    }
    return data;
  });

  const origin = await serve(t);
  const request = (email) => fetch(`${origin}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const known = await request(user.email);
  const knownBody = await known.json();
  assert.equal(known.status, 202);
  assert.equal(knownBody.message, "If an account exists for that email, password reset instructions will be sent.");
  assert.equal(storedTokens.length, 1);
  assert.equal(storedTokens[0].userId, user.id);
  assert.match(storedTokens[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.ok(storedTokens[0].expiresAt > new Date());
  assert.ok(storedTokens[0].expiresAt <= new Date(Date.now() + 30 * 60 * 1000));

  const rawToken = new URL(delivered[0].resetUrl).searchParams.get("token");
  assert.ok(rawToken);
  assert.notEqual(storedTokens[0].tokenHash, rawToken);
  assert.equal(storedTokens[0].tokenHash, resetTokenHash(rawToken));
  assert.equal(delivered[0].recipient, user.email);

  const unknown = await request("nobody@example.com");
  assert.equal(unknown.status, known.status);
  assert.deepEqual(await unknown.json(), knownBody);
  assert.equal(delivered.length, 1);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request(`unknown-${attempt}@example.com`)).status, 202);
  }
  assert.equal((await request("rate-limited@example.com")).status, 429);
});

test("password reset consumes a valid token once and revokes every user session", async (t) => {
  const user = users.get("teacher-1");
  user.passwordHash = await bcrypt.hash("Original-Password-42", 4);
  mockUserLookup(t);
  const ownCookie = sessionCookie("teacher-1");
  const anotherCookie = sessionCookie("teacher-1");
  const otherUserCookie = sessionCookie("teacher-2");
  const ownSession = jwt.decode(ownCookie.slice("session=".length));
  const anotherSession = jwt.decode(anotherCookie.slice("session=".length));
  const otherUserSession = jwt.decode(otherUserCookie.slice("session=".length));
  const token = "a".repeat(64);
  const tokenHash = resetTokenHash(token);
  const record = { userId: user.id, expiresAt: new Date(Date.now() + 60_000), usedAt: null };
  stub(t, prisma, "$transaction", async (callback) => callback(prisma));
  stub(t, prisma.passwordResetToken, "findUnique", async ({ where }) =>
    where.tokenHash === tokenHash ? record : null);
  stub(t, prisma.passwordResetToken, "updateMany", async ({ where, data }) => {
    if (where.tokenHash !== tokenHash || record.usedAt || record.expiresAt <= where.expiresAt.gt) return { count: 0 };
    record.usedAt = data.usedAt;
    return { count: 1 };
  });
  stub(t, prisma.user, "update", async ({ where, data }) => {
    const updatedUser = users.get(where.id);
    updatedUser.passwordHash = data.passwordHash;
    return updatedUser;
  });
  stub(t, prisma.authSession, "deleteMany", async ({ where }) => {
    let count = 0;
    for (const [id, session] of activeSessions) {
      if (session.userId === where.userId) {
        activeSessions.delete(id);
        count += 1;
      }
    }
    return { count };
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password: "Changed-Password-84" }),
  });
  assert.equal(response.status, 200);
  assert.equal(await bcrypt.compare("Changed-Password-84", user.passwordHash), true);
  assert.ok(record.usedAt);
  assert.equal(activeSessions.has(ownSession.jti), false);
  assert.equal(activeSessions.has(anotherSession.jti), false);
  assert.equal(activeSessions.has(otherUserSession.jti), true);
  const revokedSession = await fetch(`${origin}/api/auth/me`, { headers: { cookie: ownCookie } });
  assert.equal(revokedSession.status, 401);

  const reused = await fetch(`${origin}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password: "Changed-Password-99" }),
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "Invalid or expired reset token");
  assert.equal(await bcrypt.compare("Changed-Password-84", user.passwordHash), true);
});

test("password reset rejects expired and unknown tokens", async (t) => {
  mockUserLookup(t);
  const tokens = new Map([
    ["b".repeat(64), { userId: "teacher-1", expiresAt: new Date(Date.now() - 1), usedAt: null }],
  ]);
  stub(t, prisma.passwordResetToken, "findUnique", async ({ where }) =>
    tokens.get(where.tokenHash) ?? null);
  const origin = await serve(t);
  for (const token of ["b".repeat(64), "c".repeat(64)]) {
    const response = await fetch(`${origin}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "Valid-Password-123" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid or expired reset token");
  }
});

test("MCQ, CQ, and Short questions accept valid content while unsupported types are rejected", async (t) => {
  mockUserLookup(t);
  const created = [];
  stub(t, prisma.question, "create", async ({ data }) => {
    created.push(data);
    return { id: `question-${created.length}`, ...data };
  });
  const origin = await serve(t);
  const postQuestion = (question) => fetch(`${origin}/api/questions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie("teacher-1") },
    body: JSON.stringify(question),
  });

  const validMcq = await postQuestion({
    ...baseQuestion,
    type: "MCQ",
    content: { text: "Question?", options: ["Option A", "Option B"] },
  });
  assert.equal(validMcq.status, 201);

  const validCq = await postQuestion({
    ...baseQuestion,
    type: "CQ",
    content: { text: "Prompt", subs: ["Part A"] },
  });
  assert.equal(validCq.status, 201);

  const invalidMcq = await postQuestion({
    ...baseQuestion,
    type: "MCQ",
    content: { text: "Question?", options: ["Only one option"] },
  });
  assert.equal(invalidMcq.status, 400);

  const invalidCq = await postQuestion({
    ...baseQuestion,
    type: "CQ",
    content: { text: "Prompt", subs: [] },
  });
  assert.equal(invalidCq.status, 400);

  const validShort = await postQuestion({
    ...baseQuestion,
    type: "SHORT",
    content: { text: "Question?" },
  });
  assert.equal(validShort.status, 201);

  const unsupportedType = await postQuestion({
    ...baseQuestion,
    type: "CREATIVE",
    content: { text: "Question?" },
  });
  assert.equal(unsupportedType.status, 400);
  assert.deepEqual(created.map(({ type }) => type), ["MCQ", "CQ", "SHORT"]);
});

test("manual question creation charges atomically, rejects insufficient balances, and is idempotent", async (t) => {
  mockUserLookup(t);
  let balance = 6;
  let previousTransaction = null;
  let questionCreateCount = 0;
  stub(t, prisma.user, "findUnique", async ({ where }) => ({
    ...users.get(where.id),
    tokenBalance: balance,
  }));
  stub(t, prisma.tokenTransaction, "findUnique", async ({ where }) =>
    previousTransaction?.idempotencyKey === where.idempotencyKey ? previousTransaction : null);
  stub(t, prisma, "$transaction", async (callback) => callback({
    user: {
      updateMany: async ({ where, data }) => {
        if (balance < where.tokenBalance.gte) return { count: 0 };
        balance -= data.tokenBalance.decrement;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ tokenBalance: balance }),
    },
    question: {
      create: async ({ data }) => {
        questionCreateCount += 1;
        return { id: `manual-question-${questionCreateCount}`, ...data };
      },
    },
    questionImage: { updateMany: async () => ({ count: 0 }) },
    tokenTransaction: {
      create: async ({ data }) => {
        previousTransaction = {
          ...data,
          createdAt: new Date(),
          question: { id: `manual-question-${questionCreateCount}` },
        };
        return previousTransaction;
      },
    },
  }));
  const origin = await serve(t);
  const body = {
    ...baseQuestion,
    type: "MCQ",
    content: { text: "Question?", options: ["Option A", "Option B"] },
    idempotencyKey: randomUUID(),
  };
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  const created = await fetch(`${origin}/api/questions/manual-create`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.chargedTokens, 1);
  assert.equal(result.balance, 5);
  assert.equal(result.transaction.amount, -1);
  assert.equal(balance, 5);
  assert.equal(questionCreateCount, 1);

  const duplicate = await fetch(`${origin}/api/questions/manual-create`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(balance, 5);
  assert.equal(questionCreateCount, 1);

  const insufficient = await fetch(`${origin}/api/questions/manual-create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...baseQuestion,
      type: "CQ",
      content: { text: "Prompt", subs: ["Part A"] },
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(insufficient.status, 402);
  assert.equal((await insufficient.json()).requiredTokens, 10);
  assert.equal(balance, 5);
  assert.equal(questionCreateCount, 1);
});

test("MCQ/CQ constraints also apply when updating a question", async (t) => {
  mockUserLookup(t);
  const existing = {
    id: "owned-question",
    authorId: "teacher-1",
    ...baseQuestion,
    type: "MCQ",
    content: { text: "Question?", options: ["A", "B"] },
  };
  let updated = false;
  stub(t, prisma.question, "findFirst", async ({ where }) =>
    where.id === existing.id && where.authorId === "teacher-1" ? existing : null);
  stub(t, prisma.question, "updateMany", async () => {
    updated = true;
    return { count: 1 };
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/questions/${existing.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: sessionCookie("teacher-1") },
    body: JSON.stringify({ content: { text: "Updated question", options: ["Only one option"] } }),
  });
  assert.equal(response.status, 400);
  assert.equal(updated, false);
});

test("question and paper reads/deletes are scoped to the signed-in teacher", async (t) => {
  mockUserLookup(t);
  const questionFilters = [];
  const paperFilters = [];
  stub(t, prisma.question, "findMany", async ({ where }) => {
    questionFilters.push(where);
    return [];
  });
  stub(t, prisma.question, "deleteMany", async ({ where }) => {
    questionFilters.push(where);
    return { count: where.id === "owned-question" && where.authorId === "teacher-1" ? 1 : 0 };
  });
  stub(t, prisma.paper, "findFirst", async ({ where }) => {
    paperFilters.push(where);
    return null;
  });
  const origin = await serve(t);
  const headers = { cookie: sessionCookie("teacher-1") };

  const list = await fetch(`${origin}/api/questions`, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(questionFilters[0], {
    OR: [{ authorId: "teacher-1" }, { author: { role: "ADMIN" } }],
  });

  const deleteForeignQuestion = await fetch(`${origin}/api/questions/foreign-question`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteForeignQuestion.status, 404);
  assert.deepEqual(questionFilters[1], { id: "foreign-question", authorId: "teacher-1" });

  const deleteOwnedQuestion = await fetch(`${origin}/api/questions/owned-question`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteOwnedQuestion.status, 204);
  assert.deepEqual(questionFilters[2], { id: "owned-question", authorId: "teacher-1" });

  const readForeignPaper = await fetch(`${origin}/api/papers/foreign-paper`, { headers });
  assert.equal(readForeignPaper.status, 404);
  assert.deepEqual(paperFilters[0], { id: "foreign-paper", ownerId: "teacher-1" });
});

test("paper creation does not allow selecting another teacher's questions", async (t) => {
  mockUserLookup(t);
  let questionScope;
  let paperCreated = false;
  stub(t, prisma.question, "findMany", async ({ where }) => {
    questionScope = where;
    return [];
  });
  stub(t, prisma.paper, "create", async () => {
    paperCreated = true;
    return {};
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/papers`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie("teacher-1") },
    body: JSON.stringify({
      title: "Test paper",
      settings: {},
      questionIds: ["teacher-2-question"],
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(questionScope, {
    id: { in: ["teacher-2-question"] },
    OR: [{ authorId: "teacher-1" }, { author: { role: "ADMIN" } }],
  });
  assert.equal(paperCreated, false);
});

test("exam settings save creates an authenticated settings-only paper and updates only its settings", async (t) => {
  mockUserLookup(t);
  const savedPapers = new Map();
  const settings = {
    institution: "Test School",
    exam: "Term Examination",
    duration: "2 hours",
    marks: 100,
    instructions: "Answer all questions.",
    className: "Class 9",
    group: "Science",
    subject: "Physics",
    chapter: "Motion",
    topic: "Speed",
    fontSize: 10,
    margin: 12,
    columnGap: 8,
    lineSpacing: 1.55,
    showAnswers: false,
    questionType: "MCQ",
  };
  let createdData;
  let updatedData;
  let createCount = 0;
  stub(t, prisma.paper, "findMany", async ({ where }) => {
    if (where.items) {
      assert.deepEqual(where, { ownerId: "teacher-1", items: { none: {} } });
    } else {
      assert.deepEqual(where, { ownerId: "teacher-1" });
    }
    return Array.from(savedPapers.values())
      .filter(({ ownerId }) => ownerId === where.ownerId)
      .map(({ id, title, settings }) => ({ id, title, settings }));
  });
  stub(t, prisma.paper, "create", async ({ data }) => {
    createCount += 1;
    createdData = data;
    const paper = { id: "settings-paper", ...data, items: [] };
    savedPapers.set(paper.id, paper);
    return paper;
  });
  stub(t, prisma.paper, "findFirst", async ({ where }) => {
    const paper = savedPapers.get(where.id);
    return paper?.ownerId === where.ownerId ? { id: paper.id } : null;
  });
  stub(t, prisma.paper, "update", async ({ where, data }) => {
    updatedData = { where, data };
    const paper = savedPapers.get(where.id);
    Object.assign(paper, data);
    return paper;
  });
  const origin = await serve(t);
  const body = JSON.stringify({ title: settings.exam, settings });

  const unauthenticated = await fetch(`${origin}/api/papers/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(createdData, undefined);

  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };
  const created = await fetch(`${origin}/api/papers/settings`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(createdData, {
    title: settings.exam,
    settings,
    ownerId: "teacher-1",
  });
  assert.deepEqual((await created.json()).paper.items, []);

  const loaded = await fetch(`${origin}/api/papers/settings`, { headers });
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).settings.MCQ, {
    id: "settings-paper",
    title: settings.exam,
    settings,
  });

  const updatedSettings = { ...settings, exam: "Updated Examination", marks: 80 };
  const resaved = await fetch(`${origin}/api/papers/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: updatedSettings.exam, settings: updatedSettings }),
  });
  assert.equal(resaved.status, 200);
  assert.equal(createCount, 1, "saving settings again should update the existing settings record");
  assert.equal((await resaved.json()).paper.id, "settings-paper");

  const updated = await fetch(`${origin}/api/papers/settings-paper/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      title: "Updated Examination",
      settings: { ...settings, exam: "Updated Examination", marks: 80 },
    }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updatedData, {
    where: { id: "settings-paper" },
    data: {
      title: "Updated Examination",
      settings: { ...settings, exam: "Updated Examination", marks: 80 },
    },
  });
  assert.deepEqual((await updated.json()).paper.items, []);
});

test("saved exam settings are isolated to the signed-in user", async (t) => {
  mockUserLookup(t);
  stub(t, prisma.paper, "findMany", async ({ where }) => {
    assert.deepEqual(where, { ownerId: "teacher-1" });
    return [{
      ownerId: "another-teacher",
      id: "other-teacher-settings",
      title: "Other Teacher Exam",
      settings: { questionType: "MCQ", institution: "Private School" },
    }, {
      ownerId: "teacher-1",
      id: "owned-paper-with-questions",
      title: "My Exam",
      settings: { questionType: "MCQ", institution: "My School" },
    }].filter(({ ownerId }) => ownerId === where.ownerId);
  });
  const origin = await serve(t);
  const response = await fetch(`${origin}/api/papers/settings`, {
    headers: { cookie: sessionCookie("teacher-1") },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.settings.MCQ, {
    id: "owned-paper-with-questions",
    title: "My Exam",
    settings: { questionType: "MCQ", institution: "My School" },
  });
  assert.equal(data.settings.CQ, null);
});

test("exam settings save cannot update another teacher's paper", async (t) => {
  mockUserLookup(t);
  let updateCalled = false;
  stub(t, prisma.paper, "findFirst", async ({ where }) => {
    assert.deepEqual(where, { id: "foreign-paper", ownerId: "teacher-1" });
    return null;
  });
  stub(t, prisma.paper, "update", async () => {
    updateCalled = true;
    return {};
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/papers/foreign-paper/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: sessionCookie("teacher-1") },
    body: JSON.stringify({
      title: "Updated Examination",
      settings: {
        institution: "Test School",
        exam: "Updated Examination",
        duration: "2 hours",
        marks: 100,
        instructions: "Answer all questions.",
        className: "Class 9",
        group: "Science",
        subject: "Physics",
        chapter: "Motion",
        topic: "Speed",
        fontSize: 10,
        margin: 12,
        columnGap: 8,
        lineSpacing: 1.55,
        showAnswers: false,
        questionType: "MCQ",
      },
    }),
  });
  assert.equal(response.status, 404);
  assert.equal(updateCalled, false);
});

test("paper generation charges fixed per-question rates once and rejects insufficient token balances", async (t) => {
  mockUserLookup(t);
  let balance = 10;
  const questions = [
    { id: "generator-q1", type: "MCQ", classLevel: "Class 9", subject: "Physics", chapter: "Motion", topic: "", marks: 2, content: { text: "Question 1", options: ["A", "B"] } },
    { id: "generator-q2", type: "MCQ", classLevel: "Class 9", subject: "Physics", chapter: "Motion", topic: "Speed", marks: 3, content: { text: "Question 2", options: ["A", "B"] } },
  ];
  let previousTransaction = null;
  let paperCreateCount = 0;
  stub(t, prisma.user, "findUnique", async () => ({ ...users.get("teacher-1"), tokenBalance: balance }));
  stub(t, prisma.question, "findMany", async () => questions);
  stub(t, prisma.tokenTransaction, "findUnique", async () => previousTransaction);
  stub(t, prisma, "$transaction", async (callback) => callback({
    user: {
      updateMany: async ({ where, data }) => {
        if (balance < where.tokenBalance.gte) return { count: 0 };
        balance -= data.tokenBalance.decrement;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ tokenBalance: balance }),
    },
    paper: {
      create: async ({ data }) => {
        paperCreateCount += 1;
        const paper = {
          id: "generated-paper",
          title: data.title,
          settings: data.settings,
          ownerId: data.ownerId,
          items: data.items.create.map(({ questionId, position }) => ({
            questionId,
            position,
            question: questions.find(({ id }) => id === questionId),
          })),
        };
        return paper;
      },
    },
    tokenTransaction: {
      create: async ({ data }) => {
        previousTransaction = {
          ...data,
          paper: {
            id: "generated-paper",
            title: "Test paper",
            settings: {},
            ownerId: "teacher-1",
            items: questions.map((question, position) => ({ questionId: question.id, position, question })),
          },
        };
        return previousTransaction;
      },
    },
  }));
  const origin = await serve(t);
  const body = {
    title: "Generated paper",
    settings: { exam: "Generated paper" },
    classLevel: "Class 9",
    subject: "Physics",
    chapters: ["Motion"],
    topics: [],
    type: "MCQ",
    mode: "auto",
    questionCount: 2,
    idempotencyKey: randomUUID(),
  };
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  const preview = await fetch(`${origin}/api/papers/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).estimatedTokens, 2);
  assert.equal(balance, 10);
  assert.equal(paperCreateCount, 0);

  const generated = await fetch(`${origin}/api/papers/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(generated.status, 201);
  const result = await generated.json();
  assert.equal(result.totalMarks, 5);
  assert.equal(result.chargedTokens, 2);
  assert.equal(result.balance, 8);
  assert.equal(balance, 8);
  assert.equal(paperCreateCount, 1);

  const duplicate = await fetch(`${origin}/api/papers/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(balance, 8);
  assert.equal(paperCreateCount, 1);

  previousTransaction = null;
  balance = 1;
  const insufficient = await fetch(`${origin}/api/papers/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, idempotencyKey: randomUUID() }),
  });
  assert.equal(insufficient.status, 402);
  assert.equal((await insufficient.json()).requiredTokens, 2);
  assert.equal(balance, 1);
  assert.equal(paperCreateCount, 1);
});

test("MCQ and CQ generation reject manually selected questions from different classes", async (t) => {
  mockUserLookup(t);
  const questions = [
    { id: "mixed-mcq-9", type: "MCQ", classLevel: "Class 9", subject: "Physics", chapter: "Motion", topic: "Speed", marks: 1, content: { text: "Class 9 MCQ" } },
    { id: "mixed-mcq-10", type: "MCQ", classLevel: "Class 10", subject: "Physics", chapter: "Motion", topic: "Speed", marks: 1, content: { text: "Class 10 MCQ" } },
    { id: "mixed-cq-9", type: "CQ", classLevel: "Class 9", subject: "Physics", chapter: "Motion", topic: "Speed", marks: 10, content: { text: "Class 9 CQ" } },
    { id: "mixed-cq-10", type: "CQ", classLevel: "Class 10", subject: "Physics", chapter: "Motion", topic: "Speed", marks: 10, content: { text: "Class 10 CQ" } },
  ];
  stub(t, prisma.question, "findMany", async ({ where }) => {
    if (where.id) return questions.filter(({ id }) => where.id.in.includes(id));
    return questions.filter((question) =>
      question.classLevel === where.classLevel && question.type === where.type);
  });
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  for (const type of ["MCQ", "CQ"]) {
    const body = {
      title: "Mixed-class paper",
      settings: {},
      classLevel: "Class 9",
      subject: "Physics",
      chapters: ["Motion"],
      topics: [],
      type,
      mode: "manual",
      questionIds: [`mixed-${type.toLowerCase()}-9`, `mixed-${type.toLowerCase()}-10`],
      idempotencyKey: randomUUID(),
    };
    for (const endpoint of ["preview", "generate"]) {
      const response = await fetch(`${origin}/api/papers/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `${type} ${endpoint} should reject mixed classes`);
      assert.match((await response.json()).error, /different classes/);
    }
  }
});

test("MCQ and CQ generation succeeds when all selected questions belong to one class", async (t) => {
  mockUserLookup(t);
  const questions = ["MCQ", "CQ"].map((type) => ({
    id: `single-class-${type.toLowerCase()}`,
    type,
    classLevel: "Class 9",
    subject: "Physics",
    chapter: "Motion",
    topic: "Speed",
    marks: type === "MCQ" ? 1 : 10,
    content: { text: `Single-class ${type}` },
  }));
  let balance = 100;
  stub(t, prisma.question, "findMany", async ({ where }) => questions.filter((question) =>
    question.classLevel === where.classLevel && question.type === where.type));
  stub(t, prisma.tokenTransaction, "findUnique", async () => null);
  stub(t, prisma, "$transaction", async (callback) => callback({
    user: {
      updateMany: async () => {
        balance -= 1;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ tokenBalance: balance }),
    },
    paper: {
      create: async ({ data }) => ({
        id: "single-class-paper",
        ...data,
        items: data.items.create.map(({ questionId, position }) => ({
          questionId,
          position,
          question: questions.find(({ id }) => id === questionId),
        })),
      }),
    },
    tokenTransaction: { create: async ({ data }) => data },
  }));
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  for (const question of questions) {
    const response = await fetch(`${origin}/api/papers/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `Single-class ${question.type}`,
        settings: {},
        classLevel: "Class 9",
        subject: "Physics",
        chapters: ["Motion"],
        topics: [],
        type: question.type,
        mode: "auto",
        questionCount: 1,
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.paper.items.length, 1);
    assert.equal(result.paper.items[0].question.classLevel, "Class 9");
    assert.equal(result.paper.settings.classLevel, "Class 9");
  }
});

test("automatic generation reports available question counts and selects exact counts without duplicates", async (t) => {
  mockUserLookup(t);
  const questions = ["MCQ", "CQ"].flatMap((type) =>
    Array.from({ length: 3 }, (_, index) => ({
      id: `random-${type.toLowerCase()}-${index}`,
      type,
      classLevel: "Class 9",
      subject: "Physics",
      chapter: index === 0 ? "Motion" : "Forces",
      topic: "",
      marks: type === "MCQ" ? 1 : 10,
      content: { text: `${type} ${index}` },
    })));
  stub(t, prisma.question, "findMany", async ({ where }) => questions.filter((question) =>
    question.classLevel === where.classLevel &&
    question.subject === where.subject &&
    question.type === where.type &&
    (!where.chapter || where.chapter.in.includes(question.chapter))));
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  for (const type of ["MCQ", "CQ"]) {
    const body = {
      title: `Random ${type}`,
      settings: {},
      classLevel: "Class 9",
      subject: "Physics",
      chapters: [],
      topics: [],
      type,
      mode: "auto",
      questionCount: 2,
      idempotencyKey: randomUUID(),
    };
    const previewResponse = await fetch(`${origin}/api/papers/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.availableCount, 3);
    assert.equal(preview.questions.length, 2);
    assert.equal(new Set(preview.questions.map(({ id }) => id)).size, 2);
    assert.ok(preview.questions.every((question) =>
      question.type === type && question.classLevel === "Class 9" && question.subject === "Physics"));

    const insufficientResponse = await fetch(`${origin}/api/papers/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, questionCount: 4, idempotencyKey: randomUUID() }),
    });
    assert.equal(insufficientResponse.status, 422);
    const insufficient = await insufficientResponse.json();
    assert.equal(insufficient.availableCount, 3);
    assert.match(insufficient.error, /3 available, 4 requested/);

    const insufficientGeneration = await fetch(`${origin}/api/papers/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, questionCount: 4, idempotencyKey: randomUUID() }),
    });
    assert.equal(insufficientGeneration.status, 422);
    const generationError = await insufficientGeneration.json();
    assert.equal(generationError.availableCount, 3);
    assert.match(generationError.error, /3 available, 4 requested/);
  }
});

test("CQ generation supports Set 0, Set 2, Set 3, and Set 4 with unique questions", async (t) => {
  mockUserLookup(t);
  const questions = Array.from({ length: 4 }, (_, index) => ({
    id: `cq-set-${index + 1}`,
    type: "CQ",
    classLevel: "Class 9",
    subject: "Physics",
    chapter: `Chapter ${index + 1}`,
    topic: "",
    marks: 10,
    content: { text: `CQ ${index + 1}` },
  }));
  let balance = 1000;
  stub(t, prisma.question, "findMany", async ({ where }) => questions.filter((question) =>
    question.classLevel === where.classLevel &&
    question.subject === where.subject &&
    question.type === where.type &&
    (!where.chapter || where.chapter.in.includes(question.chapter))));
  stub(t, prisma.tokenTransaction, "findUnique", async () => null);
  stub(t, prisma, "$transaction", async (callback) => callback({
    user: {
      updateMany: async ({ data }) => {
        balance -= data.tokenBalance.decrement;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ tokenBalance: balance }),
    },
    paper: {
      create: async ({ data }) => ({
        id: "cq-set-paper",
        ...data,
        items: data.items.create.map(({ questionId, position }) => ({
          questionId,
          position,
          question: questions.find(({ id }) => id === questionId),
        })),
      }),
    },
    tokenTransaction: { create: async ({ data }) => data },
  }));
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };
  const configurations = [
    { count: 0, questionCount: 2 },
    { count: 2, questionCount: 2, sets: [1, 2] },
    { count: 3, questionCount: 3, sets: [1, 2, 3] },
    { count: 4, questionCount: 4, sets: [1, 2, 3, 4] },
  ];

  for (const configuration of configurations) {
    const response = await fetch(`${origin}/api/papers/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `CQ Set ${configuration.count}`,
        settings: {},
        classLevel: "Class 9",
        subject: "Physics",
        chapters: [],
        topics: [],
        type: "CQ",
        mode: "auto",
        questionCount: configuration.questionCount,
        ...(configuration.count > 0 ? {
          cqSetCount: configuration.count,
          cqSets: configuration.sets.map((setNumber) => ({
            setNumber,
            chapters: [`Chapter ${setNumber}`],
            questionCount: 1,
          })),
        } : {}),
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    const generatedQuestions = result.paper.items.map(({ question }) => question);
    assert.equal(generatedQuestions.length, configuration.questionCount);
    assert.equal(new Set(generatedQuestions.map(({ id }) => id)).size, generatedQuestions.length);
    assert.ok(generatedQuestions.every((question) =>
      question.classLevel === "Class 9" && question.subject === "Physics"));

    const savedAssignments = result.paper.settings.cqSetAssignments;
    if (configuration.count === 0) {
      assert.deepEqual(savedAssignments, {});
      assert.equal(result.paper.settings.cqSetCount, 0);
      assert.deepEqual(result.paper.settings.cqSets, []);
    } else {
      assert.equal(Object.keys(savedAssignments).length, configuration.questionCount);
      assert.deepEqual(
        Object.values(savedAssignments).sort((a, b) => a - b),
        configuration.sets,
      );
      assert.equal(result.paper.settings.cqSetCount, configuration.count);
      assert.deepEqual(result.paper.settings.cqSets, configuration.sets.map((setNumber) => ({
        setNumber,
        chapters: [`Chapter ${setNumber}`],
        questionCount: 1,
      })));
    }
  }

  const insufficient = await fetch(`${origin}/api/papers/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "CQ Set shortage",
      settings: {},
      classLevel: "Class 9",
      subject: "Physics",
      chapters: [],
      topics: [],
      type: "CQ",
      mode: "auto",
      questionCount: 2,
      cqSetCount: 2,
      cqSets: [
        { setNumber: 1, chapters: ["Chapter 1"], questionCount: 1 },
        { setNumber: 2, chapters: ["Chapter 1"], questionCount: 1 },
      ],
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(insufficient.status, 422);
  const shortage = await insufficient.json();
  assert.equal(shortage.setNumber, 2);
  assert.equal(shortage.availableCount, 0);
  assert.equal(shortage.requestedCount, 1);
  assert.match(shortage.error, /Set 2/);

  const invalidAssignment = await fetch(`${origin}/api/papers/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "CQ Set invalid assignment",
      settings: {},
      classLevel: "Class 9",
      subject: "Physics",
      chapters: [],
      topics: [],
      type: "CQ",
      mode: "auto",
      questionCount: 2,
      questionIds: ["cq-set-1", "cq-set-2"],
      cqSetCount: 2,
      cqSets: [
        { setNumber: 1, chapters: ["Chapter 1"], questionCount: 1 },
        { setNumber: 2, chapters: ["Chapter 2"], questionCount: 1 },
      ],
      cqSetAssignments: [
        { questionId: "cq-set-1", setNumber: 2 },
        { questionId: "cq-set-2", setNumber: 1 },
      ],
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(invalidAssignment.status, 400);
});

test("automatic generation rejects submitted IDs outside the selected class and subject", async (t) => {
  mockUserLookup(t);
  const questions = [
    { id: "eligible", type: "MCQ", classLevel: "Class 9", subject: "Physics", chapter: "Motion", topic: "", marks: 1, content: { text: "Eligible" } },
    { id: "other-class", type: "MCQ", classLevel: "Class 10", subject: "Physics", chapter: "Motion", topic: "", marks: 1, content: { text: "Other class" } },
    { id: "other-subject", type: "MCQ", classLevel: "Class 9", subject: "Biology", chapter: "Motion", topic: "", marks: 1, content: { text: "Other subject" } },
  ];
  stub(t, prisma.question, "findMany", async ({ where }) => questions.filter((question) =>
    question.classLevel === where.classLevel &&
    question.subject === where.subject &&
    question.type === where.type));
  let tokenLookupCalled = false;
  stub(t, prisma.tokenTransaction, "findUnique", async () => {
    tokenLookupCalled = true;
    return null;
  });
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };

  for (const questionId of ["other-class", "other-subject"]) {
    const response = await fetch(`${origin}/api/papers/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Validated random paper",
        settings: {},
        classLevel: "Class 9",
        subject: "Physics",
        chapters: [],
        topics: [],
        type: "MCQ",
        mode: "auto",
        questionCount: 1,
        questionIds: [questionId],
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /do not match the chosen class, subject/);
  }
  assert.equal(tokenLookupCalled, false);
});

test("paper create and update reject question IDs from different classes", async (t) => {
  mockUserLookup(t);
  const questions = [
    { id: "saved-class-9", classLevel: "Class 9", subject: "Physics" },
    { id: "saved-class-10", classLevel: "Class 10", subject: "Physics" },
    { id: "saved-biology", classLevel: "Class 9", subject: "Biology" },
  ];
  stub(t, prisma.question, "findMany", async ({ where }) =>
    questions.filter(({ id }) => where.id.in.includes(id)));
  stub(t, prisma.paper, "findFirst", async () => ({ id: "existing-paper" }));
  const origin = await serve(t);
  const headers = { "content-type": "application/json", cookie: sessionCookie("teacher-1") };
  const body = { title: "Mixed paper", settings: {}, questionIds: questions.map(({ id }) => id) };

  const created = await fetch(`${origin}/api/papers`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 400);
  assert.match((await created.json()).error, /different classes/);

  const updated = await fetch(`${origin}/api/papers/existing-paper`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(updated.status, 400);
  assert.match((await updated.json()).error, /different classes/);

  const mixedSubjects = { ...body, questionIds: ["saved-class-9", "saved-biology"] };
  const subjectCreate = await fetch(`${origin}/api/papers`, {
    method: "POST",
    headers,
    body: JSON.stringify(mixedSubjects),
  });
  assert.equal(subjectCreate.status, 400);
  assert.match((await subjectCreate.json()).error, /different classes or subjects/);

  const subjectUpdate = await fetch(`${origin}/api/papers/existing-paper`, {
    method: "PUT",
    headers,
    body: JSON.stringify(mixedSubjects),
  });
  assert.equal(subjectUpdate.status, 400);
  assert.match((await subjectUpdate.json()).error, /different classes or subjects/);
});

test("admin token grants update balances once and preserve transaction history", async (t) => {
  mockUserLookup(t);
  let balance = 0;
  let transactionRecord = null;
  stub(t, prisma.user, "findUnique", async ({ where }) => {
    if (where.id === "admin-1") return users.get("admin-1");
    if (where.id === "teacher-1" || where.email === "teacher@example.com") {
      return { ...users.get("teacher-1"), tokenBalance: balance };
    }
    return null;
  });
  stub(t, prisma.tokenTransaction, "findUnique", async () => transactionRecord);
  stub(t, prisma, "$transaction", async (callback) => callback({
    user: {
      update: async ({ data }) => {
        balance += data.tokenBalance.increment;
        return { tokenBalance: balance };
      },
    },
    tokenTransaction: {
      create: async ({ data }) => {
        transactionRecord = { ...data };
        return transactionRecord;
      },
    },
  }));
  const origin = await serve(t);
  const body = { email: "teacher@example.com", amount: 75, idempotencyKey: randomUUID() };
  const headers = { "content-type": "application/json", cookie: sessionCookie("admin-1") };

  const granted = await fetch(`${origin}/api/tokens/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(granted.status, 201);
  assert.equal((await granted.json()).balance, 75);
  assert.equal(balance, 75);
  assert.equal(transactionRecord.administeredBy, "admin-1");
  assert.equal(transactionRecord.amount, 75);

  const duplicate = await fetch(`${origin}/api/tokens/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(balance, 75);

  const reusedKey = await fetch(`${origin}/api/tokens/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, amount: 100 }),
  });
  assert.equal(reusedKey.status, 409);
  assert.equal(balance, 75);
});

test("administrator question deletion is authorized", async (t) => {
  mockUserLookup(t);
  let filter;
  stub(t, prisma.question, "deleteMany", async ({ where }) => {
    filter = where;
    return { count: 1 };
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/questions/question-1`, {
    method: "DELETE",
    headers: { cookie: sessionCookie("admin-1") },
  });
  assert.equal(response.status, 204);
  assert.deepEqual(filter, { id: "question-1" });
});

test("admin dashboard returns real grouped summaries and recent records concurrently", async (t) => {
  mockUserLookup(t);
  let transactionUsed = false;
  stub(t, prisma.question, "count", async ({ where } = {}) => where?.type === "MCQ" ? 4 : where?.type === "CQ" ? 2 : 6);
  stub(t, prisma.question, "groupBy", async ({ by }) => [{ [by[0]]: by[0] === "classLevel" ? "Class 9" : by[0] === "subject" ? "Physics" : by[0] === "chapter" ? "Motion" : "Speed", _count: { _all: 6 } }]);
  stub(t, prisma.question, "findMany", async ({ where } = {}) => {
    if (where?.type === "MCQ") return [{
      id: "recent-mcq",
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Physics",
      chapter: "Motion",
      marks: 1,
      createdAt: new Date("2025-01-03T00:00:00.000Z"),
      content: { text: "Recent MCQ" },
      author: { name: "Administrator", email: "admin@example.com" },
    }];
    if (where?.type === "CQ") return [{
      id: "recent-cq",
      type: "CQ",
      classLevel: "Class 9",
      subject: "Physics",
      chapter: "Motion",
      marks: 10,
      createdAt: new Date("2025-01-04T00:00:00.000Z"),
      content: { text: "Recent CQ" },
      author: { name: "Administrator", email: "admin@example.com" },
    }];
    return [];
  });
  stub(t, prisma.user, "count", async ({ where } = {}) => where?.role === "ADMIN" ? 1 : 3);
  stub(t, prisma.user, "findMany", async () => []);
  let rawQueryCount = 0;
  stub(t, prisma, "$queryRaw", async () => {
    rawQueryCount += 1;
    if (rawQueryCount === 1) return [{ count: 2 }];
    if (rawQueryCount === 2) return [{ day: new Date("2025-01-02T00:00:00.000Z"), count: 1 }];
    return [{ day: new Date("2025-01-02T00:00:00.000Z"), mcqCount: 2, cqCount: 3 }];
  });
  stub(t, prisma.questionImport, "groupBy", async () => [{ status: "COMPLETED", _count: { _all: 1 }, _sum: { importedRows: 4, failedRows: 0, duplicateRows: 0 } }]);
  stub(t, prisma.questionImport, "findMany", async () => [{
    id: "import-1",
    filename: "questions.csv",
    questionType: "MCQ",
    status: "COMPLETED",
    totalRows: 4,
    importedRows: 4,
    failedRows: 0,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    admin: { name: "Administrator", email: "admin@example.com" },
  }]);
  stub(t, prisma.adminActivity, "findMany", async ({ where }) => where?.action === "CREATE_QUESTION" ? [{
    id: "manual-1",
    action: "CREATE_QUESTION",
    entityType: "Question",
    entityId: "question-1",
    details: { type: "MCQ" },
    createdAt: new Date("2025-01-02T00:00:00.000Z"),
    admin: { name: "Administrator", email: "admin@example.com" },
  }] : [{
    id: "activity-1",
    action: "IMPORT_QUESTIONS",
    entityType: "QuestionImport",
    entityId: "import-1",
    details: null,
    createdAt: new Date("2025-01-02T00:00:00.000Z"),
    admin: { name: "Administrator", email: "admin@example.com" },
  }]);
  stub(t, prisma.academicEntry, "findMany", async () => []);
  stub(t, prisma, "$transaction", async () => {
    transactionUsed = true;
    throw new Error("Read-only dashboard queries should not use a sequential transaction");
  });

  const origin = await serve(t);
  const headers = { cookie: sessionCookie("admin-1") };
  const dashboardResponse = await fetch(`${origin}/api/admin/questions/dashboard`, { headers });
  assert.equal(dashboardResponse.status, 200);
  assert.deepEqual(await dashboardResponse.json(), {
    totals: {
      totalQuestions: 6,
      mcqQuestions: 4,
      cqQuestions: 2,
      classes: 1,
      subjects: 1,
      chapters: 1,
      topics: 1,
      registeredUsers: 3,
      admins: 1,
      activeUsers: 2,
      inactiveUsers: 1,
    },
    classDistribution: [{ name: "Class 9", count: 6 }],
    subjectDistribution: [{ name: "Physics", count: 6 }],
    recentMcqQuestions: [{
      id: "recent-mcq",
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Physics",
      chapter: "Motion",
      marks: 1,
      createdAt: "2025-01-03T00:00:00.000Z",
      content: { text: "Recent MCQ" },
      author: { name: "Administrator", email: "admin@example.com" },
    }],
    recentCqQuestions: [{
      id: "recent-cq",
      type: "CQ",
      classLevel: "Class 9",
      subject: "Physics",
      chapter: "Motion",
      marks: 10,
      createdAt: "2025-01-04T00:00:00.000Z",
      content: { text: "Recent CQ" },
      author: { name: "Administrator", email: "admin@example.com" },
    }],
    recentUsers: [],
    registrationTrend: [{ day: "2025-01-02T00:00:00.000Z", count: 1 }],
    questionUploadTrend: [{ day: "2025-01-02T00:00:00.000Z", mcqCount: 2, cqCount: 3 }],
    uploadStats: { attempts: 1, importedRows: 4, failedRows: 0, duplicateRows: 0 },
    recentImports: [{
      id: "import-1",
      filename: "questions.csv",
      questionType: "MCQ",
      status: "COMPLETED",
      totalRows: 4,
      importedRows: 4,
      failedRows: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      admin: { name: "Administrator", email: "admin@example.com" },
    }],
    recentManualUploads: [{
      id: "manual-1",
      action: "CREATE_QUESTION",
      entityType: "Question",
      entityId: "question-1",
      details: { type: "MCQ" },
      createdAt: "2025-01-02T00:00:00.000Z",
      admin: { name: "Administrator", email: "admin@example.com" },
    }],
    recentActivities: [{
      id: "activity-1",
      action: "IMPORT_QUESTIONS",
      entityType: "QuestionImport",
      entityId: "import-1",
      details: null,
      createdAt: "2025-01-02T00:00:00.000Z",
      admin: { name: "Administrator", email: "admin@example.com" },
    }],
    capabilities: { activeSessions: true, loginAudit: false, userManagement: false },
  });
  assert.equal(transactionUsed, false);
  assert.equal(rawQueryCount, 3);

  const academicResponse = await fetch(`${origin}/api/admin/questions/academic`, { headers });
  assert.equal(academicResponse.status, 200);
  assert.deepEqual(await academicResponse.json(), { entries: [] });
});

test("admin question APIs reject unauthenticated users and teachers on every route", async (t) => {
  mockUserLookup(t);
  const origin = await serve(t);
  const endpoints = [
    { path: "/api/admin/questions/catalog" },
    { path: "/api/admin/questions/dashboard" },
    { path: "/api/admin/questions/academic" },
    {
      path: "/api/admin/questions/upload/extract",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MCQ" }),
    },
    { path: "/api/admin/questions/upload/save", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    {
      path: "/api/admin/questions/bulk",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["question-1"] }),
    },
    { path: "/api/tokens/grant", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    { path: "/api/admin/questions?search=motion&type=MCQ" },
    { path: "/api/admin/questions/export.csv" },
    { path: "/api/admin/questions/export.xlsx" },
    {
      path: "/api/admin/questions",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseQuestion, type: "MCQ", content: { text: "Q?", options: ["A", "B"] } }),
    },
    {
      path: "/api/admin/questions/question-1",
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marks: 2 }),
    },
    { path: "/api/admin/questions/question-1", method: "DELETE" },
  ];

  for (const endpoint of endpoints) {
    const unauthenticated = await fetch(`${origin}${endpoint.path}`, {
      method: endpoint.method ?? "GET",
      headers: endpoint.headers,
      body: endpoint.body,
    });
    assert.equal(unauthenticated.status, 401, `${endpoint.method ?? "GET"} ${endpoint.path} should require authentication`);

    const teacher = await fetch(`${origin}${endpoint.path}`, {
      method: endpoint.method ?? "GET",
      headers: { ...endpoint.headers, cookie: sessionCookie("teacher-1") },
      body: endpoint.body,
    });
    assert.equal(teacher.status, 403, `${endpoint.method ?? "GET"} ${endpoint.path} should require an administrator`);
  }
});

test("admin list applies searchable metadata, question type filters, and pagination", async (t) => {
  mockUserLookup(t);
  let listArgs;
  let countArgs;
  stub(t, prisma.question, "findMany", async (args) => {
    listArgs = args;
    return [];
  });
  stub(t, prisma.question, "count", async (args) => {
    countArgs = args;
    return 17;
  });
  stub(t, prisma, "$transaction", async (operations) => Promise.all(operations));
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/admin/questions?search=Motion&classLevel=Class%209&subject=Physics&chapter=Speed&topic=Uniform&type=MCQ&limit=10&offset=20`, {
    headers: { cookie: sessionCookie("admin-1") },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 17);
  assert.equal(listArgs.take, 10);
  assert.equal(listArgs.skip, 20);
  assert.equal(listArgs.where.type, "MCQ");
  assert.equal(listArgs.where.classLevel, "Class 9");
  assert.equal(listArgs.where.subject.contains, "Physics");
  assert.equal(listArgs.where.chapter.contains, "Speed");
  assert.equal(listArgs.where.topic.contains, "Uniform");
  assert.equal(listArgs.where.OR.at(-1).content.path[0], "text");
  assert.deepEqual(countArgs.where, listArgs.where);
});

test("admin can create, edit, and delete question-bank records; teachers cannot use admin CRUD", async (t) => {
  mockUserLookup(t);
  let stored = null;
  stub(t, prisma.question, "findUnique", async ({ where }) => stored?.id === where.id ? stored : null);
  stub(t, prisma.question, "deleteMany", async ({ where }) => {
    const deleted = stored?.id === where.id;
    stored = deleted ? null : stored;
    return { count: Number(deleted) };
  });
  stub(t, prisma.adminActivity, "create", async ({ data }) => data);
  stub(t, prisma, "$transaction", async (callback) => {
    let staged = stored;
    const result = await callback({
      $queryRaw: async () => [],
      question: {
        create: async ({ data }) => {
          staged = { id: "admin-question", ...data };
          return staged;
        },
        findMany: async ({ where }) => stored && Object.entries(where).every(([key, value]) => stored[key] === value)
          ? [{ ...stored }]
          : [],
        update: async ({ where, data }) => {
          assert.equal(where.id, "admin-question");
          staged = { ...staged, ...data };
          return staged;
        },
      },
      questionImage: { updateMany: async () => ({ count: 0 }) },
      adminActivity: { create: async ({ data }) => data },
    });
    stored = staged;
    return result;
  });
  stub(t, prisma.paperItem, "count", async () => 0);
  const origin = await serve(t);
  const adminHeaders = { "content-type": "application/json", cookie: sessionCookie("admin-1") };

  const invalid = await fetch(`${origin}/api/admin/questions`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ ...baseQuestion, type: "MCQ", marks: 0, content: { text: "", options: ["A"] } }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error, "Question validation failed");
  assert.ok(invalidBody.issues.length >= 2);
  assert.equal(stored, null);

  const create = await fetch(`${origin}/api/admin/questions`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      ...baseQuestion,
      type: "MCQ",
      content: { text: "What is speed?", options: ["Distance/time", "Force"], equation: "v=\\frac{s}{t}", imageUrl: "/api/uploads/admin-1/test.png" },
    }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).question.authorId, "admin-1");

  const duplicateCreate = await fetch(`${origin}/api/admin/questions`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      ...baseQuestion,
      type: "MCQ",
      content: { text: "What is speed?", options: ["Distance/time", "Force"], equation: "v=\\frac{s}{t}", imageUrl: "/api/uploads/admin-1/test.png" },
    }),
  });
  assert.equal(duplicateCreate.status, 409);
  assert.deepEqual(await duplicateCreate.json(), { error: "This question already exists" });

  const createCq = await fetch(`${origin}/api/admin/questions`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      ...baseQuestion,
      type: "CQ",
      marks: 10,
      content: { text: "Read this stimulus", subs: ["Define displacement", "Calculate acceleration"] },
    }),
  });
  assert.equal(createCq.status, 201);
  const createdCq = await createCq.json();
  assert.equal(createdCq.question.type, "CQ");
  assert.deepEqual(createdCq.question.content.subs, ["Define displacement", "Calculate acceleration"]);

  const update = await fetch(`${origin}/api/admin/questions/admin-question`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ type: "CQ", marks: 10, content: { text: "A creative prompt", subs: ["Part A"] } }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).question.type, "CQ");

  const teacherUpdate = await fetch(`${origin}/api/admin/questions/admin-question`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: sessionCookie("teacher-1") },
    body: JSON.stringify({ marks: 5 }),
  });
  assert.equal(teacherUpdate.status, 403);

  const remove = await fetch(`${origin}/api/admin/questions/admin-question`, {
    method: "DELETE",
    headers: { cookie: sessionCookie("admin-1") },
  });
  assert.equal(remove.status, 204);
  assert.equal(stored, null);
});

test("manual Admin question creation rolls back if uploaded image attachment fails", async (t) => {
  mockUserLookup(t);
  let committedQuestion = null;
  let activityCreated = false;
  stub(t, prisma, "$transaction", async (callback) => {
    let stagedQuestion = null;
    const transaction = {
      $queryRaw: async () => [],
      question: {
        findMany: async () => [],
        create: async ({ data }) => {
          stagedQuestion = { id: "staged-question", ...data };
          return stagedQuestion;
        },
      },
      questionImage: { updateMany: async () => ({ count: 0 }) },
      adminActivity: { create: async () => { activityCreated = true; } },
    };
    const result = await callback(transaction);
    committedQuestion = stagedQuestion;
    return result;
  });
  const origin = await serve(t);
  const response = await fetch(`${origin}/api/admin/questions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie("admin-1") },
    body: JSON.stringify({
      ...baseQuestion,
      type: "MCQ",
      content: {
        text: "Question with an unavailable image",
        options: ["A", "B"],
        imageUrl: "/api/uploads/images/unavailable-image",
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /image is unavailable/);
  assert.equal(committedQuestion, null);
  assert.equal(activityCreated, false);
});

test("admin deletion returns a conflict when a saved paper references the question", async (t) => {
  mockUserLookup(t);
  stub(t, prisma.paperItem, "count", async ({ where }) => {
    assert.deepEqual(where, { questionId: "used-question" });
    return 1;
  });
  const origin = await serve(t);

  const response = await fetch(`${origin}/api/admin/questions/used-question`, {
    method: "DELETE",
    headers: { cookie: sessionCookie("admin-1") },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /saved paper/);
});

test("authenticated question-image uploads store raw image bytes in PostgreSQL", async (t) => {
  mockUserLookup(t);
  let storedImage;
  stub(t, prisma.questionImage, "create", async ({ data }) => {
    storedImage = data;
    return { id: "image-id" };
  });
  stub(t, prisma.questionImage, "findUnique", async () => ({
    id: "image-id",
    ownerId: "teacher-1",
    mimeType: "image/jpeg",
    originalFilename: "question.jpg",
    data: storedImage.data,
    question: null,
  }));
  const origin = await serve(t);
  const form = new FormData();
  form.append("image", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");
  const response = await fetch(`${origin}/api/uploads`, {
    method: "POST",
    headers: { cookie: sessionCookie("teacher-1") },
    body: form,
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.url, "/api/uploads/images/image-id");
  assert.equal(storedImage.ownerId, "teacher-1");
  assert.equal(storedImage.mimeType, "image/jpeg");
  assert.deepEqual(Buffer.from(storedImage.data), Buffer.from([0xff, 0xd8, 0xff]));
  const imageResponse = await fetch(`${origin}/api/uploads/images/image-id`, {
    headers: { cookie: sessionCookie("teacher-1") },
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff]));
});

test.skip("legacy Supabase image uploads are superseded by PostgreSQL BYTEA storage", async (t) => {
  mockUserLookup(t);
  const previousStorageConfig = {
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    bucket: config.supabaseStorageBucket,
  };
  config.supabaseUrl = "https://storage.example.test";
  config.supabaseServiceRoleKey = "test-storage-service-key";
  config.supabaseStorageBucket = "question-images";
  t.after(() => {
    config.supabaseUrl = previousStorageConfig.url;
    config.supabaseServiceRoleKey = previousStorageConfig.serviceRoleKey;
    config.supabaseStorageBucket = previousStorageConfig.bucket;
  });

  const originalFetch = globalThis.fetch.bind(globalThis);
  const storageRequests = [];
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith("https://storage.example.test/")) {
      storageRequests.push({ url: String(input), options });
      return new Response(null, { status: 200 });
    }
    return originalFetch(input, options);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const origin = await serve(t);
  const form = new FormData();
  form.append("image", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");
  const response = await originalFetch(`${origin}/api/uploads`, {
    method: "POST",
    headers: { cookie: sessionCookie("teacher-1") },
    body: form,
  });

  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.match(uploaded.url, /^\/api\/uploads\/teacher-1\/[0-9a-f-]+\.jpg$/);
  assert.equal(storageRequests.length, 1);
  assert.match(storageRequests[0].url, /^https:\/\/storage\.example\.test\/storage\/v1\/object\/question-images\/teacher-1\/[0-9a-f-]+\.jpg$/);
  assert.equal(storageRequests[0].options.headers.authorization, "Bearer test-storage-service-key");
});

test("teachers can view only admin question images referenced by the shared question bank", async (t) => {
  mockUserLookup(t);
  const previousStorageConfig = {
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  };
  config.supabaseUrl = undefined;
  config.supabaseServiceRoleKey = undefined;
  t.after(() => {
    config.supabaseUrl = previousStorageConfig.url;
    config.supabaseServiceRoleKey = previousStorageConfig.serviceRoleKey;
  });
  let referenced = false;
  stub(t, prisma.question, "findFirst", async ({ where }) => {
    assert.equal(where.authorId, "admin-1");
    assert.deepEqual(where.author, { role: "ADMIN" });
    assert.equal(where.content.equals, "/api/uploads/admin-1/question.jpg");
    return referenced ? { id: "shared-question" } : null;
  });
  const imageDirectory = path.join(config.uploadDirectory, "admin-1");
  await mkdir(imageDirectory, { recursive: true });
  await writeFile(path.join(imageDirectory, "question.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  t.after(() => rm(imageDirectory, { recursive: true, force: true }));
  const origin = await serve(t);
  const headers = { cookie: sessionCookie("teacher-1") };

  const privateImage = await fetch(`${origin}/api/uploads/admin-1/question.jpg`, { headers });
  assert.equal(privateImage.status, 404);

  referenced = true;
  const sharedImage = await fetch(`${origin}/api/uploads/admin-1/question.jpg`, { headers });
  assert.equal(sharedImage.status, 200, sharedImage.status === 200 ? undefined : await sharedImage.text());
  assert.equal(sharedImage.headers.get("x-content-type-options"), "nosniff");
});

test("Admin DOCX import preserves embedded image bytes through preview and database save", async (t) => {
  mockUserLookup(t);
  const { default: JSZip } = await import("jszip");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>1. What is 2 + 2? (1)</w:t></w:r></w:p>
        <w:p><w:r><w:t>(a) Four</w:t></w:r></w:p>
        <w:p><w:r><w:t>(b) Five</w:t></w:r></w:p>
        <w:p><w:r><w:t>Answer: (a)</w:t></w:r></w:p>
        <w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p>
        <w:p><w:r><w:t>2. Which is even? (1)</w:t></w:r></w:p>
        <w:p><w:r><w:t>(a) Three</w:t></w:r></w:p>
        <w:p><w:r><w:t>(b) Four</w:t></w:r></w:p>
      </w:body>
    </w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  </Relationships>`);
  zip.file("word/media/image1.png", imageBytes);
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  const stagedImages = [];
  const storedQuestions = [];
  const activities = [];
  const transaction = {
    $queryRaw: async () => [],
    question: {
      findMany: async () => storedQuestions,
      createManyAndReturn: async ({ data }) => data.map((record) => {
        const question = { id: `saved-${storedQuestions.length + 1}`, ...record };
        storedQuestions.push(question);
        return question;
      }),
    },
    questionImage: {
      updateMany: async ({ where, data }) => {
        const owned = stagedImages.filter((image) =>
          where.id.in.includes(image.id) && image.ownerId === where.ownerId && image.questionId === null);
        owned.forEach((image) => { image.questionId = data.questionId; });
        return { count: owned.length };
      },
    },
    academicEntry: mockAcademicEntries(),
    adminActivity: { createMany: async ({ data }) => { activities.push(...data); return { count: data.length }; } },
  };
  stub(t, prisma.questionImage, "createManyAndReturn", async ({ data }) => {
    stagedImages.push(...data.map((image) => ({ ...image, questionId: null })));
    return data.map(({ id }) => ({ id }));
  });
  stub(t, prisma.questionImage, "findUnique", async ({ where }) => stagedImages.find(({ id }) => id === where.id) ?? null);
  stub(t, prisma, "$transaction", async (callback) => callback(transaction));

  const origin = await serve(t);
  const form = new FormData();
  form.set("type", "MCQ");
  form.set("classLevel", "Class 9");
  form.set("subject", "Mathematics");
  form.set("chapter", "Arithmetic");
  form.set("topic", "Addition");
  form.append("files", new Blob([docx], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "questions.docx");
  const headers = { cookie: sessionCookie("admin-1") };
  const response = await fetch(`${origin}/api/admin/questions/upload/extract`, {
    method: "POST",
    headers,
    body: form,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const preview = await response.json();
  assert.equal(preview.totalQuestions, 2);
  assert.equal(preview.imageCount, 1);
  assert.equal(preview.questions[0].sourceNumber, "1");
  assert.equal(preview.questions[0].content.text, "What is 2 + 2?");
  assert.deepEqual(preview.questions[0].content.options, ["Four", "Five"]);
  assert.equal(preview.questions[0].content.answer, "(a)");
  assert.equal(preview.questions[0].topic, "Addition");
  assert.equal(preview.questions[0].content.imageUrls.length, 1);

  const imageResponse = await fetch(`${origin}${preview.questions[0].content.imageUrls[0]}`, { headers });
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);

  const savedResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Mathematics",
      chapter: "Arithmetic",
      questions: preview.questions.map(({ marks, topic, sourceNumber, content }) => ({
        marks, topic, sourceNumber, content,
      })),
    }),
  });
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  assert.equal((await savedResponse.json()).saved, 2);
  assert.equal(storedQuestions[0].content.sourceNumber, "1");
  assert.equal(stagedImages[0].questionId, storedQuestions[0].id);
  assert.equal(activities.length, 2);

  const bulkQuestions = Array.from({ length: 1000 }, (_, index) => ({
    marks: 1,
    topic: "Bulk import",
    sourceNumber: String(index + 1),
    content: { text: `Bulk question ${index + 1}`, options: ["Option one", "Option two"] },
  }));
  const bulkResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Mathematics",
      chapter: "Arithmetic",
      questions: bulkQuestions,
    }),
  });
  assert.equal(bulkResponse.status, 201, await bulkResponse.clone().text());
  assert.equal((await bulkResponse.json()).saved, 1000);
  assert.equal(activities.length, 1002);

  const duplicateResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Mathematics",
      chapter: "Arithmetic",
      questions: preview.questions.map(({ marks, topic, sourceNumber, content }) => ({
        marks, topic, sourceNumber, content,
      })),
    }),
  });
  assert.equal(duplicateResponse.status, 409);

  const invalidResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      type: "MCQ",
      classLevel: "Class 9",
      subject: "Mathematics",
      chapter: "Arithmetic",
      questions: [{ marks: 1, topic: "Addition", content: { text: "Invalid", options: [] } }],
    }),
  });
  assert.equal(invalidResponse.status, 400);
});

test("Admin document import clearly rejects image-only PDFs without OCR", async (t) => {
  mockUserLookup(t);
  const origin = await serve(t);
  const form = new FormData();
  form.set("type", "MCQ");
  form.set("classLevel", "Class 9");
  form.set("subject", "Mathematics");
  form.set("chapter", "Arithmetic");
  form.set("topic", "Addition");
  form.append("files", new Blob([createImageOnlyPdf()], { type: "application/pdf" }), "scanned.pdf");

  const response = await fetch(`${origin}/api/admin/questions/upload/extract`, {
    method: "POST",
    headers: { cookie: sessionCookie("admin-1") },
    body: form,
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /scanned or image-only.*OCR is not used/i);
});

test.skip("Legacy OCR key validation", async (t) => {
  mockUserLookup(t);
  stub(t, config, "geminiApiKey", undefined);
  const origin = await serve(t);
  const form = new FormData();
  form.set("type", "MCQ");
  form.set("classLevel", "Class 9");
  form.set("subject", "Mathematics");
  form.set("chapter", "Algebra");
  form.append("files", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");

  const response = await fetch(`${origin}/api/admin/questions/upload/extract`, {
    method: "POST",
    headers: { cookie: sessionCookie("admin-1") },
    body: form,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "OCR সেবা কনফিগার করা নেই। Backend-এ GEMINI_API_KEY সেট করুন।",
    code: "GEMINI_NOT_CONFIGURED",
  });
});

test.skip("Legacy OCR provider retries", async (t) => {
  mockUserLookup(t);
  let transactions = 0;
  stub(t, prisma, "$transaction", async () => {
    transactions += 1;
    throw new Error("OCR extraction must not save questions.");
  });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const providerLogs = [];
  console.warn = (...args) => providerLogs.push(args.join(" "));
  t.after(() => { console.warn = originalWarn; });
  let failuresRemaining = 2;
  let ocrCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
      assert.equal(init.headers["x-goog-api-key"], "test-gemini-key");
      ocrCalls += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return Response.json({
          error: {
            code: 503,
            status: "UNAVAILABLE",
            message: "Temporary provider diagnostic; test-gemini-key must remain private.",
          },
        }, { status: 503 });
      }
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({ pages: [{ page: 1, text: "১. প্রশ্ন\nক) ১\nখ) ২\n(১)" }] }),
            }],
          },
        }],
      });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const origin = await serve(t);
  const createRequest = () => {
    const form = new FormData();
    form.set("type", "MCQ");
    form.set("classLevel", "Class 9");
    form.set("subject", "Mathematics");
    form.set("chapter", "Algebra");
    form.append("files", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");
    return fetch(`${origin}/api/admin/questions/upload/extract`, {
      method: "POST",
      headers: { cookie: sessionCookie("admin-1") },
      body: form,
    });
  };

  const successfulResponse = await createRequest();
  assert.equal(successfulResponse.status, 200, await successfulResponse.clone().text());
  assert.equal(ocrCalls, 3, "two temporary 503 errors should be retried before success");
  assert.equal(transactions, 0, "OCR retries must not insert database records");

  failuresRemaining = 4;
  ocrCalls = 0;
  const failedResponse = await createRequest();
  assert.equal(failedResponse.status, 503);
  assert.equal(ocrCalls, 4, "three retries means at most four total Gemini requests");
  const failureBody = await failedResponse.json();
  assert.equal(failureBody.code, "GEMINI_UNAVAILABLE");
  assert.match(failureBody.error, /সাময়িকভাবে অনুপলব্ধ/);
  assert.doesNotMatch(JSON.stringify(failureBody), /test-gemini-key|Temporary provider diagnostic/);
  assert.ok(providerLogs.some((log) => log.includes('"httpStatus":503')
    && log.includes('"providerStatus":"UNAVAILABLE"')
    && log.includes("Temporary provider diagnostic")));
  assert.ok(providerLogs.every((log) => !log.includes("test-gemini-key")));
  assert.equal(transactions, 0, "failed OCR attempts must not insert database records");
});

test.skip("Legacy OCR cancellation", async (t) => {
  mockUserLookup(t);
  const originalFetch = globalThis.fetch;
  let upstreamSignal;
  let signalObserved;
  let resolveSignalObserved;
  let upstreamAborted;
  let resolveUpstreamAborted;
  signalObserved = new Promise((resolve) => { resolveSignalObserved = resolve; });
  upstreamAborted = new Promise((resolve) => { resolveUpstreamAborted = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
      upstreamSignal = init.signal;
      resolveSignalObserved();
      return new Promise((_resolve, reject) => {
        upstreamSignal.addEventListener("abort", () => {
          resolveUpstreamAborted();
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const origin = await serve(t);
  const form = new FormData();
  form.set("type", "MCQ");
  form.set("classLevel", "Class 9");
  form.set("subject", "Mathematics");
  form.set("chapter", "Algebra");
  form.append("files", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");

  const clientController = new AbortController();
  const request = fetch(`${origin}/api/admin/questions/upload/extract`, {
    method: "POST",
    headers: { cookie: sessionCookie("admin-1") },
    body: form,
    signal: clientController.signal,
  }).catch((error) => error);
  await signalObserved;
  clientController.abort();
  await upstreamAborted;
  assert.equal(upstreamSignal.aborted, true);
  assert.ok((await request) instanceof Error, "cancelled client request should not receive an OCR result");
});

test.skip("Legacy OCR provider errors", async (t) => {
  mockUserLookup(t);
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });
  let providerFailure = { status: 400, providerStatus: "INVALID_ARGUMENT", code: "GEMINI_INVALID_REQUEST", apiStatus: 502 };
  let ocrCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
      assert.equal(init.headers["x-goog-api-key"], "test-gemini-key");
      ocrCalls += 1;
      return Response.json({
        error: {
          code: providerFailure.status,
          status: providerFailure.providerStatus,
          message: "Provider detail containing test-gemini-key must not be forwarded.",
        },
      }, { status: providerFailure.status });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const origin = await serve(t);
  const createRequest = () => {
    const form = new FormData();
    form.set("type", "MCQ");
    form.set("classLevel", "Class 9");
    form.set("subject", "Mathematics");
    form.set("chapter", "Algebra");
    form.append("files", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "question.jpg");
    return fetch(`${origin}/api/admin/questions/upload/extract`, {
      method: "POST",
      headers: { cookie: sessionCookie("admin-1") },
      body: form,
    });
  };

  const cases = [
    { status: 400, providerStatus: "INVALID_ARGUMENT", code: "GEMINI_INVALID_REQUEST", apiStatus: 502 },
    { status: 401, providerStatus: "UNAUTHENTICATED", code: "GEMINI_AUTHENTICATION_ERROR", apiStatus: 502 },
    { status: 403, providerStatus: "PERMISSION_DENIED", code: "GEMINI_PERMISSION_DENIED", apiStatus: 502 },
    { status: 404, providerStatus: "NOT_FOUND", code: "GEMINI_MODEL_NOT_FOUND", apiStatus: 502 },
    { status: 429, providerStatus: "RESOURCE_EXHAUSTED", code: "GEMINI_QUOTA_EXCEEDED", apiStatus: 429 },
    { status: 503, providerStatus: "RESOURCE_EXHAUSTED", code: "GEMINI_QUOTA_EXCEEDED", apiStatus: 429 },
  ];
  for (const testCase of cases) {
    providerFailure = testCase;
    ocrCalls = 0;
    const response = await createRequest();
    assert.equal(response.status, testCase.apiStatus);
    const body = await response.json();
    assert.equal(body.code, testCase.code);
    assert.equal(ocrCalls, 1, `HTTP ${testCase.status} must not be retried`);
    assert.doesNotMatch(JSON.stringify(body), /test-gemini-key|Provider detail/);
  }
});

test.skip("Legacy OCR PDF extraction", async (t) => {
  mockUserLookup(t);
  const { PDFDocument } = await import("pdf-lib");
  const originalFetch = globalThis.fetch;
  let ocrCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, "application/pdf");
      ocrCalls += 1;
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                pages: [
                  { page: 1, text: "1. First page\nA. Four\nB. Five\n(1)" },
                  { page: 2, text: "2. Second page\nA. Six\nB. Seven\n(1)" },
                ],
              }),
            }],
          },
        }],
      });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const origin = await serve(t);

  const uploadPdf = async (pageCount) => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < pageCount; index += 1) pdf.addPage();
    const form = new FormData();
    form.set("type", "MCQ");
    form.set("classLevel", "Class 9");
    form.set("subject", "English");
    form.set("chapter", "Reading");
    form.append("files", new Blob([await pdf.save()], { type: "application/pdf" }), "questions.pdf");
    return fetch(`${origin}/api/admin/questions/upload/extract`, {
      method: "POST",
      headers: { cookie: sessionCookie("admin-1") },
      body: form,
    });
  };

  const validResponse = await uploadPdf(2);
  assert.equal(validResponse.status, 200, await validResponse.clone().text());
  const extracted = await validResponse.json();
  assert.equal(extracted.pageCount, 2);
  assert.deepEqual(extracted.questions.map(({ sourcePages }) => sourcePages), [[1], [2]]);
  assert.equal(ocrCalls, 1);

  const excessiveResponse = await uploadPdf(6);
  assert.equal(excessiveResponse.status, 413);
  assert.match((await excessiveResponse.json()).error, /1 and 5 pages/);
  assert.equal(ocrCalls, 1, "over-limit PDFs must be rejected before calling OCR");
});

test("Admin document import saves reviewed questions transactionally and rejects database duplicates", async (t) => {
  mockUserLookup(t);
  const created = [];
  const transaction = {
    $queryRaw: async () => [],
    question: {
      findMany: async () => created,
      createManyAndReturn: async ({ data }) => data.map((record) => {
        const question = { id: `saved-${created.length + 1}`, ...record };
        created.push(question);
        return question;
      }),
    },
    academicEntry: mockAcademicEntries(),
    questionImage: { updateMany: async () => ({ count: 0 }) },
    adminActivity: { createMany: async ({ data }) => ({ count: data.length }) },
  };
  stub(t, prisma, "$transaction", async (callback) => callback(transaction));
  const origin = await serve(t);
  const question = {
    marks: 1,
    topic: "Addition",
    content: { text: "2 + 2 = ?", options: ["৪", "৫"] },
  };
  const headers = {
    "content-type": "application/json",
    cookie: sessionCookie("admin-1"),
  };
  const body = JSON.stringify({
    type: "MCQ",
    classLevel: "Class 9",
    subject: "Mathematics",
    chapter: "Addition",
    questions: [question],
  });

  const savedResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  assert.deepEqual(await savedResponse.json(), { saved: 1, questionIds: ["saved-1"] });
  assert.equal(created.length, 1);
  assert.equal(created[0].group, "General");
  assert.equal(created[0].content.text, question.content.text);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "CLASS").length, 1);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "SUBJECT").length, 1);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "CHAPTER").length, 1);

  const cqBody = JSON.stringify({
    type: "CQ",
    classLevel: "Class 9",
    subject: "Mathematics",
    chapter: "Addition",
    questions: [{
      marks: 10,
      topic: "Word problems",
      content: { text: "উদ্দীপক: একটি সমীকরণ।", subs: ["ক প্রশ্ন", "খ প্রশ্ন"] },
    }],
  });
  const cqResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, cookie: sessionCookie("admin-1") },
    body: cqBody,
  });
  assert.equal(cqResponse.status, 201, await cqResponse.clone().text());
  assert.deepEqual(await cqResponse.json(), { saved: 1, questionIds: ["saved-2"] });
  assert.equal(created[1].type, "CQ");
  assert.deepEqual(created[1].content.subs, ["ক প্রশ্ন", "খ প্রশ্ন"]);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "CLASS").length, 1);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "SUBJECT").length, 1);
  assert.equal(transaction.academicEntry.entries.filter(({ type }) => type === "CHAPTER").length, 1);

  transaction.question.findMany = async () => [created[0]];
  const duplicateResponse = await fetch(`${origin}/api/admin/questions/upload/save`, {
    method: "POST",
    headers: { ...headers, cookie: sessionCookie("admin-1") },
    body,
  });
  assert.equal(duplicateResponse.status, 409);
  assert.match((await duplicateResponse.json()).error, /Duplicate questions found/);
  assert.equal(created.length, 2, "duplicate prevention must avoid another database insert");
});
