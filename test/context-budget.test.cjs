const test = require("node:test");
const assert = require("node:assert/strict");
const { RunContextBudget } = require("../dist/context/budget.js");

const charge = (content, fields = {}) => ({
  tool: "read_range", query: "q", path: "a.py", startLine: 1, endLine: 1, signal: "path_match", content, ...fields
});

test("the estimate is one token per four UTF-8 bytes rounded up, and every row carries the run's limit", () => {
  const budget = new RunContextBudget("run", 10);
  const ascii = budget.reserve(charge("abcde"));
  assert.equal(ascii.costTokens, 2);
  const multibyte = budget.reserve(charge("é", { startLine: 2, endLine: 2 }));
  assert.equal(multibyte.costTokens, 1);
  assert.deepEqual([ascii.limitTokens, multibyte.limitTokens, multibyte.cumulativeTokens], [10, 10, 3]);
  const over = budget.recordOverBudget(charge("x".repeat(100), { startLine: 3, endLine: 3 }));
  assert.equal(over.limitTokens, 10);
  assert.equal(over.exclusion, "over_budget");
});

test("duplicates and over-budget content are recorded but never charged or sent", () => {
  const budget = new RunContextBudget("run", 5);
  assert.equal(budget.reserve(charge("12345678")).sentToModel, true);
  const duplicate = budget.reserve(charge("12345678"));
  assert.deepEqual([duplicate.sentToModel, duplicate.costTokens, duplicate.exclusion], [false, 0, "duplicate"]);
  const tooBig = budget.reserve(charge("x".repeat(13), { startLine: 4, endLine: 4 }));
  assert.deepEqual([tooBig.sentToModel, tooBig.costTokens, tooBig.exclusion], [false, 0, "over_budget"]);
  assert.equal(budget.cumulativeTokens, 2);
  assert.equal(budget.reserve(charge("x".repeat(12), { startLine: 5, endLine: 5 })).sentToModel, true);
  assert.equal(budget.remainingTokens, 0);
});

test("concurrent reservations never spend more than the cap", async () => {
  const budget = new RunContextBudget("run", 100);
  const rows = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    Promise.resolve().then(() => budget.reserve(charge("x".repeat(28), { startLine: index + 1, endLine: index + 1 })))));
  const sent = rows.filter(row => row.sentToModel);
  assert.equal(sent.length, 14);
  assert.equal(budget.cumulativeTokens, 98);
  assert.ok(rows.every(row => row.cumulativeTokens <= row.limitTokens));
});

test("a zero budget sends nothing and invalid limits are rejected", () => {
  const empty = new RunContextBudget("run", 0);
  assert.equal(empty.reserve(charge("a")).sentToModel, false);
  assert.throws(() => new RunContextBudget("run", -1));
  assert.throws(() => new RunContextBudget("run", Number.NaN));
  assert.equal(new RunContextBudget("run", 99.9).limitTokens, 99);
});
