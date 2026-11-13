import assert from "node:assert/strict";
import test from "node:test";
import { calculateTokenCost, tokenRates } from "../src/token-pricing.ts";

test("fixed rates are applied by question type and quantity, not marks", () => {
  assert.deepEqual(tokenRates, { MCQ: 1, CQ: 10, SHORT: 5 });
  assert.equal(calculateTokenCost([
    { type: "MCQ" },
    { type: "MCQ" },
    { type: "CQ" },
    { type: "SHORT" },
  ]), 17);
});

test("unsupported question types cannot be priced", () => {
  assert.throws(() => calculateTokenCost([{ type: "CREATIVE" }]), /No token rate/);
});
