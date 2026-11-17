import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFormula, formulaVariables } from "../src/formula.ts";

test("arithmetic, precedence and functions", () => {
  assert.equal(evaluateFormula("1 + 2 * 3", {}), 7);
  assert.equal(evaluateFormula("(1 + 2) * 3", {}), 9);
  assert.equal(evaluateFormula("-4 + 10 / 4", {}), -1.5);
  assert.equal(evaluateFormula("floor(24.99) + max(1, 2, 3)", {}), 27);
});

test("variables are substituted", () => {
  assert.equal(evaluateFormula("100 + floor(a) + floor(b)", { a: 24.99, b: 59.5 }), 183);
  assert.deepEqual(formulaVariables("100 + floor(a) + min(b, a)"), ["a", "b"]);
});

test("missing observations and bad syntax are errors, not values", () => {
  assert.throws(() => evaluateFormula("a + 1", {}), /Missing observation "a"/);
  assert.throws(() => evaluateFormula("1 +", {}), /syntax/);
  assert.throws(() => evaluateFormula("1 2", {}), /unexpected/);
  assert.throws(() => evaluateFormula("1 / 0", {}), /finite/);
});

test("nothing beyond arithmetic is reachable", () => {
  assert.throws(() => evaluateFormula("constructor", {}), /Missing observation/);
  assert.throws(() => evaluateFormula("process.exit(1)", {}), /Unexpected character/);
  assert.throws(() => evaluateFormula("eval(1)", {}), /Unknown function/);
});
