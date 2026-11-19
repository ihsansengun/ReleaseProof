import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";

test("each call is charged at the price of the model that served it, per stage", () => {
  const budget = new Budget({ maxTokens: 10_000_000, maxUsd: 3, maxMinutes: 10 });
  const million = { input_tokens: 1_000_000, output_tokens: 0 };
  budget.enter("plan");
  budget.record(million, "claude-opus-5-5");
  budget.enter("execute");
  budget.record(million, "claude-sonnet-5-5");
  budget.record({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, "claude-sonnet-5-5");
  const summary = budget.summary();
  assert.equal(summary.byStage.plan!.usd, 4);
  assert.equal(Math.round(summary.byStage.execute!.usd * 100) / 100, 2.1);
  assert.equal(summary.estimatedUsd, 6.1);
  assert.match(budget.exceeded() ?? "", /cost limit of \$3 reached/);
  // A model with no listed price is charged at the default, never at zero.
  const other = new Budget();
  other.record(million, "some-future-model");
  assert.equal(other.summary().estimatedUsd, 4);
});
