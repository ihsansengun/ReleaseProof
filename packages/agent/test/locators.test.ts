// Fixes that came out of routing benchmark C, where every wrong verdict but
// one came from how a value was located on the page: a section heading read
// in place of the value under it, "Total" matching "Subtotal", a message
// looked up under a role it does not have, and a model-free repeat of a wrong
// locator reported as if it confirmed a defect. No model is used here.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "../src/ci/report.ts";
import { replaySteps } from "../src/execute/replay.ts";
import { closeSession, openSession } from "../src/execute/run.ts";
import { runTool, wholeWords } from "../src/execute/tools.ts";
import { needsEscalation, setAsideDisagreements } from "../src/pipeline.ts";
import { buildDiagnostics, diagnosticLines } from "../src/report/diagnostics.ts";
import { contradicted, standings } from "../src/report/standing.ts";
import { Manifest, type Assertion, type PlanDraft, type RunReport, type Scenario, type ScenarioResult, type Step } from "../src/schema.ts";
import { validatePlan } from "../src/validate.ts";

const CART = `<h1>Cart</h1>
<section aria-label="Promotion">
  <h2>Promo code</h2>
  <p>Applied code: <strong data-testid="applied-code">SAVE10</strong></p>
  <label for="code">Voucher</label><input id="code" value="">
</section>
<section aria-label="Summary">
  <p>Subtotal: $60.00</p>
  <p>Discount (SAVE10): $15.00</p>
  <p>Total: $45.00</p>
</section>
<h2>Balance: 20 days</h2>
<p class="notice">Approved leave can only be cancelled at least 3 days before its first day.</p>
<table><tr><th>Status</th><td>Approved</td></tr></table>`;

// The same total shown twice, as a page with a cart summary and an order summary would.
const TWO_TOTALS = `<h1>Checkout</h1>
<section aria-label="Cart summary"><p>Subtotal: $60.00</p><p>Total: $45.00</p></section>
<section aria-label="Order summary"><p>Total: $48.00</p></section>`;

type Run = (tool: string, input: unknown) => Promise<{ ok: boolean; output: string }>;

async function withPage<T>(html: string, scenario: Scenario, work: (run: Run, steps: () => Step[]) => Promise<T>, replay?: Step[]): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-loc-")) });
  try {
    await open.session.page.goto(baseUrl);
    if (replay) await replaySteps(open.session, replay);
    const value = await work((tool, input) => runTool(open.session, tool, input), () => open.session.steps);
    open.session.outcome ??= { kind: "completed", reason: "done" };
    return { value, result: await closeSession(open, { mode: replay ? "replay" : "agent" }) };
  } finally {
    server.close();
  }
}

const byText = (value: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "text", value, count: false, read: "text", ...extra });
const byRole = (role: string, value: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "role", role, value, count: false, read: "text", ...extra });
const byTestId = (value: string) => ({ source: "page", by: "testid", value, count: false, read: "text" });
const scenario = (assertions: Assertion[], over: Partial<Scenario> = {}): Scenario => ({ id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions, ...over });
const check = (run: Run, assertionId: string, target: unknown) => run("check", { assertionId, target, rationale: "r" });

const appliedCode: Assertion = { id: "A1", description: "the cart shows the applied code", kind: "text_contains", expected: { literal: "SAVE10" }, requirementId: "R9" };

test("a section heading is refused where the applied code is expected, and the value under it is compared", async () => {
  const { value, result } = await withPage(CART, scenario([appliedCode]), async (run) => {
    // The benchmark's false positive: the heading "Promo code" read in place of the code.
    const heading = await check(run, "A1", byRole("heading", "Promo code"));
    const sameByText = await check(run, "A1", byText("Promo code"));
    const real = await check(run, "A1", byTestId("applied-code"));
    return { heading, sameByText, real };
  });
  assert.equal(value.heading.ok, false);
  assert.match(value.heading.output, /Assertion A1 expects a value, and the target is a heading: it names something and does not hold its value\..*No result was recorded\./);
  // The same element reached by its text is the same heading.
  assert.equal(value.sameByText.ok, false);
  assert.match(value.sameByText.output, /target is a heading/);
  // Nothing was recorded by the refusals, so the assertion could still be checked properly.
  assert.match(value.real.output, /expected SAVE10, actual SAVE10 -> match/);
  assert.equal(result.verdict, "passed");
  assert.equal(result.assertionResults.length, 1);
});

test("a refused heading never becomes a failure: with no better target the scenario ends unverified", async () => {
  const { result } = await withPage(CART, scenario([appliedCode]), async (run) => {
    await check(run, "A1", byRole("heading", "Promo code"));
  });
  assert.equal(result.verdict, "unverified");
  assert.deepEqual(result.assertionResults, []);
  assert.match(result.reason, /Not checked: A1/);
});

test("a genuinely wrong value still fails, on the page and in a heading that holds a value", async () => {
  const wrongCode: Assertion = { ...appliedCode, expected: { literal: "TAKE15" } };
  const balance: Assertion = { id: "A2", description: "balance after the refund", kind: "number_equals", expected: { literal: 23 }, requirementId: "R3" };
  const status: Assertion = { id: "A3", description: "status of the request", kind: "text_equals", expected: { literal: "Cancelled" }, requirementId: "R4" };
  const { value, result } = await withPage(CART, scenario([wrongCode, balance, status]), async (run) => {
    const code = await check(run, "A1", byTestId("applied-code"));
    // A heading that carries a value is refused as it stands and usable once a pattern picks the value out.
    const bare = await check(run, "A2", byText("Balance:"));
    const picked = await check(run, "A2", byText("Balance:", { pattern: "Balance: (\\d+) days" }));
    // A value located by its own current text is still an observation of the application.
    const cell = await check(run, "A3", byRole("cell", "Approved"));
    return { code, bare, picked, cell };
  });
  assert.match(value.code.output, /expected TAKE15, actual SAVE10 -> MISMATCH/);
  assert.equal(value.bare.ok, false);
  assert.match(value.bare.output, /give a pattern that picks the value out of this heading/);
  assert.match(value.picked.output, /expected 23, actual 20 -> MISMATCH/);
  assert.match(value.cell.output, /expected Cancelled, actual Approved -> MISMATCH/);
  assert.equal(result.verdict, "failed");
  assert.deepEqual(result.assertionResults.map((r) => [r.assertionId, r.pass]), [["A1", false], ["A2", false], ["A3", false]]);
});

test("an assertion declared to be about a heading or a label may read one, and must be pointed at one", async () => {
  const heading: Assertion = { id: "A1", description: "the section is titled Promo code", kind: "text_equals", subject: "heading", expected: { literal: "Promo code" }, requirementId: "R1" };
  const renamed: Assertion = { id: "A2", description: "the section is titled Discount code", kind: "text_equals", subject: "heading", expected: { literal: "Discount code" }, requirementId: "R1" };
  const label: Assertion = { id: "A3", description: "the field is labelled Voucher", kind: "text_equals", subject: "label", expected: { literal: "Voucher" }, requirementId: "R2" };
  const header: Assertion = { id: "A4", description: "the row header reads Status", kind: "text_equals", subject: "label", expected: { literal: "Status" }, requirementId: "R2" };
  const { value, result } = await withPage(CART, scenario([heading, renamed, label, header]), async (run) => {
    const matched = await check(run, "A1", byRole("heading", "Promo code"));
    // A heading assertion can fail like any other: the wording is the application's.
    const mismatched = await check(run, "A2", byRole("heading", "Promo code"));
    // It cannot be satisfied by some other element that happens to carry the words.
    const notALabel = await check(run, "A3", byTestId("applied-code"));
    const labelled = await check(run, "A3", byText("Voucher"));
    const th = await check(run, "A4", byText("Status"));
    return { matched, mismatched, notALabel, labelled, th };
  });
  assert.match(value.matched.output, /expected Promo code, actual Promo code -> match/);
  assert.match(value.mismatched.output, /expected Discount code, actual Promo code -> MISMATCH/);
  assert.equal(value.notALabel.ok, false);
  assert.match(value.notALabel.output, /Assertion A3 is about a label, and the target is not one/);
  assert.match(value.labelled.output, /expected Voucher, actual Voucher -> match/);
  assert.match(value.th.output, /expected Status, actual Status -> match/);
  assert.equal(result.verdict, "failed");
  assert.deepEqual(result.assertionResults.filter((r) => !r.pass).map((r) => r.assertionId), ["A2"]);

  // The planner's "subject" reaches the executor's assertion; "value" and existence checks carry none.
  const analysis: Parameters<typeof validatePlan>[1] = { featureSummary: "", requirements: [{ id: "R1", text: "r", kind: "documented", quote: "the section is titled Promo code", sourceId: "T2", trust: "authoritative", origin: "ticket", relation: "none" }], ambiguities: [], risks: [] };
  const draftAssertion = (id: string, subject: "value" | "heading" | undefined, kind: "text_equals" | "present") => ({ id, description: "d", kind, expectedNumber: null, expectedText: kind === "present" ? null : "Promo code", expectedFormula: null, unit: "plain" as const, ...(subject ? { subject } : {}), requirementId: "R1", alsoVerifies: [] });
  const draft: PlanDraft = { scenarios: [{ id: "S1", title: "t", basis: "requirement", requirementIds: ["R1"], riskIds: [], intent: "i", setup: "", fixtures: [], observations: [], status: "runnable", blockedReason: "", ambiguityIds: [], assertions: [draftAssertion("A1", "heading", "text_equals"), draftAssertion("A2", "value", "text_equals"), draftAssertion("A3", undefined, "text_equals"), draftAssertion("A4", "heading", "present")] }] };
  const planned = validatePlan(draft, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 5).plan.scenarios[0]!.scenario.assertions;
  assert.deepEqual(planned.map((a) => a.subject), ["heading", undefined, undefined, undefined]);
});

test("Total does not match Subtotal: text is matched on whole words", async () => {
  assert.ok(wholeWords("Total:").test("Total: $45.00") && !wholeWords("Total:").test("Subtotal: $45.00"));
  assert.ok(wholeWords("total").test("Order TOTAL  due") && !wholeWords("Total").test("Totals"));
  assert.ok(wholeWords("Order   total").test("order\n total") && wholeWords("$45.00").test("Total: $45.00"));

  const total: Assertion = { id: "A1", description: "cart total", kind: "number_equals", expected: { literal: 45 }, requirementId: "R1" };
  const wrongTotal: Assertion = { id: "A2", description: "cart total", kind: "number_equals", expected: { literal: 48 }, requirementId: "R1" };
  const { value, result } = await withPage(CART, scenario([total, wrongTotal], { observations: [{ name: "subtotal", what: "the subtotal", when: "at the start", unit: "plain" }] }), async (run) => {
    // In the benchmark this locator matched two elements, the Subtotal line and the Total line.
    const read = await check(run, "A1", byText("Total:"));
    // The Subtotal line is still reachable under its own name.
    const subtotal = await run("observe", { name: "subtotal", target: byText("Subtotal:"), rationale: "r" });
    // A total that really is wrong still fails.
    const genuine = await check(run, "A2", byText("Total:"));
    return { read, subtotal, genuine };
  });
  assert.match(value.read.output, /expected 45, actual 45 -> match/);
  assert.match(value.subtotal.output, /Recorded subtotal = 60/);
  assert.match(value.genuine.output, /expected 48, actual 45 -> MISMATCH/);
  assert.equal(result.verdict, "failed");
});

test("a target that matches more than one element is ambiguous: nothing is read until it is scoped", async () => {
  const total: Assertion = { id: "A1", description: "order total", kind: "number_equals", expected: { literal: 48 }, requirementId: "R1" };
  const unscoped = await withPage(TWO_TOTALS, scenario([total]), (run) => check(run, "A1", byText("Total:")));
  assert.equal(unscoped.value.ok, false);
  assert.match(unscoped.value.output, /Ambiguous target: expected exactly one element .* found 2\. Narrow it with "within", a role or a test id\. Nothing was read or done\./);
  // Ambiguity is not a failure of the application.
  assert.equal(unscoped.result.verdict, "unverified");
  assert.deepEqual(unscoped.result.assertionResults, []);

  const scoped = await withPage(TWO_TOTALS, scenario([total]), async (run) => {
    const order = await check(run, "A1", byText("Total:", { within: { by: "role", role: "region", value: "Order summary" } }));
    return order;
  });
  assert.match(scoped.value.output, /expected 48, actual 48 -> match/);
  assert.equal(scoped.result.verdict, "passed");

  // The right section with the wrong amount is a real failure, and a container that is itself ambiguous is refused.
  const cart = await withPage(TWO_TOTALS, scenario([total]), async (run) => {
    const vague = await check(run, "A1", byText("Total:", { within: { by: "text", value: "Total:" } }));
    const wrong = await check(run, "A1", byText("Total:", { within: { by: "role", role: "region", value: "Cart summary" } }));
    return { vague, wrong };
  });
  assert.equal(cart.value.vague.ok, false);
  assert.match(cart.value.vague.output, /Expected exactly one container .* found 2/);
  assert.match(cart.value.wrong.output, /expected 48, actual 45 -> MISMATCH/);
  assert.equal(cart.result.verdict, "failed");
});

test("a role that the element does not have cannot decide presence or absence while the text is on the page", async () => {
  const shown: Assertion = { id: "A1", description: "the refusal message is shown", kind: "present", requirementId: "R1" };
  const hidden: Assertion = { id: "A2", description: "no refusal message is shown", kind: "absent", requirementId: "R1" };
  const never: Assertion = { id: "A3", description: "a payment error is shown", kind: "present", requirementId: "R2" };
  const none: Assertion = { id: "A4", description: "no payment error is shown", kind: "absent", requirementId: "R2" };
  const message = "Approved leave can only be cancelled";
  const { value, result } = await withPage(CART, scenario([shown, hidden, never, none]), async (run) => {
    // The benchmark's false positive: "absent", because the message is not an alert.
    const asAlert = await check(run, "A1", byRole("alert", message));
    const asText = await check(run, "A1", byText(message));
    // The same wrong guess must not produce a false "absent" pass either.
    const absentAsAlert = await check(run, "A2", byRole("alert", message));
    const absentAsText = await check(run, "A2", byText(message));
    // Something that is nowhere on the page is absent, whichever way it is looked for.
    const missing = await check(run, "A3", byRole("alert", "Payment declined"));
    const missingToo = await check(run, "A4", byRole("alert", "Payment declined"));
    return { asAlert, asText, absentAsAlert, absentAsText, missing, missingToo };
  });
  assert.equal(value.asAlert.ok, false);
  assert.match(value.asAlert.output, /Assertion A1 was not compared: nothing matches .*"role":"alert".* but the same text is shown on the page in 1 other element\..*No result was recorded\./);
  assert.match(value.asText.output, /expected present, actual present -> match/);
  assert.equal(value.absentAsAlert.ok, false);
  assert.match(value.absentAsText.output, /expected absent, actual present -> MISMATCH/);
  assert.match(value.missing.output, /expected present, actual absent -> MISMATCH/);
  assert.match(value.missingToo.output, /expected absent, actual absent -> match/);
  assert.equal(result.verdict, "failed");
  assert.deepEqual(result.assertionResults.map((r) => [r.assertionId, r.pass]), [["A1", true], ["A2", false], ["A3", false], ["A4", true]]);
});

// ---- repeatability is not confirmation ------------------------------------

const total: Assertion = { id: "A1", description: "cart total after the discount", kind: "number_equals", expected: { literal: 45 }, requirementId: "R10" };
const apiTotal: Assertion = { id: "A2", description: "API total after the discount", kind: "number_equals", expected: { literal: 4500 }, requirementId: "R10" };
const discount: Assertion = { id: "A3", description: "discount line", kind: "number_equals", expected: { literal: 15 }, requirementId: "R13" };
const mismatch = (assertionId: string, target: unknown, actual: number | string = 60, expected: number | string = 45) => ({ assertionId, expected, actual, pass: false, target });
const failedWith = (assertionResults: ScenarioResult["assertionResults"], over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: "S1", title: "Scenario S1", mode: "agent", verdict: "failed", reason: "A1: expected 45, got 60", environment: { baseUrl: "http://localhost:1" },
  assertionResults, observations: {}, steps: [], evidence: { dir: "" }, startedAt: "2026-11-19T00:00:00Z", durationMs: 1, ...over,
});

test("a wrong locator that repeats is repeatable, not confirmed: it is sent for a second, independent attempt", async () => {
  // A locator the engine cannot fault: a real value element, but the wrong one (the subtotal line).
  const first = await withPage(CART, scenario([total]), async (run, steps) => {
    await check(run, "A1", byText("Subtotal:"));
    await run("finish", { outcome: "completed", reason: "done", rationale: "r" });
    return steps().slice();
  });
  assert.equal(first.result.verdict, "failed");

  // Replayed without a model on a fresh session, the same locator reads the same wrong element.
  const replay = await withPage(CART, scenario([total]), async () => undefined, first.value);
  assert.equal(replay.result.verdict, "failed");
  assert.deepEqual(replay.result.assertionResults.map((r) => [r.expected, r.actual]), [[45, 60]]);

  // That repeat used to settle the matter. It no longer does: one page reading through one locator stands alone.
  assert.deepEqual([...standings([total], first.result)], [["A1", "single"]]);
  assert.match(needsEscalation(first.result, "reproduced", [total])!, /repeats but rests on a single page observation that nothing else confirms/);
  // Without the plan's assertions (older callers), behaviour is as before.
  assert.equal(needsEscalation(first.result, "reproduced"), undefined);
  assert.match(needsEscalation(first.result, "replay diverged", [total])!, /not reproduced/);

  // A second attempt finds its own way to the value and it matches: two locators disagree.
  const second = await withPage(CART, scenario([total]), (run) => check(run, "A1", byText("Total:")));
  assert.equal(second.result.verdict, "passed");
  assert.equal(contradicted([total], first.result, second.result).length, 1);
});

test("a disagreement between two locators is set aside: not a defect, and never a pass", () => {
  const wrong = { source: "page", by: "text", value: "Subtotal:" };
  const right = { source: "page", by: "text", value: "Total:" };
  const first = failedWith([mismatch("A1", wrong)]);
  // The second attempt matched A1 through another element but did not finish, so it was not conclusive.
  const second = failedWith([{ assertionId: "A1", expected: 45, actual: 45, pass: true, target: right }], { verdict: "unverified", reason: "Not checked: A3." });
  const settled = setAsideDisagreements([total, discount], first, second)!;
  assert.equal(settled.verdict, "unverified");
  assert.match(settled.reason, /Not checked: A1, A3\. Two attempts located A1 differently and disagreed \(one mismatch, one match\), so the comparison was set aside as a locator disagreement, not counted as a defect\./);
  assert.deepEqual(settled.assertionResults, []);
  assert.deepEqual(settled.setAside, [{ assertionId: "A1", expected: 45, actual: 60, target: wrong, otherActual: 45, otherTarget: right }]);

  // A second attempt through the SAME locator is no second opinion.
  assert.equal(setAsideDisagreements([total], first, failedWith([{ assertionId: "A1", expected: 45, actual: 45, pass: true, target: wrong }], { verdict: "unverified" })), undefined);
  // Nor is one that never compared the assertion.
  assert.equal(setAsideDisagreements([total], first, failedWith([], { verdict: "blocked" })), undefined);

  // Other failures in the same scenario are untouched: it stays failed.
  const mixed = failedWith([mismatch("A1", wrong), mismatch("A2", { source: "api", responseId: "R1", field: "body", jsonPath: "totalCents" }, 6000, 4500)]);
  const stillFailed = setAsideDisagreements([total, apiTotal], mixed, second);
  // A1 is corroborated by the API reading of the same requirement, so it is not set aside at all.
  assert.equal(stillFailed, undefined);
  const unrelated = failedWith([mismatch("A1", wrong), mismatch("A3", { source: "api", responseId: "R1", field: "body", jsonPath: "discountCents" }, 0, 15)]);
  const partly = setAsideDisagreements([total, discount], unrelated, second)!;
  assert.equal(partly.verdict, "failed");
  assert.deepEqual(partly.assertionResults.map((r) => r.assertionId), ["A3"]);
  assert.deepEqual(partly.setAside!.map((s) => s.assertionId), ["A1"]);
});

test("a genuine defect keeps its standing: API evidence, a second comparison or a second attempt confirms it", () => {
  const pageTotal = { source: "page", by: "text", value: "Total:" };
  const checkoutTotal = { source: "page", by: "testid", value: "order-total" };
  const api = { source: "api", responseId: "R1", field: "body", jsonPath: "totalCents" };

  // The application's own response is evidence in itself, and no reason to spend a second attempt.
  const viaApi = failedWith([mismatch("A2", api, 3300, 4500)]);
  assert.deepEqual([...standings([apiTotal], viaApi)], [["A2", "state"]]);
  assert.equal(needsEscalation(viaApi, "reproduced", [apiTotal]), undefined);

  // Two comparisons of the same requirement through different targets back each other.
  const both = failedWith([mismatch("A1", pageTotal, 33), mismatch("A2", api, 3300, 4500)]);
  assert.deepEqual([...standings([total, apiTotal], both)], [["A1", "corroborated"], ["A2", "state"]]);
  assert.equal(needsEscalation(both, "reproduced", [total, apiTotal]), undefined);

  // The same target twice, or a failure of an unrelated requirement, backs nothing.
  const twice = failedWith([mismatch("A1", pageTotal, 33), mismatch("A1b", pageTotal, 33)]);
  assert.deepEqual([...standings([total, { ...total, id: "A1b" }], twice).values()], ["single", "single"]);
  const unrelated = failedWith([mismatch("A1", pageTotal, 33), mismatch("A3", { source: "page", by: "text", value: "Discount" }, 0, 15)]);
  assert.deepEqual([...standings([total, discount], unrelated).values()], ["single", "single"]);
  assert.ok(needsEscalation(unrelated, "reproduced", [total, discount]));

  // A second attempt that reaches the value another way and sees the same mismatch confirms it.
  const alone = failedWith([mismatch("A1", pageTotal, 33)]);
  const again = failedWith([mismatch("A1", checkoutTotal, 33)]);
  assert.deepEqual([...standings([total], alone, again)], [["A1", "re-resolved"]]);
  assert.deepEqual([...standings([total], alone, alone)], [["A1", "single"]]);
  // And nothing is set aside when both attempts saw the defect.
  assert.equal(setAsideDisagreements([total], alone, again), undefined);
});

test("reports word the model-free repeat as repeatability and say what stands behind each mismatch", () => {
  const plan = { scenarios: [{ scenario: scenario([total, apiTotal]), status: "runnable", riskIds: [], ambiguityIds: [], blockedReason: "" }], clarifications: [] };
  const analysis = { requirements: [{ id: "R10", kind: "documented", trust: "authoritative", text: "Total equals subtotal minus discount", quote: "a Total that equals subtotal minus discount", sourceId: "T1", origin: "ticket" }], ambiguities: [], risks: [] };
  const failed = failedWith([{ ...mismatch("A1", { source: "page", by: "text", value: "Total:" }, 33), standing: "single" }, { ...mismatch("A2", { source: "api" }, 3300, 4500), standing: "state" }]);
  const aside = failedWith([], { scenarioId: "S2", verdict: "unverified", reason: "Not checked: A1.", setAside: [{ assertionId: "A1", expected: 45, actual: 60, target: {}, otherActual: 45, otherTarget: {} }] });
  const run = {
    ticketKey: "T-1", pullRequest: { number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://localhost:1", deployedSha: "a".repeat(40) },
    context: { sources: [] }, analysis, analysisNotes: [], plan, results: [failed, aside], confirmations: { S1: "reproduced" }, timings: [], startedAt: "2026-11-19T00:00:00Z", executionMode: "autonomous",
  } as unknown as RunReport;

  const body = render({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), run } as Parameters<typeof render>[0], "https://example.invalid/r").body;
  assert.match(body, /Repeatability \(the same steps and locators replayed without a model\): repeats\. This shows whether the result is stable, not whether the locators were right\./);
  assert.doesNotMatch(body, /reproduced|Repeated without a model/);
  assert.match(body, /Standing: a single page observation; not independently confirmed, so check the locator before treating it as a defect\./);
  assert.match(body, /Standing: read from the application's own API response\./);
  assert.match(body, /### Comparisons set aside[\s\S]*not evidence of a defect, and not a pass either[\s\S]*\*\*S2\/A1\*\*: expected `45`; one attempt read `60`, the other `45`/);

  const log = diagnosticLines(buildDiagnostics(run)).join("\n");
  assert.match(log, /repeatability \(same locators, no model\): reproduced/);
  assert.match(log, /A1 mismatch.*standing: single/);
  assert.match(log, /A2 mismatch.*standing: state/);
});
