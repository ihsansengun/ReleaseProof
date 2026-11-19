// Fixes that came out of the first routing benchmark: an observation used at
// two moments, amounts compared across units, a first attempt lost on
// escalation, passes that could not be examined, and a report line that
// promised evidence that is not published.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "../src/ci/report.ts";
import { tighten } from "../src/ci/run.ts";
import { briefing } from "../src/execute/briefing.ts";
import { closeSession, openSession } from "../src/execute/run.ts";
import { runTool } from "../src/execute/tools.ts";
import { buildDiagnostics, diagnosticLines, renderDiagnostics } from "../src/report/diagnostics.ts";
import { HAIKU, OPUS, routingFromEnv, SONNET } from "../src/routing.ts";
import { Manifest, type Analysis, type PlanDraft, type RunReport, type Scenario, type ScenarioResult } from "../src/schema.ts";
import { reconcile, scaleUnclear, showsCurrency } from "../src/units.ts";
import { validatePlan } from "../src/validate.ts";

const PAGE = `<h1>Checkout</h1>
<p>Order total: <strong>$21.60</strong></p>
<p>Items in order: 2</p>
<p>Reference total 21.6</p>`;

async function withPage<T>(scenario: Scenario, work: (run: (tool: string, input: unknown) => Promise<{ ok: boolean; output: string }>, session: Awaited<ReturnType<typeof openSession>>) => Promise<T>): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-rel-")) });
  try {
    await open.session.page.goto(baseUrl);
    const value = await work((tool, input) => runTool(open.session, tool, input), open);
    open.session.outcome ??= { kind: "completed", reason: "done" };
    return { value, result: await closeSession(open, { mode: "agent" }) };
  } finally {
    server.close();
  }
}
const page = (value: string, pattern?: string) => ({ source: "page", by: "text", value, count: false, read: "text", ...(pattern ? { pattern } : {}) });
const api = (responseId: string, jsonPath: string) => ({ source: "api", responseId, field: "body", jsonPath, count: false });
const scenario = (over: Partial<Scenario>): Scenario => ({ id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions: [], ...over });

test("units: a value is brought to the declared unit where the page shows its unit, and otherwise not compared", () => {
  assert.ok(showsCurrency("Order total: $21.60") && showsCurrency("21,60 EUR") && !showsCurrency("Reference total 21.6"));
  // No unit declared, or a plain number: taken as read.
  assert.deepEqual(reconcile(undefined, "$21.60", 21.6), { comparable: true, value: 21.6, converted: false });
  assert.deepEqual(reconcile("plain", "2 items", 2), { comparable: true, value: 2, converted: false });
  // A value written with a currency sign is in whole units; hundredths are obtained by conversion.
  assert.deepEqual(reconcile("currency-hundredths", "$21.60", 21.6), { comparable: true, value: 2160, converted: true });
  assert.deepEqual(reconcile("currency-units", "$21.60", 21.6), { comparable: true, value: 21.6, converted: false });
  // Hundredths expected, a fraction read, nothing says what it is: not comparable.
  const unclear = reconcile("currency-hundredths", "21.6", 21.6);
  assert.equal(unclear.comparable, false);
  // More precision than hundredths can hold: not comparable.
  assert.equal(reconcile("currency-hundredths", "$21.605", 21.605).comparable, false);
  // An integer with no sign is accepted as the declared unit.
  assert.deepEqual(reconcile("currency-hundredths", "2160", 2160), { comparable: true, value: 2160, converted: false });

  // A difference of exactly a factor of 100 with no unit shown proves nothing either way.
  assert.match(scaleUnclear("currency-units", "2160", 21.6, 2160)!, /factor of 100/);
  assert.match(scaleUnclear("currency-hundredths", "21", 2100, 21)!, /factor of 100/);
  // Any other difference is a real difference; so is one where the unit is shown, or the number is plain.
  assert.equal(scaleUnclear("currency-units", "2161", 21.6, 2161), undefined);
  assert.equal(scaleUnclear("currency-units", "$2160", 21.6, 2160), undefined);
  assert.equal(scaleUnclear("plain", "2160", 21.6, 2160), undefined);
  assert.equal(scaleUnclear("currency-units", "21.6", 21.6, 21.6), undefined);
});

test("an amount expected in hundredths and shown with a currency sign is converted and passes; without evidence nothing is recorded", async () => {
  const cents = { id: "A1", description: "order total", kind: "number_equals" as const, unit: "currency-hundredths" as const, expected: { literal: 2160 } };
  // The case from the benchmark: 2160 expected, "$21.60" on the page.
  const shown = await withPage(scenario({ assertions: [cents] }), (run) => run("check", { assertionId: "A1", target: page("Order total:"), rationale: "r" }));
  assert.ok(shown.value.ok, shown.value.output);
  assert.match(shown.value.output, /expected 2160, actual 2160 \(read as 21\.6, converted to the assertion's unit\) -> match/);
  assert.deepEqual([shown.result.assertionResults[0]!.actual, shown.result.assertionResults[0]!.readAs, shown.result.verdict], [2160, 21.6, "passed"]);
  // A real difference is still a failure after conversion.
  const wrong = await withPage(scenario({ assertions: [{ ...cents, expected: { literal: 2170 } }] }), (run) => run("check", { assertionId: "A1", target: page("Order total:"), rationale: "r" }));
  assert.equal(wrong.result.verdict, "failed");
  assert.match(wrong.result.reason, /expected 2170, got 2160/);

  // The same number with no sign beside it: the unit cannot be established. No result, so no failure and no pass.
  const bare = await withPage(scenario({ assertions: [cents] }), (run) => run("check", { assertionId: "A1", target: page("Reference total", "Reference total (\\S+)"), rationale: "r" }));
  assert.equal(bare.value.ok, false);
  assert.match(bare.value.output, /was not compared: hundredths were expected, and 21\.6 was read with no currency sign/);
  assert.deepEqual([bare.result.assertionResults.length, bare.result.verdict], [0, "unverified"]);

  // A pattern that cuts the sign off does not hide it: the unit is judged on the text the value came from.
  const cut = await withPage(scenario({ assertions: [cents] }), (run) => run("check", { assertionId: "A1", target: page("Order total:", "\\$(\\d+\\.\\d+)"), rationale: "r" }));
  assert.equal(cut.result.verdict, "passed");

  // From an API there is never a sign. A difference of exactly a factor of 100 is not reported as a defect.
  const fromApi = await withPage(scenario({ assertions: [{ ...cents, unit: "currency-units" as const, expected: { literal: 21.6 } }] }), async (run, open) => {
    open.session.apiResponses.set("R1", { status: 200, body: { total: 2160, other: 2161 } });
    return run("check", { assertionId: "A1", target: api("R1", "total"), rationale: "r" });
  });
  assert.match(fromApi.value.output, /was not compared: .*factor of 100/);
  assert.equal(fromApi.result.verdict, "unverified");

  // Plain numbers are compared as before.
  const count = await withPage(scenario({ assertions: [{ id: "A1", description: "items", kind: "number_equals" as const, expected: { literal: 3 } }] }), (run) => run("check", { assertionId: "A1", target: page("Items in order:"), rationale: "r" }));
  assert.equal(count.result.verdict, "failed");
});

test("an observation is one moment: a second reading is refused, and no formula may then rest on the stale value", async () => {
  const s = scenario({
    observations: [{ name: "subtotalAfterDrop", what: "cart subtotal", when: "right after the quantity is reduced", unit: "currency-hundredths" }],
    assertions: [
      { id: "A1", description: "total equals subtotal after the drop", kind: "number_equals", unit: "currency-hundredths", expected: { formula: "subtotalAfterDrop" } },
      { id: "A2", description: "total equals subtotal after restoring", kind: "number_equals", unit: "currency-hundredths", expected: { formula: "subtotalAfterDrop" } },
    ],
  });
  const { value, result } = await withPage(s, async (run, open) => {
    open.session.apiResponses.set("R1", { status: 200, body: { subtotal: 4800, total: 4800 } });
    open.session.apiResponses.set("R2", { status: 200, body: { subtotal: 7200, total: 7200 } });
    const out = [];
    out.push(await run("observe", { name: "somethingElse", target: api("R1", "subtotal"), rationale: "r" }));
    out.push(await run("observe", { name: "subtotalAfterDrop", target: api("R1", "subtotal"), rationale: "r" }));
    out.push(await run("check", { assertionId: "A1", target: api("R1", "total"), rationale: "r" }));
    // The state has changed and the executor reaches for the same name again, as in the benchmark.
    out.push(await run("observe", { name: "subtotalAfterDrop", target: api("R2", "subtotal"), rationale: "r" }));
    out.push(await run("check", { assertionId: "A2", target: api("R2", "total"), rationale: "r" }));
    return out;
  });
  assert.match(value[0]!.output, /The plan declares no observation "somethingElse"\. Declared: subtotalAfterDrop \(right after the quantity is reduced\)/);
  assert.match(value[1]!.output, /Recorded subtotalAfterDrop = 4800/);
  assert.match(value[2]!.output, /A1: expected 4800, actual 4800 -> match/);
  assert.match(value[3]!.output, /already recorded as 4800, for this moment: right after the quantity is reduced\. It cannot be recorded again/);
  // The comparison that was a false positive (7200 against a stale 4800) is not made at all.
  assert.match(value[4]!.output, /A2 cannot be checked: its formula uses subtotalAfterDrop, which the scenario needed at more than one moment/);
  assert.deepEqual(result.assertionResults.map((r) => [r.assertionId, r.pass]), [["A1", true]]);
  assert.equal(result.verdict, "unverified");

  // The executor is told each observation's moment.
  assert.match(briefing(s, Manifest.parse({ baseUrl: "http://localhost:1" }), {}), /- subtotalAfterDrop \(currency-hundredths\): cart subtotal\. When: right after the quantity is reduced/);
});

const analysis: Analysis = {
  featureSummary: "",
  requirements: [{ id: "R1", text: "r", kind: "documented", quote: "the total equals the subtotal", sourceId: "T2", trust: "authoritative", origin: "ticket", relation: "none" }],
  ambiguities: [],
  risks: [],
};
type DraftScenario = PlanDraft["scenarios"][number];
const draftAssertion = (over: Partial<DraftScenario["assertions"][number]>): DraftScenario["assertions"][number] => ({
  id: "A1", description: "total", kind: "number_equals", expectedNumber: null, expectedText: null, expectedFormula: "before - 100", unit: "currency-hundredths", requirementId: "R1", alsoVerifies: [], ...over,
});
const draft = (observations: DraftScenario["observations"], assertions: DraftScenario["assertions"]): PlanDraft => ({
  scenarios: [{ id: "S1", title: "t", basis: "requirement", requirementIds: ["R1"], riskIds: [], intent: "i", setup: "", fixtures: [], observations, status: "runnable", blockedReason: "", ambiguityIds: [], assertions }],
});
const validate = (d: PlanDraft) => validatePlan(d, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 5, { declared: true });

test("the plan must declare each observation once, with its moment and a unit the formula can use", () => {
  const before = { name: "before", what: "total", when: "before the code is applied", unit: "currency-hundredths" as const };
  const good = validate(draft([before], [draftAssertion({})]));
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.plan.scenarios[0]!.scenario.observations, [before]);
  assert.equal(good.plan.scenarios[0]!.scenario.assertions[0]!.unit, "currency-hundredths");

  // The same name for two moments.
  const twice = validate(draft([before, { ...before, when: "after the code is removed" }], [draftAssertion({})]));
  assert.match(twice.problems.join("\n"), /declares observation "before" more than once.*One name is one moment/);
  assert.equal(twice.plan.scenarios[0]!.scenario.observations!.length, 1);

  // A formula over a value nobody declared: the assertion goes, and with it the scenario's only comparison.
  const undeclared = validate(draft([], [draftAssertion({})]));
  assert.match(undeclared.problems.join("\n"), /uses before in its formula without declaring it as an observation/);
  assert.equal(undeclared.plan.scenarios[0]!.status, "blocked");

  // An amount in whole units combined with an expectation in hundredths.
  const mixed = validate(draft([{ ...before, unit: "currency-units" }], [draftAssertion({})]));
  assert.match(mixed.problems.join("\n"), /combines before \(currency-units\) with an expected value in currency-hundredths/);
  assert.match(mixed.plan.clarifications[0]!.question, /In which unit is this value shown/);
  assert.equal(mixed.plan.scenarios[0]!.scenario.assertions.length, 0);

  // A plain number may be combined with anything: a count times a price.
  const plain = validate(draft([before, { name: "count", what: "items", when: "at the start", unit: "plain" }], [draftAssertion({ expectedFormula: "before * count" })]));
  assert.deepEqual(plain.problems, []);

  // A plan recorded before observations were declared is taken as it is.
  const legacy = validatePlan(draft([], [draftAssertion({})]), analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 5);
  assert.deepEqual(legacy.problems, []);
  assert.equal(legacy.plan.scenarios[0]!.scenario.observations, undefined);
});

const result = (id: string, verdict: ScenarioResult["verdict"], reason: string, extra: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: id, title: `Scenario ${id}`, mode: "agent", verdict, reason, environment: { baseUrl: "http://10.0.0.2" }, assertionResults: [], observations: {},
  steps: [
    { tool: "click", input: { element: "Cancel" }, ok: true, summary: "page" },
    { tool: "api_request", input: { method: "POST", path: "/things/4/cancel" }, ok: true, summary: '{"status":403,"body":{"error":"not yours"}}' },
    { tool: "check", input: { assertionId: "A1" }, ok: true, summary: "Recorded A1: expected 403, actual 403 -> match." },
  ],
  evidence: { dir: "/home/runner/out/scenarios/x" }, startedAt: "2026-01-01T00:00:00Z", durationMs: 1, ...extra,
});
const runWith = (results: ScenarioResult[], escalations: RunReport["escalations"] = []): RunReport => ({
  ticketKey: "ABC-1", pullRequest: { repo: "acme/tool", number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://10.0.0.2" }, driver: "d", executionMode: "autonomous",
  context: { docs: [], changedFiles: [], omitted: [] }, analysis, analysisNotes: [],
  plan: { notes: [], clarifications: [], scenarios: results.map((r) => ({ status: "runnable" as const, blockedReason: "", ambiguityIds: [], riskIds: [], scenario: scenario({ id: r.scenarioId, title: r.title, assertions: [{ id: "A1", description: "status of the cancel call by another person", kind: "number_equals", expected: { literal: 403 }, requirementId: "R1" }] }) })) },
  results, confirmations: {}, escalations, timings: [], startedAt: "2026-01-01T00:00:00Z",
});

test("a scenario that passed keeps the readings and comparisons its pass rests on", () => {
  const passed = result("S5", "passed", "All 1 assertions matched.", {
    assertionResults: [{ assertionId: "A1", expected: 403, actual: 403, pass: true, target: { source: "api", responseId: "R1", field: "status" }, screenshot: "/home/runner/out/check-A1.png" }],
  });
  const d = buildDiagnostics(runWith([passed]));
  const s = d.scenarios[0]!;
  assert.equal(s.verdict, "passed");
  // What was compared, with what, located how, resting on which requirement.
  assert.deepEqual(
    [s.comparisons[0]!.outcome, s.comparisons[0]!.expected, s.comparisons[0]!.observed, s.comparisons[0]!.requirementId, s.comparisons[0]!.target],
    ["match", "403", "403", "R1", '{"source":"api","responseId":"R1","field":"status"}'],
  );
  // The steps that carry evidence: the call that exercised the rule and the application's answer, not the clicks.
  assert.deepEqual(s.lastSteps.map((x) => x.tool), ["api_request", "check"]);
  assert.match(s.lastSteps[0]!.result, /"status":403/);
  // Every step is in the JSON record.
  assert.equal(s.allSteps!.length, 3);
  const log = diagnosticLines(d).join("\n");
  assert.match(log, /diag\| S5 passed: Scenario S5/);
  assert.match(log, /A1 match: expected 403, observed 403 .* rests on R1/);
  assert.match(log, /located by \{"source":"api"/);
  assert.match(log, /step 2 api_request .*cancel.* -> ok: \{"status":403/);
  assert.match(renderDiagnostics(d), /Readings, comparisons and responses \(2\):/);
  assert.doesNotMatch(JSON.stringify(d) + log, /\/home\/runner/);

  // What did not pass is printed first, so a cut-off loses passes and not failures.
  const mixed = diagnosticLines(buildDiagnostics(runWith([passed, result("S6", "failed", "A1: expected 403, got 200")])));
  assert.match(mixed[0]!, /diag\| S6 failed/);
});

test("escalation keeps the attempt that was not kept, with its reason and steps", () => {
  const first = result("S3", "blocked", "Not checked: A1. The form never appeared after signing in.");
  const second = result("S3", "passed", "All 1 assertions matched. (re-run on the escalation model: the executor could not get through it)", {
    assertionResults: [{ assertionId: "A1", expected: 403, actual: 403, pass: true, target: {} }],
  });
  // The escalated run was kept: the first is still there, with why it was blocked.
  const replaced = buildDiagnostics(runWith([second], [{ scenarioId: "S3", why: "the executor could not get through it", before: "blocked", after: "passed", kept: "escalated run", other: first }]));
  assert.deepEqual(replaced.scenarios.map((s) => [s.id, s.verdict, s.attempt ?? "kept"]), [
    ["S3", "passed", "kept"],
    ["S3", "blocked", "first run, replaced by the escalated run (the executor could not get through it)"],
  ]);
  assert.match(replaced.scenarios[1]!.reason, /The form never appeared after signing in/);
  assert.equal(replaced.scenarios[1]!.allSteps!.length, 3);
  assert.match(diagnosticLines(replaced).join("\n"), /S3 blocked \[first run, replaced by the escalated run .*\]: Scenario S3\n.*why: Not checked: A1\. The form never appeared/);

  // The first run was kept: the escalated one is there too.
  const keptFirst = buildDiagnostics(runWith([result("S3", "failed", "A1: expected 403, got 200")], [{ scenarioId: "S3", why: "its failure was not reproduced", before: "failed", after: "failed", kept: "first run", other: second }]));
  assert.equal(keptFirst.scenarios[1]!.attempt, "escalated run, not kept (its failure was not reproduced)");
});

test("the report says which evidence is published, and a preset is only a maintainer's to choose", () => {
  const input = (evidence?: "sanitised" | "full") => ({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), evidence, run: runWith([result("S1", "passed", "ok", { assertionResults: [{ assertionId: "A1", expected: 403, actual: 403, pass: true, target: {} }] })]) }) as Parameters<typeof render>[0];
  const sanitised = render(input("sanitised"), "https://example.invalid/r").body;
  assert.match(sanitised, /Redacted record of every comparison and step, for passed and failed scenarios alike/);
  assert.match(sanitised, /Screenshots and unredacted step records are not published\./);
  assert.doesNotMatch(sanitised, /Full report, steps and screenshots/);
  assert.match(render(input("full"), "https://example.invalid/r").body, /Full report, steps and screenshots/);
  // A result from before the field existed is described as the cautious case.
  assert.match(render(input(undefined), "https://example.invalid/r").body, /not published/);

  // The benchmark preset: the dearest model for deciding what to test, at high effort; the rest unchanged.
  const preset = routingFromEnv({}, {}, "opus-planning");
  assert.deepEqual(preset.models, { analyse: OPUS, plan: OPUS, discover: HAIKU, execute: HAIKU, escalate: SONNET });
  assert.deepEqual([preset.efforts.analyse, preset.efforts.plan, preset.efforts.execute], ["high", "high", "medium"]);
  assert.deepEqual(routingFromEnv({}, {}, "default"), routingFromEnv({}));
  assert.throws(() => routingFromEnv({}, {}, "everything-on-opus"), /not a routing preset/);
  // A request carries only a known preset name; an unknown one is dropped.
  const limits = { limits: { maxTokens: 1, maxUsd: 2, maxMinutes: 1 }, maxScenarios: 1 };
  assert.equal(tighten(limits, { routing: "opus-planning" }).preset, "opus-planning");
  assert.equal(tighten(limits, { routing: "claude-opus-5-5" }).preset, undefined);
  // And the run's cost limit is untouched by it.
  assert.equal(tighten(limits, { routing: "opus-planning", maxUsd: "50" }).limits.maxUsd, 2);
});
