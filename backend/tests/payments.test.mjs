import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.PAYMENT_WEBHOOK_SECRET = "payment-webhook-test-secret";

const [{ default: express }, { prisma }, { config }, { default: paymentRouter }] = await Promise.all([
  import("express"),
  import("../src/db.ts"),
  import("../src/config.ts"),
  import("../src/routes/payments.ts"),
]);

const paymentSecret = config.paymentWebhookSecret;

function createLockManager() {
  const queues = new Map();
  return async (key) => {
    const previous = queues.get(key) ?? Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    const queued = previous.then(() => current);
    queues.set(key, queued);
    await previous;
    return () => {
      unlock();
      if (queues.get(key) === queued) queues.delete(key);
    };
  };
}

async function createPaymentApp(t, existingSubscription) {
  const state = {
    events: new Map(),
    plans: new Map([["monthly", {
      id: "plan-monthly",
      code: "monthly",
      active: true,
      priceMinor: 1200,
      currency: "BDT",
      durationDays: 30,
    }]]),
    users: new Map([["teacher-1", { id: "teacher-1" }]]),
    subscriptions: new Map(),
  };
  if (existingSubscription) state.subscriptions.set("teacher-1", existingSubscription);
  const lockUser = createLockManager();
  const originals = {
    paymentEventFindUnique: prisma.paymentEvent.findUnique,
    paymentEventCreate: prisma.paymentEvent.create,
    planFindUnique: prisma.subscriptionPlan.findUnique,
    userFindUnique: prisma.user.findUnique,
    transaction: prisma.$transaction,
  };
  let throwUniqueOnCreate = false;

  prisma.paymentEvent.findUnique = async ({ where }) => state.events.get(where.providerReference) ?? null;
  prisma.subscriptionPlan.findUnique = async ({ where }) => state.plans.get(where.code) ?? null;
  prisma.user.findUnique = async ({ where }) => state.users.get(where.id) ?? null;
  prisma.$transaction = async (callback) => {
    let releaseUserLock;
    let transactionState;
    const transaction = {
      $queryRaw: async (_query, userId) => {
        releaseUserLock = await lockUser(userId);
        transactionState = {
          events: new Map(state.events),
          subscriptions: new Map(state.subscriptions),
        };
        return [];
      },
      paymentEvent: {
        findUnique: async ({ where }) => transactionState.events.get(where.providerReference) ?? null,
        create: async ({ data }) => {
          if (throwUniqueOnCreate) {
            throwUniqueOnCreate = false;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          if (transactionState.events.has(data.providerReference)) {
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          const event = { ...data, id: `event-${transactionState.events.size + 1}` };
          transactionState.events.set(data.providerReference, event);
          return event;
        },
      },
      subscription: {
        findUnique: async ({ where }) => transactionState.subscriptions.get(where.userId) ?? null,
        upsert: async ({ where, create, update }) => {
          const current = transactionState.subscriptions.get(where.userId);
          const subscription = current ? { ...current, ...update } : { ...create };
          transactionState.subscriptions.set(where.userId, subscription);
          return subscription;
        },
      },
    };

    try {
      const result = await callback(transaction);
      state.events = transactionState.events;
      state.subscriptions = transactionState.subscriptions;
      return result;
    } finally {
      releaseUserLock?.();
    }
  };

  const app = express();
  app.use("/api/payments", paymentRouter);
  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  t.after(() => {
    prisma.paymentEvent.findUnique = originals.paymentEventFindUnique;
    prisma.paymentEvent.create = originals.paymentEventCreate;
    prisma.subscriptionPlan.findUnique = originals.planFindUnique;
    prisma.user.findUnique = originals.userFindUnique;
    prisma.$transaction = originals.transaction;
    config.paymentWebhookSecret = paymentSecret;
  });

  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/api/payments/webhook`,
    setThrowUniqueOnCreate(value) {
      throwUniqueOnCreate = value;
    },
  };
}

async function sendPayment(url, overrides = {}) {
  const payload = {
    reference: "provider-ref-001",
    userId: "teacher-1",
    planCode: "monthly",
    amountMinor: 1200,
    currency: "BDT",
    status: "paid",
    ...overrides,
  };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", paymentSecret).update(body).digest("hex");
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": signature },
    body,
  });
}

test("concurrent distinct payments extend an existing subscription by every paid term", async (t) => {
  const now = Date.now();
  const previousEnd = new Date(now + 5 * 24 * 60 * 60 * 1000);
  const previousSubscription = {
    id: "subscription-existing",
    userId: "teacher-1",
    planId: "plan-previous",
    status: "ACTIVE",
    startsAt: new Date(now - 20 * 24 * 60 * 60 * 1000),
    endsAt: previousEnd,
  };
  const { state, url } = await createPaymentApp(t, previousSubscription);
  state.events.set("provider-ref-old", {
    id: "event-existing",
    providerReference: "provider-ref-old",
    userId: "teacher-1",
    planId: "plan-previous",
    amountMinor: 600,
    currency: "BDT",
    status: "PAID",
  });
  const [first, second] = await Promise.all([
    sendPayment(url, { reference: "provider-ref-101" }),
    sendPayment(url, { reference: "provider-ref-102" }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(state.events.size, 3);
  assert.ok(state.events.has("provider-ref-old"));
  const subscription = state.subscriptions.get("teacher-1");
  const expectedDuration = 60 * 24 * 60 * 60 * 1000;
  assert.equal(subscription.id, previousSubscription.id);
  assert.equal(subscription.endsAt.getTime(), previousEnd.getTime() + expectedDuration);
  assert.ok(subscription.startsAt.getTime() >= previousEnd.getTime());
});

test("concurrent duplicate references apply one subscription term and mismatched replays conflict", async (t) => {
  const { state, url } = await createPaymentApp(t);
  const [first, second] = await Promise.all([sendPayment(url), sendPayment(url)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
  assert.equal([firstBody, secondBody].filter((body) => body.duplicate === true).length, 1);
  assert.equal(state.events.size, 1);
  const endsAt = state.subscriptions.get("teacher-1").endsAt.getTime();
  assert.ok(endsAt > Date.now());

  const originalEnd = endsAt;
  const conflict = await sendPayment(url, { amountMinor: 2400 });
  assert.equal(conflict.status, 409);
  assert.equal(state.events.size, 1);
  assert.equal(state.subscriptions.get("teacher-1").endsAt.getTime(), originalEnd);

  state.events.get("provider-ref-001").status = "FAILED";
  const nonPaidDuplicate = await sendPayment(url);
  assert.equal(nonPaidDuplicate.status, 409);
  assert.equal(state.subscriptions.get("teacher-1").endsAt.getTime(), originalEnd);
});

test("unrelated unique errors are not acknowledged as duplicate payments", async (t) => {
  const { state, url, setThrowUniqueOnCreate } = await createPaymentApp(t);
  setThrowUniqueOnCreate(true);
  const response = await sendPayment(url);
  assert.equal(response.status, 500);
  assert.equal(state.events.size, 0);
  assert.equal(state.subscriptions.size, 0);
});

test("failed payment status is rejected and never extends a subscription", async (t) => {
  const { state, url } = await createPaymentApp(t);
  const response = await sendPayment(url, { status: "failed" });
  assert.equal(response.status, 400);
  assert.equal(state.events.size, 0);
  assert.equal(state.subscriptions.size, 0);
});
