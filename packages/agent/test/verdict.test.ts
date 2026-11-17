import assert from "node:assert/strict";
import { test } from "node:test";
import { computeVerdict } from "../src/execute/verdict.ts";
import type { Assertion, AssertionResult } from "../src/schema.ts";

const assertions: Assertion[] = [
  { id: "A1", description: "first", kind: "number_equals", expected: { literal: 1 } },
  { id: "A2", description: "second", kind: "number_equals", expected: { literal: 2 } },
];
const result = (assertionId: string, pass: boolean): AssertionResult => ({
  assertionId,
  expected: 1,
  actual: pass ? 1 : 9,
  pass,
  target: {},
});
const completed = { kind: "completed", reason: "done" } as const;

test("passed only when every assertion was compared and matched", () => {
  assert.equal(computeVerdict(assertions, [result("A1", true), result("A2", true)], completed).verdict, "passed");
});

test("a mismatch fails the scenario whatever the executor reports", () => {
  const v = computeVerdict(assertions, [result("A1", true), result("A2", false)], completed);
  assert.equal(v.verdict, "failed");
  assert.match(v.reason, /A2: expected 1, got 9/);
  // Even when other assertions were never reached.
  assert.equal(computeVerdict(assertions, [result("A1", false)], { kind: "blocked", reason: "x" }).verdict, "failed");
});

test("claiming completion without checking everything is not a pass", () => {
  const v = computeVerdict(assertions, [result("A1", true)], completed);
  assert.equal(v.verdict, "unverified");
  assert.match(v.reason, /Not checked: A2/);
});

test("an obstacle reported by the executor is blocked; running out of steps is unverified", () => {
  assert.equal(computeVerdict(assertions, [], { kind: "blocked", reason: "login failed" }).verdict, "blocked");
  assert.equal(computeVerdict(assertions, [], { kind: "stopped", reason: "budget" }).verdict, "unverified");
});
