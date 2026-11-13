import assert from "node:assert/strict";
import test from "node:test";
import { selectCqQuestionsBySet, selectExactQuestions, selectRandomQuestions } from "../src/paper-generator.ts";

test("auto selection finds an exact total across questions with different marks", () => {
  const result = selectExactQuestions([
    { id: "q1", marks: 3 },
    { id: "q2", marks: 5 },
    { id: "q3", marks: 7 },
  ], 10);

  assert.equal(result.exact, true);
  assert.equal(result.questions.reduce((total, question) => total + question.marks, 0), 10);
  assert.deepEqual(result.questions.map(({ id }) => id), ["q1", "q3"]);
});

test("auto selection reports nearest achievable totals when an exact total is impossible", () => {
  const result = selectExactQuestions([
    { id: "q1", marks: 4 },
    { id: "q2", marks: 7 },
  ], 8);

  assert.deepEqual(result, { exact: false, lower: 7, higher: 11 });
});

test("auto selection excludes zero and invalid marks", () => {
  const result = selectExactQuestions([
    { id: "zero", marks: 0 },
    { id: "invalid", marks: Number.NaN },
    { id: "valid", marks: 2 },
  ], 2);

  assert.equal(result.exact, true);
  assert.deepEqual(result.questions.map(({ id }) => id), ["valid"]);
});

test("auto selection respects the 500-question paper limit", () => {
  const result = selectExactQuestions(
    Array.from({ length: 501 }, (_, index) => ({ id: `q${index}`, marks: 1 })),
    501,
  );

  assert.equal(result.exact, false);
  assert.equal(result.lower, 500);
  assert.equal(result.higher, null);
});

test("CQ auto selection respects the existing 12-question layout limit", () => {
  const result = selectExactQuestions(
    Array.from({ length: 13 }, (_, index) => ({ id: `cq${index}`, marks: 1 })),
    13,
    12,
  );

  assert.equal(result.exact, false);
  assert.equal(result.lower, 12);
  assert.equal(result.higher, null);
});

test("random selection returns the requested number of unique eligible questions", () => {
  const questions = Array.from({ length: 20 }, (_, index) => ({ id: `q${index}` }));
  const selected = selectRandomQuestions(questions, 7);

  assert.equal(selected.length, 7);
  assert.equal(new Set(selected.map(({ id }) => id)).size, 7);
  assert.ok(selected.every((question) => questions.includes(question)));
});

test("CQ Set 2, 3, and 4 distribute exact counts without duplicate questions", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `cq-${index}`,
    chapter: `Chapter ${index % 4 + 1}`,
  }));
  for (const setCount of [2, 3, 4]) {
    const sets = Array.from({ length: setCount }, (_, index) => ({
      setNumber: index + 1,
      chapters: [`Chapter ${index + 1}`],
      questionCount: 1,
    }));
    const result = selectCqQuestionsBySet(questions, sets);

    assert.ok(!("error" in result));
    assert.equal(result.questions.length, setCount);
    assert.equal(new Set(result.questions.map(({ id }) => id)).size, setCount);
    assert.deepEqual(result.assignments.map(({ setNumber }) => setNumber), sets.map(({ setNumber }) => setNumber));
    assert.ok(result.questions.every((question, index) =>
      sets[index].chapters.includes(question.chapter)));
  }
});

test("CQ set selection reallocates overlapping chapter candidates to avoid false shortages", () => {
  const questions = [
    { id: "shared-1", chapter: "A" },
    { id: "shared-2", chapter: "A" },
    { id: "other", chapter: "B" },
  ];
  const result = selectCqQuestionsBySet(questions, [
    { setNumber: 1, chapters: ["A", "B"], questionCount: 2 },
    { setNumber: 2, chapters: ["A"], questionCount: 1 },
  ]);

  assert.ok(!("error" in result));
  assert.equal(new Set(result.questions.map(({ id }) => id)).size, 3);
  assert.deepEqual(result.assignments.map(({ setNumber }) => setNumber), [1, 1, 2]);
  assert.ok(result.questions.some((question, index) =>
    result.assignments[index].setNumber === 1 && question.chapter === "B"));
});

test("CQ set selection reports a shortage when distinct questions cannot fill every set", () => {
  const result = selectCqQuestionsBySet(
    [{ id: "only-question", chapter: "Shared" }],
    [
      { setNumber: 1, chapters: ["Shared"], questionCount: 1 },
      { setNumber: 2, chapters: ["Shared"], questionCount: 1 },
    ],
  );

  assert.deepEqual(result, {
    error: { setNumber: 2, availableCount: 0, requestedCount: 1 },
  });
});

test("CQ set selection rejects duplicate submitted assignments", () => {
  const result = selectCqQuestionsBySet(
    [{ id: "one", chapter: "A" }],
    [{ setNumber: 1, chapters: ["A"], questionCount: 2 }],
    [
      { questionId: "one", setNumber: 1 },
      { questionId: "one", setNumber: 1 },
    ],
  );

  assert.ok("error" in result);
});
