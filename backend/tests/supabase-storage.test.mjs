import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.SUPABASE_URL = "https://storage.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-storage-service-key";
process.env.SUPABASE_STORAGE_BUCKET = "question-images";

const { readQuestionImage, saveQuestionImage } = await import("../src/supabase-storage.ts");

test("question images are stored in the private Supabase bucket under the owner path", async (t) => {
  const image = Buffer.from([0xff, 0xd8, 0xff]);
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://storage.example.test/storage/v1/object/question-images/teacher-1/question.jpg");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.apikey, "test-storage-service-key");
    assert.equal(options.headers.authorization, "Bearer test-storage-service-key");
    assert.equal(options.headers["content-type"], "image/jpeg");
    assert.equal(options.headers["x-upsert"], "false");
    assert.deepEqual(Buffer.from(options.body), image);
    return new Response(null, { status: 200 });
  });

  await saveQuestionImage("teacher-1", "question.jpg", "image/jpeg", image);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("question image reads return private object bytes and treat missing objects as not found", async (t) => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(image, { status: 200, headers: { "content-type": "image/png" } }),
  );

  const result = await readQuestionImage("teacher-1", "question.png");
  assert.equal(fetchMock.mock.calls[0].arguments[0], "https://storage.example.test/storage/v1/object/question-images/teacher-1/question.png");
  assert.deepEqual(result.data, image);
  assert.equal(result.contentType, "image/png");
});

test("missing question images are returned as not found", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  assert.equal(await readQuestionImage("teacher-1", "missing.png"), null);
});
