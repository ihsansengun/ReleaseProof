// Model routing, spending limits and escalation. None of this may change a
// verdict: these tests cover which model is asked, what a call may cost, when
// a run stops, and which scenarios get a second attempt.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { Budget, BudgetExceeded, DEFAULT_PRICES, pricesFor, stageLimitsFromEnv } from "../src/budget.ts";
import { EXECUTOR_MODELS, tighten } from "../src/ci/run.ts";
import { ApiDriver } from "../src/drivers/driver.ts";
import type { Session } from "../src/execute/tools.ts";
import { needsEscalation } from "../src/pipeline.ts";
import { DEFAULT_ROUTING, describeRouting, HAIKU, OPUS, routingFromEnv, SONNET, supportsFallbacks } from "../src/routing.ts";
import type { ScenarioResult } from "../src/schema.ts";
import { SecretVault } from "../src/secrets.ts";

test("by default no stage uses the dearest model, and each stage can be set on its own", () => {
  const routing = routingFromEnv({});
  assert.deepEqual(routing.models, { analyse: SONNET, plan: SONNET, discover: HAIKU, execute: HAIKU, escalate: SONNET });
  assert.deepEqual(routing, DEFAULT_ROUTING);
  assert.ok(!Object.values(routing.models).includes(OPUS));
  assert.equal(describeRouting(routing), `${SONNET} (analysis and planning), ${HAIKU} (discovery and execution), ${SONNET} (escalation)`);

  // One stage, every stage, and one stage over every stage.
  assert.equal(routingFromEnv({ RELEASEPROOF_MODEL_EXECUTE: SONNET }).models.execute, SONNET);
  assert.deepEqual(new Set(Object.values(routingFromEnv({ RELEASEPROOF_MODEL: SONNET }).models)), new Set([SONNET]));
  const mixed = routingFromEnv({ RELEASEPROOF_MODEL: SONNET, RELEASEPROOF_MODEL_DISCOVER: HAIKU });
  assert.deepEqual([mixed.models.discover, mixed.models.execute], [HAIKU, SONNET]);
  // An unset or empty variable means the default, as an unset repository variable arrives empty.
  assert.equal(routingFromEnv({ RELEASEPROOF_MODEL_PLAN: "", RELEASEPROOF_MODEL: "  " }).models.plan, SONNET);
  // A request's choice of executor wins over the environment for that stage only.
  assert.deepEqual(routingFromEnv({ RELEASEPROOF_MODEL_EXECUTE: HAIKU }, { execute: SONNET }).models, { ...DEFAULT_ROUTING.models, execute: SONNET });

  // Effort per stage.
  const efforts = routingFromEnv({ RELEASEPROOF_EFFORT: "low", RELEASEPROOF_EFFORT_ANALYSE: "high" }).efforts;
  assert.deepEqual([efforts.analyse, efforts.plan, efforts.execute], ["high", "low", "low"]);
  assert.equal(routingFromEnv({ RELEASEPROOF_ESCALATION: "off" }).escalation, false);
});

test("an unknown model, an unknown effort or the dearest model without permission is an error, never a silent fallback", () => {
  assert.throws(() => routingFromEnv({ RELEASEPROOF_MODEL_EXECUTE: "claude-haiku" }), /not a model this system uses for the execute stage/);
  assert.throws(() => routingFromEnv({ RELEASEPROOF_MODEL: "gpt-something" }), /not a model/);
  assert.throws(() => routingFromEnv({ RELEASEPROOF_EFFORT_PLAN: "extreme" }), /not an effort level for the plan stage/);
  assert.throws(() => routingFromEnv({ RELEASEPROOF_MODEL_ESCALATE: OPUS }), /escalate stage is set to claude-opus-5-5, which is off unless RELEASEPROOF_ALLOW_OPUS is "on"/);
  assert.throws(() => routingFromEnv({ RELEASEPROOF_MODEL: OPUS }), /off unless RELEASEPROOF_ALLOW_OPUS/);
  assert.equal(routingFromEnv({ RELEASEPROOF_MODEL_ESCALATE: OPUS, RELEASEPROOF_ALLOW_OPUS: "on" }).models.escalate, OPUS);
  // A request cannot choose the dearest model for execution at all.
  assert.ok(!EXECUTOR_MODELS.includes(OPUS));
  assert.equal(tighten({ limits: { maxTokens: 1, maxUsd: 2, maxMinutes: 1 }, maxScenarios: 1 }, { executorModel: OPUS }).executorModel, undefined);
  assert.equal(tighten({ limits: { maxTokens: 1, maxUsd: 2, maxMinutes: 1 }, maxScenarios: 1 }, { executorModel: SONNET }).executorModel, SONNET);
  // Declined requests are re-run by the API only for the models that support it.
  assert.deepEqual([supportsFallbacks(SONNET), supportsFallbacks(OPUS), supportsFallbacks(HAIKU)], [true, true, false]);
});

test("cost counts input, output, cache reads and cache writes, on the long-prompt rate card where it applies", () => {
  const usd = (model: string, usage: Parameters<Budget["record"]>[0]) => {
    const budget = new Budget({ maxTokens: 1e9, maxUsd: 100, maxMinutes: 10 }, DEFAULT_PRICES);
    budget.record(usage, model);
    return budget.costUsd();
  };
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  // Every kind of token is charged.
  close(usd(HAIKU, { input_tokens: 100_000, output_tokens: 0 }), 0.01);
  close(usd(HAIKU, { input_tokens: 0, output_tokens: 1_000_000 }), 0.5);
  close(usd(SONNET, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }), 0.1);
  close(usd(SONNET, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }), 2.5);
  // A prompt of 100,000 tokens or fewer is on the first card, counting cached tokens as part of the prompt.
  close(usd(HAIKU, { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 10_000 }), (10_000 * 0.1 + 1_000 * 0.5 + 80_000 * 0.01 + 10_000 * 0.125) / 1e6);
  // One token more and the whole request, output included, is on the second.
  close(usd(HAIKU, { input_tokens: 10_001, output_tokens: 1_000, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 10_000 }), (10_001 * 0.5 + 1_000 * 2.5 + 80_000 * 0.05 + 10_000 * 0.625) / 1e6);
  assert.deepEqual(pricesFor(HAIKU, 100_000).input, 0.1);
  assert.deepEqual(pricesFor(HAIKU, 100_001).input, 0.5);
  assert.deepEqual(pricesFor(SONNET, 500_000).input, 2);
  // A model nobody priced is charged at the dearest known rates, so it can only be over-estimated.
  close(usd("some-new-model", { input_tokens: 1_000_000, output_tokens: 0 }), DEFAULT_PRICES.input);
});

test("a call that could pass the limit is refused before it is made, for the run and for a stage", () => {
  // Once a limit has been reached, that is reported as before.
  const spent = new Budget({ maxTokens: 1e9, maxUsd: 1, maxMinutes: 10 }, DEFAULT_PRICES);
  spent.enter("execute");
  spent.record({ input_tokens: 0, output_tokens: 180_000 }, SONNET);
  assert.match(spent.exceeded()!, /cost limit of \$1 reached/);

  const run = new Budget({ maxTokens: 1e9, maxUsd: 1, maxMinutes: 10, stageUsd: { escalate: 0.4 } }, DEFAULT_PRICES);
  run.enter("execute");
  run.record({ input_tokens: 0, output_tokens: 90_000 }, SONNET); // $0.90 spent, under the limit
  assert.equal(run.exceeded(), undefined);
  // The worst case of the next call: the whole prompt written to cache, the whole output allowance used.
  const worst = Budget.worstCase(SONNET, 30_000, 8_000);
  assert.ok(Math.abs(worst - (30_000 * 2.5 + 8_000 * 10) / 1e6) < 1e-9);
  assert.match(run.refuses(worst)!, /cost limit of \$1 would be passed by the next model call/);
  assert.equal(run.refuses(Budget.worstCase(HAIKU, 30_000, 8_000)), undefined, "a cheaper call still fits");
  assert.ok(Math.abs(run.remainingUsd() - 0.1) < 1e-9);
  // The long-prompt card is used for the worst case as well.
  assert.ok(Math.abs(Budget.worstCase(HAIKU, 200_000, 1_000) - (200_000 * 0.625 + 1_000 * 2.5) / 1e6) < 1e-9);

  // A stage with its own ceiling stops at it although the run has money left.
  const staged = new Budget({ maxTokens: 1e9, maxUsd: 2, maxMinutes: 10, stageUsd: { escalate: 0.4 } }, DEFAULT_PRICES);
  staged.enter("escalate");
  staged.record({ input_tokens: 0, output_tokens: 35_000 }, SONNET); // $0.35 in this stage
  assert.equal(staged.exceeded(), undefined);
  assert.match(staged.refuses(0.1)!, /the escalate stage's limit of \$0\.4 would be passed/);
  assert.ok(Math.abs(staged.remainingUsd() - 0.05) < 1e-9);
  staged.enter("execute");
  assert.equal(staged.refuses(0.1), undefined, "other stages are unaffected");

  // Stage ceilings: escalation is held to two fifths of the run's limit unless set, and never above the run's.
  assert.deepEqual(stageLimitsFromEnv({}, 2), { escalate: 0.8 });
  assert.deepEqual(stageLimitsFromEnv({ RELEASEPROOF_MAX_USD_ESCALATE: "0.25", RELEASEPROOF_MAX_USD_EXECUTE: "9", RELEASEPROOF_MAX_USD_PLAN: "x" }, 2), { escalate: 0.25, execute: 2 });
});

// ---- the driver, against a local stand-in for the model API

type Seen = { body: { model?: string; max_tokens?: number; output_config?: { effort?: string }; fallbacks?: unknown; betas?: unknown } };
async function fakeApi(responses: unknown[]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ body });
      const message = responses.shift() as { content: { text?: string }[]; stop_reason: string; usage: { output_tokens: number } } | undefined;
      if (!message) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nothing scripted" } }));
      }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(message));
      }
      const events: [string, unknown][] = [
        ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: message.content[0]!.text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }],
        ["message_stop", { type: "message_stop" }],
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const reply = (content: unknown[], stop_reason: string, model: string) => ({ id: "m", type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });
const finish = { type: "tool_use", id: "t1", name: "finish", input: { outcome: "completed", reason: "done", rationale: "r" } };
const session = () => ({ steps: [], assertionResults: [], observations: {}, vault: new SecretVault(), scenario: { assertions: [] } }) as unknown as Session;
const job = { name: "S1", system: "sys", briefing: "do it", tools: ["navigate", "finish"] as const, maxToolCalls: 5 };

test("each stage's request goes to that stage's model at that stage's effort", async () => {
  const api = await fakeApi([
    reply([{ type: "text", text: '{"n":1}' }], "end_turn", SONNET),
    reply([{ type: "text", text: '{"n":2}' }], "end_turn", SONNET),
    reply([finish], "tool_use", HAIKU),
    reply([finish], "tool_use", HAIKU),
    reply([finish], "tool_use", SONNET),
  ]);
  const budget = new Budget({ maxTokens: 1e9, maxUsd: 2, maxMinutes: 10 }, DEFAULT_PRICES);
  const routing = routingFromEnv({ RELEASEPROOF_EFFORT_ANALYSE: "high" });
  const driver = new ApiDriver({ routing, budget, client: { baseURL: api.url, apiKey: "k" } });
  try {
    const schema = z.object({ n: z.number() });
    await driver.task({ name: "analyse", instructions: "i", input: "x", schema });
    await driver.task({ name: "plan-repair", instructions: "i", input: "x", schema });
    await driver.session(session(), { ...job, stage: "discover" });
    await driver.session(session(), job);
    await driver.session(session(), { ...job, stage: "escalate" });
    assert.deepEqual(api.seen.map((s) => s.body.model), [SONNET, SONNET, HAIKU, HAIKU, SONNET]);
    assert.deepEqual(api.seen.map((s) => s.body.output_config?.effort), ["high", "medium", "low", "medium", "medium"]);
    // The fallback parameters go only to a model that accepts them.
    assert.deepEqual(api.seen.slice(2).map((s) => s.body.fallbacks), [undefined, undefined, "default"]);
    // Each call was charged at the price of the model that served it.
    const expected = (3 * (100 * 2 + 20 * 10) + 2 * (100 * 0.1 + 20 * 0.5)) / 1e6;
    assert.ok(Math.abs(budget.costUsd() - expected) < 1e-9);
    assert.equal(driver.label, describeRouting(routing));
  } finally {
    api.server.close();
  }
});

test("a session or task that the remaining budget cannot cover makes no call, and says why", async () => {
  const api = await fakeApi([]);
  try {
    // Sonnet's worst case for one turn is well over three cents, and three
    // cents buys less output than a planning call is worth starting with.
    const tight = new Budget({ maxTokens: 1e9, maxUsd: 0.03, maxMinutes: 10 }, DEFAULT_PRICES);
    const driver = new ApiDriver({ routing: routingFromEnv({ RELEASEPROOF_MODEL: SONNET }), budget: tight, client: { baseURL: api.url, apiKey: "k" } });
    const s = session();
    await driver.session(s, job);
    assert.equal((s.outcome as { kind: string }).kind, "stopped");
    assert.match((s.outcome as { reason: string }).reason, /Run budget exhausted: cost limit of \$0\.03 would be passed by the next model call/);
    await assert.rejects(driver.task({ name: "plan", instructions: "i", input: "x", schema: z.object({}) }), BudgetExceeded);
    assert.equal(api.seen.length, 0);
    assert.equal(tight.costUsd(), 0);
  } finally {
    api.server.close();
  }
  // With some budget left, a task's output allowance is cut to what that budget can pay for.
  const partial = await fakeApi([reply([{ type: "text", text: "{}" }], "end_turn", SONNET)]);
  try {
    const budget = new Budget({ maxTokens: 1e9, maxUsd: 0.1, maxMinutes: 10 }, DEFAULT_PRICES);
    await new ApiDriver({ routing: DEFAULT_ROUTING, budget, client: { baseURL: partial.url, apiKey: "k" } }).task({ name: "plan", instructions: "i", input: "x", schema: z.object({}) });
    const allowed = partial.seen[0]!.body.max_tokens!;
    assert.ok(allowed < 32_000 && allowed >= 4_000, String(allowed));
    assert.ok(allowed * 10 / 1e6 <= 0.1);
  } finally {
    partial.server.close();
  }
});

test("escalation is for uncertainty: a failure that reproduced stays a failure", () => {
  const result = (verdict: ScenarioResult["verdict"], reason = "r", steps = 3) => ({ verdict, reason, steps: Array(steps).fill({}) }) as unknown as ScenarioResult;
  // Conclusive: no second attempt.
  assert.equal(needsEscalation(result("passed"), undefined), undefined);
  assert.equal(needsEscalation(result("failed"), "reproduced"), undefined);
  // Inconclusive evidence.
  assert.match(needsEscalation(result("failed"), "replay diverged")!, /not reproduced by the repeat without a model \(replay diverged\)/);
  assert.match(needsEscalation(result("failed"), "not reproduced")!, /not reproduced/);
  assert.match(needsEscalation(result("failed"), undefined)!, /no repeat/);
  // Uncertainty and blocked execution.
  assert.match(needsEscalation(result("unverified", "Not checked: A1. Step budget of 60 tool calls exhausted."), undefined)!, /without completing its comparisons/);
  assert.match(needsEscalation(result("blocked", "Not checked: A1. The page never showed the form."), undefined)!, /could not get through it/);
  // Not a matter of model ability: nothing was executed, or the money ran out.
  assert.equal(needsEscalation(result("blocked", "The application could not be started for this scenario", 0), undefined), undefined);
  assert.equal(needsEscalation(result("unverified", "Not checked: A1. Run budget exhausted: cost limit of $2 would be passed by the next model call."), undefined), undefined);
});
