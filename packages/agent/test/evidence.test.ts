// What routing benchmark C left open after the locator fixes: evidence that
// had to be pieced together from the last few logged steps, a boundary that
// was never run, values found by searching for the expected value, and a
// failure table that read like a defect count. Each case below is taken from
// that benchmark. No model is used.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "../src/ci/report.ts";
import { closeSession, openSession } from "../src/execute/run.ts";
import { circular, runTool } from "../src/execute/tools.ts";
import { buildDiagnostics, diagnosticLines, renderDiagnostics } from "../src/report/diagnostics.ts";
import { failureCounts, failurePatterns } from "../src/report/patterns.ts";
import { assess } from "../src/report/readiness.ts";
import { Manifest, type Analysis, type Assertion, type PlanDraft, type RunReport, type Scenario, type ScenarioResult } from "../src/schema.ts";
import { poolSize } from "../src/select.ts";
import { validatePlan } from "../src/validate.ts";

type Run = (tool: string, input: unknown) => Promise<{ ok: boolean; output: string }>;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withApp<T>(handler: Handler, scenario: Scenario, manifest: Record<string, unknown>, work: (run: Run) => Promise<T>): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl, ...manifest }), outDir: mkdtempSync(path.join(tmpdir(), "rp-ev-")) });
  try {
    await open.session.page.goto(baseUrl);
    const value = await work((tool, input) => runTool(open.session, tool, input));
    open.session.outcome ??= { kind: "completed", reason: "done" };
    return { value, result: await closeSession(open, { mode: "agent" }) };
  } finally {
    server.close();
  }
}
const html = (body: string): Handler => (_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(body);
};

const byText = (value: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "text", value, count: false, read: "text", ...extra });
const byLabel = (value: string) => ({ by: "label", value });
const byTestId = (value: string) => ({ source: "page", by: "testid", value, count: false, read: "text" });
const api = (responseId: string, field: "status" | "body", jsonPath = "") => ({ source: "api", responseId, field, jsonPath, count: false });
const scenario = (assertions: Assertion[], over: Partial<Scenario> = {}): Scenario => ({ id: "S4", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions, ...over });
const check = (run: Run, assertionId: string, target: unknown) => run("check", { assertionId, target, rationale: "r" });
const runOf = (results: ScenarioResult[], scenarios: Scenario[], extra: Partial<RunReport> = {}): RunReport =>
  ({
    ticketKey: "T-1", pullRequest: { number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://localhost:1", deployedSha: "a".repeat(40) },
    context: { sources: [] }, analysis: { requirements: [], ambiguities: [], risks: [] }, analysisNotes: [],
    plan: { scenarios: scenarios.map((s) => ({ scenario: s, status: "runnable", riskIds: [], ambiguityIds: [], blockedReason: "" })), notes: [], clarifications: [] },
    results, confirmations: {}, timings: [], startedAt: "2026-11-19T00:00:00Z", executionMode: "autonomous", ...extra,
  }) as unknown as RunReport;

// ---- 1. evidence for every comparison --------------------------------------

test("a cross-user cancellation is on record with who acted, on what, what the application answered and what state it left", async () => {
  // A request owned by one test account; the build under test lets another account cancel it.
  let cancelled = false;
  const app: Handler = (request, response) => {
    if (request.method === "POST" && request.url === "/requests/7/cancel") {
      cancelled = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 7, status: "Cancelled", session: "sid=abc123secretcookie" }));
      return;
    }
    html(`<h1>Requests</h1>
      <label>Username <input name="u"></label><label>Password <input name="p" type="password"></label>
      <table><tr><th>Request 7</th><td data-testid="status-7">${cancelled ? "Cancelled" : "Approved"}</td></tr></table>
      <p>Days left: <span data-testid="days-left">${cancelled ? 20 : 17}</span></p>`)(request, response);
  };
  const provenance = { sourceId: "T2", trust: "authoritative" as const, origin: "ticket", quote: "Only the person who made a request can cancel it." };
  const refused: Assertion = { id: "A1", description: "another account's cancel is refused", kind: "number_equals", expected: { literal: 403 }, requirementId: "R5", provenance };
  const unchanged: Assertion = { id: "A2", description: "the request is still Approved", kind: "text_equals", expected: { literal: "Approved" }, requirementId: "R5", provenance };
  const balance: Assertion = { id: "A3", description: "the owner's days are unchanged", kind: "number_equals", expected: { formula: "daysBefore" }, requirementId: "R6" };
  const s = scenario([refused, unchanged, balance], {
    fixtures: { owner: "member_a", other: "member_b" },
    observations: [{ name: "daysBefore", what: "the owner's days left", when: "signed in as the owner, before anyone tries to cancel", unit: "plain" }],
  });
  const accounts = {
    member_a: { description: "a member", username: "alex.a@example.test", password: "pw-owner-4411" },
    member_b: { description: "another member", username: "blake.b@example.test", password: "pw-other-7733" },
  };

  const { result } = await withApp(app, s, { accounts }, async (run) => {
    await run("fill", { element: byLabel("Username"), text: "alex.a@example.test", rationale: "sign in as the owner" });
    await run("fill", { element: byLabel("Password"), text: "{{secret:owner.password}}", rationale: "sign in as the owner" });
    await run("observe", { name: "daysBefore", target: byTestId("days-left"), rationale: "before" });
    await run("fill", { element: byLabel("Username"), text: "blake.b@example.test", rationale: "sign in as the other member" });
    await run("fill", { element: byLabel("Password"), text: "{{secret:other.password}}", rationale: "sign in as the other member" });
    await run("api_request", { method: "POST", path: "/requests/7/cancel", rationale: "the other member tries to cancel" });
    await check(run, "A1", api("R1", "status"));
    await run("navigate", { path: "/", rationale: "look at the request again" });
    await check(run, "A2", byTestId("status-7"));
    await check(run, "A3", byTestId("days-left"));
    // Enough further steps to push everything above out of a "last 12 steps" listing.
    for (let i = 0; i < 14; i++) await run("navigate", { path: "/", rationale: "idle" });
  });
  assert.equal(result.verdict, "failed");

  // The record made at the moment of the comparison says who acted, on what, and what came back.
  const a1 = result.assertionResults.find((r) => r.assertionId === "A1")!.evidence!;
  assert.deepEqual(a1.actor, { alias: "other", step: 5 });
  assert.deepEqual(a1.resource.request, { step: 6, method: "POST", path: "/requests/7/cancel", status: 200, body: '{"id":7,"status":"Cancelled","session":"sid=abc123secretcookie"}' });
  assert.deepEqual(a1.action, { step: 6, tool: "api_request", what: "POST /requests/7/cancel" });
  assert.deepEqual(a1.requirement, { id: "R5", sourceId: "T2", quote: "Only the person who made a request can cancel it." });
  assert.equal(a1.step, 7);
  // The state before, read as the owner, and the state after, read from the page.
  const a3 = result.assertionResults.find((r) => r.assertionId === "A3")!.evidence!;
  assert.deepEqual(a3.before, [{ name: "daysBefore", when: "signed in as the owner, before anyone tries to cancel", value: 17, step: 3 }]);
  assert.equal(a3.resource.page, "/");
  assert.equal(a3.target.matched, 1);
  assert.equal(a3.target.visible, true);
  assert.equal(a3.target.element!.tag, "span");
  assert.match(a3.target.element!.context!, /Days left: 20/);

  // All of it reaches the public diagnostics although the steps are long gone from the short listing.
  const run = runOf([result], [s], { confirmations: { S4: "reproduced" } });
  const d = buildDiagnostics(run);
  assert.equal(result.steps.length, 24);
  assert.ok(d.scenarios[0]!.lastSteps.every((step) => step.n > 12));
  const [c1, c2, c3] = d.scenarios[0]!.comparisons;
  assert.deepEqual(c1!.provenance!.missing, []);
  assert.equal(c1!.provenance!.actor, "other (credentials entered at step 5)");
  assert.match(c1!.provenance!.resource!, /^POST \/requests\/7\/cancel -> 200 at step 6, body /);
  assert.equal(c1!.provenance!.requirement, 'R5 from T2: "Only the person who made a request can cancel it."');
  assert.deepEqual(c1!.provenance!.after, ["A2: expected Approved, observed Cancelled", "A3: expected 17, observed 20"]);
  assert.match(c2!.provenance!.target, /testid "status-7"; matched 1, visible; element <td> in "Request 7 ?Cancelled"/);
  assert.equal(c3!.provenance!.before[0], "daysBefore = 17 (step 3, signed in as the owner, before anyone tries to cancel)");
  assert.deepEqual(d.completeness, { complete: 3, compared: 3 });

  const log = diagnosticLines(d).join("\n");
  assert.match(log, /diag\| evidence: 3 of 3 comparisons carry all seven parts of their record/);
  assert.match(log, /evidence 7\/7 at step 7\n.*requirement R5 from T2.*\n.*expected number_equals 403\n.*actor other \(credentials entered at step 5\)\n.*resource POST \/requests\/7\/cancel -> 200 at step 6/);
  assert.match(renderDiagnostics(d), /Evidence: 3 of 3 comparisons carry all seven parts/);

  // Nothing that identifies a person or opens a session leaves the runner.
  const everything = JSON.stringify(d) + log + renderDiagnostics(d);
  assert.doesNotMatch(everything, /pw-owner-4411|pw-other-7733|alex\.a@|blake\.b@|abc123secretcookie/);
});

test("evidence says what it does not have: no sign-in, no action", async () => {
  const shown: Assertion = { id: "A1", description: "items shown", kind: "number_equals", expected: { literal: 2 } };
  const { result } = await withApp(html("<p>Items: <b>2</b></p>"), scenario([shown]), {}, (run) => check(run, "A1", byText("Items:")));
  const d = buildDiagnostics(runOf([result], [scenario([shown])]));
  assert.deepEqual(d.scenarios[0]!.comparisons[0]!.provenance!.missing, ["requirement", "actor", "action", "final state"]);
  assert.deepEqual(d.completeness, { complete: 0, compared: 1 });
  assert.match(diagnosticLines(d).join("\n"), /evidence 3\/7 \(not recorded: requirement, actor, action, final state\) at step 1/);
});

// ---- 2. which scenarios run under a limit ----------------------------------

const requirements = (ids: string[]): Analysis => ({
  featureSummary: "",
  requirements: ids.map((id) => ({ id, text: `rule ${id}`, kind: "documented" as const, quote: `rule ${id}`, sourceId: "T2", trust: "authoritative" as const, origin: "ticket", relation: "none" as const })),
  ambiguities: [],
  risks: [{ id: "K1", description: "cancelling twice" }],
}) as unknown as Analysis;
type Draft = PlanDraft["scenarios"][number];
const candidate = (id: string, title: string, compares: string[], focus: NonNullable<Draft["focus"]>, riskIds: string[] = []): Draft => ({
  id, title, basis: "requirement", requirementIds: compares, riskIds, intent: "i", setup: "", fixtures: [], observations: [], status: "runnable", blockedReason: "", ambiguityIds: [], focus,
  assertions: compares.map((requirementId, i) => ({ id: `A${i + 1}`, description: "d", kind: "present" as const, expectedNumber: null, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId, alsoVerifies: [] })),
});
// The time-off plan of the benchmark, in the planner's sequence. R4 is the rule with a threshold
// ("at least 3 days before the first day"). The run tried "tomorrow" and "today" and never two days.
const POOL: Draft[] = [
  candidate("S1", "Cancel a Pending request", ["R1"], [{ requirementId: "R1", aspect: "main-flow" }]),
  candidate("S2", "Cancelling a far-future Approved request returns its days", ["R2", "R3"], [{ requirementId: "R2", aspect: "main-flow" }, { requirementId: "R3", aspect: "side-effect" }]),
  candidate("S3", "An Approved request starting tomorrow is refused", ["R4"], [{ requirementId: "R4", aspect: "main-flow" }]),
  candidate("S4", "Another member and an approver cannot cancel someone's request", ["R5"], [{ requirementId: "R5", aspect: "ownership" }, { requirementId: "R5", aspect: "access-control" }]),
  candidate("S5", "The approver's view after a cancellation", ["R6"], [{ requirementId: "R6", aspect: "state-transition" }]),
  candidate("S6", "An Approved request starting today is refused", ["R4"], [{ requirementId: "R4", aspect: "main-flow" }]),
  candidate("S7", "Cancelling twice changes nothing the second time", ["R1"], [{ requirementId: "R1", aspect: "regression" }], ["K1"]),
  candidate("S8", "An Approved request starting in 2 days is refused", ["R4"], [{ requirementId: "R4", aspect: "boundary-below" }]),
  candidate("S9", "An Approved request starting in exactly 3 days can be cancelled", ["R4"], [{ requirementId: "R4", aspect: "boundary-at" }]),
  candidate("S10", "An Approved request starting in 4 days can be cancelled", ["R4"], [{ requirementId: "R4", aspect: "boundary-above" }]),
];
const ANALYSIS = requirements(["R1", "R2", "R3", "R4", "R5", "R6"]);
const MANIFEST = Manifest.parse({ baseUrl: "http://localhost:1" });
const select = (pool: Draft[], cap: number, analysis = ANALYSIS) => validatePlan({ scenarios: pool }, analysis, MANIFEST, cap).plan;

test("under a limit of six, the scenarios just below and exactly at the threshold run, and the repeats do not", () => {
  assert.equal(poolSize(6), 12);
  const plan = select(POOL, 6);
  const ranked = plan.scenarios.filter((s) => s.selection?.rank !== undefined).sort((a, b) => a.selection!.rank! - b.selection!.rank!);
  assert.deepEqual(ranked.map((s) => [s.scenario.id, s.selection!.score, s.selection!.reasons]), [
    // The two scenarios at the threshold are taken first, the better-scoring one leading.
    ["S8", 5, ["taken first because it tests a stated threshold at or just below it", "first comparison of R4", "just below the threshold for R4"]],
    ["S9", 2, ["taken first because it tests a stated threshold at or just below it", "exactly at the threshold for R4"]],
    // Then coverage, as before.
    ["S2", 7, ["first comparison of R2", "first comparison of R3", "a side effect for R3"]],
    ["S4", 7, ["first comparison of R5", "ownership for R5", "access control for R5"]],
    ["S7", 5, ["first comparison of R1", "regression risk for R1", "risk K1"]],
    ["S5", 4, ["first comparison of R6", "a state change for R6"]],
  ]);
  // In the planner's sequence the first six would have been S1 to S6: no boundary at all.
  assert.deepEqual(plan.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario.id), ["S2", "S4", "S5", "S7", "S8", "S9"]);

  // What was left out stays in the plan whole, with what it alone would have added.
  const deferred = plan.scenarios.filter((s) => s.status === "deferred");
  assert.deepEqual(deferred.map((s) => [s.scenario.id, s.selection!.reasons, s.scenario.assertions.length]), [
    ["S1", [], 1],
    ["S3", [], 1],
    ["S6", [], 1],
    ["S10", ["just above the threshold for R4"], 1],
  ]);
  assert.match(deferred[0]!.blockedReason, /Not run: the scenario limit is 6 and 10 were planned\./);
  assert.deepEqual(plan.selection, { cap: 6, candidates: 10, policy: "coverage", boundaryGaps: ["R4: the scenario just above the threshold was planned and not run"] });

  // The same plan always gives the same choice.
  assert.deepEqual(select(POOL, 6), plan);
});

test("a boundary nobody planned is reported, and a claim without a comparison earns nothing", () => {
  // The benchmark's actual plan: no scenario two days out.
  const without = select(POOL.filter((s) => s.id !== "S8"), 6);
  assert.deepEqual(without.selection!.boundaryGaps, ["R4: no scenario was planned just below the threshold"]);

  // A scenario that says it probes R4's boundary but compares nothing that rests on R4.
  const padded = [...POOL.slice(0, 7), candidate("S8", "Claims a boundary", ["R1"], [{ requirementId: "R4", aspect: "boundary-below" }])];
  const plan = select(padded, 6);
  assert.equal(plan.scenarios.find((s) => s.scenario.id === "S8")!.focus, undefined);
  assert.ok(plan.notes.some((n) => /Scenario S8 claims to probe R4 \(boundary-below\) without a comparison that rests on it; the claim was removed\./.test(n)));
  assert.equal(plan.scenarios.find((s) => s.scenario.id === "S8")!.status, "deferred");

  // A plan that declares no focus is taken as the planner listed it.
  const plain = select(POOL.map(({ focus: _focus, ...rest }) => rest), 6);
  assert.deepEqual(plain.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario.id), ["S1", "S2", "S3", "S4", "S5", "S6"]);
  assert.equal(plain.selection!.policy, "as planned");

  // With room for everything, nothing is deferred.
  assert.ok(select(POOL, 10).scenarios.every((s) => s.status === "runnable"));
});

test("the report lists the choice, what was not run and what that leaves untested", () => {
  // R7 is compared only by a scenario that does not fit under the limit.
  const analysis = requirements(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  const pool = [...POOL, candidate("S11", "A cancelled request cannot be reopened", ["R7"], [{ requirementId: "R7", aspect: "main-flow" }])];
  const plan = select(pool, 6, analysis);
  assert.deepEqual(plan.scenarios.filter((s) => s.status === "deferred").map((s) => s.scenario.id), ["S1", "S3", "S6", "S10", "S11"]);
  const passed = (id: string): ScenarioResult => ({ scenarioId: id, title: id, mode: "agent", verdict: "passed", reason: "ok", environment: { baseUrl: "http://localhost:1" }, assertionResults: plan.scenarios.find((s) => s.scenario.id === id)!.scenario.assertions.map((a) => ({ assertionId: a.id, expected: "present", actual: "present", pass: true, target: {} })), observations: {}, steps: [], evidence: { dir: "" }, startedAt: "2026-11-19T00:00:00Z", durationMs: 1 });
  const run = { ...runOf(plan.scenarios.filter((s) => s.status === "runnable").map((s) => passed(s.scenario.id)), []), analysis, plan } as unknown as RunReport;

  const a = assess(run);
  assert.equal(a.deferred, 5);
  assert.equal(a.notRun, 0);
  assert.equal(a.readiness, "incomplete");
  assert.ok(a.reasons.includes("5 planned scenarios were not run because of the scenario limit"));
  assert.deepEqual(a.requirements.map((r) => r.status), ["verified", "verified", "verified", "verified", "verified", "verified", "deferred"]);

  const body = render({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), run } as Parameters<typeof render>[0], "https://example.invalid/r").body;
  assert.match(body, /### Scenario selection\n\n11 runnable scenarios were planned and the limit is 6\. Scenarios that test a stated threshold just below it or exactly at it were taken first, up to half the limit\. Then code chose one at a time/);
  assert.match(body, /\| 1 \| S8 An Approved request starting in 2 days is refused \| taken first because it tests a stated threshold at or just below it; first comparison of R4; just below the threshold for R4 \|/);
  assert.match(body, /\| 2 \| S9 An Approved request starting in exactly 3 days can be cancelled \| taken first because it tests a stated threshold at or just below it; exactly at the threshold for R4 \|/);
  assert.match(body, /\| 3 \| S2 Cancelling a far-future Approved request returns its days \| first comparison of R2; first comparison of R3; a side effect for R3 \|/);
  assert.match(body, /### Not run because of the scenario limit[\s\S]*- \*\*S11\*\* A cancelled request cannot be reopened: first comparison of R7/);
  assert.match(body, /- \*\*S1\*\* Cancel a Pending request: nothing the scenarios that ran do not already cover/);
  assert.match(body, /Thresholds left untested:\n\n- R4: the scenario just above the threshold was planned and not run\n/);
  assert.match(body, /\| Exercised only \| Not run \(limit\) \| Not planned \|/);

  // A requirement only a deferred scenario compares is "not run (limit)", not "not planned".
  const tight = select(POOL, 4);
  assert.deepEqual(tight.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario.id), ["S2", "S4", "S7", "S8"]);
  const few = { ...run, analysis: ANALYSIS, plan: tight, results: tight.scenarios.filter((s) => s.status === "runnable").map((s) => ({ ...passed(s.scenario.id), assertionResults: s.scenario.assertions.map((x) => ({ assertionId: x.id, expected: "present", actual: "present", pass: true, target: {} })) })) } as unknown as RunReport;
  const r6 = assess(few).requirements.find((r) => r.id === "R6")!;
  assert.equal(r6.status, "deferred");
  assert.equal(r6.detail, "Compared only by S5, planned and not run because of the scenario limit.");
  assert.equal(assess(few).counts.deferred, 1);
});

// ---- 3. a value found by searching for the expected value ------------------

const SUMMARY = `<section aria-label="Summary">
  <p>Subtotal: $25.00</p>
  <p>Discount (SAVE10): $2.50</p>
  <p>Total: <strong data-testid="grand-total">$22.50</strong></p>
  <p hidden>Payment declined</p>
</section>`;

test("a total located by its own expected amount is refused; located by its label it is compared", async () => {
  const total: Assertion = { id: "A1", description: "total after the discount", kind: "number_equals", unit: "currency-units", expected: { literal: 22.5 } };
  // The benchmark's weak pass: "$22.50" found by searching for "$22.50".
  const weak = await withApp(html(SUMMARY), scenario([total]), {}, async (run) => ({
    byValue: await check(run, "A1", byText("$22.50")),
    byPattern: await check(run, "A1", byText("Total:", { pattern: "(22\\.50)" })),
  }));
  assert.equal(weak.value.byValue.ok, false);
  assert.match(weak.value.byValue.output, /Assertion A1 was not compared: the target is located by the expected value itself \("\$22\.50" contains 22\.50\)\. Finding it there shows only that the value appears somewhere\. Identify the element by its label, role, container or test id\. No result was recorded\./);
  assert.equal(weak.value.byPattern.ok, false);
  // Weak evidence is neither a pass nor a failure.
  assert.equal(weak.result.verdict, "unverified");
  assert.deepEqual(weak.result.assertionResults, []);

  const sound = await withApp(html(SUMMARY), scenario([total]), {}, (run) => check(run, "A1", byText("Total:")));
  assert.match(sound.value.output, /expected 22\.5, actual 22\.5 -> match/);
  assert.equal(sound.result.verdict, "passed");
  // A stable test id identifies the element whatever it shows.
  const stable = await withApp(html(SUMMARY), scenario([total]), {}, (run) => check(run, "A1", byTestId("grand-total")));
  assert.equal(stable.result.verdict, "passed");

  // A total that really is wrong still fails when it is located by its label.
  const wrong: Assertion = { ...total, expected: { literal: 21 } };
  const failed = await withApp(html(SUMMARY), scenario([wrong]), {}, (run) => check(run, "A1", byText("Total:")));
  assert.match(failed.value.output, /expected 21, actual 22\.5 -> MISMATCH/);
  assert.equal(failed.result.verdict, "failed");

  // The rule itself: amounts in any usual writing, hundredths against units, text, and what is exempt.
  const page = (value: string, pattern?: string) => ({ source: "page" as const, by: "text" as const, value, count: false, read: "text" as const, ...(pattern ? { pattern } : {}) });
  assert.ok(circular(page("Total: $2,250.00"), 2250, { kind: "number_equals" }));
  assert.ok(circular(page("$22.50"), 2250, { kind: "number_equals", unit: "currency-hundredths" }));
  assert.ok(circular(page("Status", "(Approved)"), "Approved", { kind: "text_equals" }));
  assert.equal(circular(page("Total:"), 22.5, { kind: "number_equals" }), undefined);
  assert.equal(circular(page("Subtotal: $25.00"), 22.5, { kind: "number_equals" }), undefined);
  assert.equal(circular({ ...page("total-22.5"), by: "testid" as const }, 22.5, { kind: "number_equals" }), undefined);
  assert.equal(circular(page("Promo code"), "Promo code", { kind: "text_equals", subject: "heading" }), undefined);
});

test("a text-presence check is the plan's to choose, and it means visible, in a stated scope", async () => {
  const contains: Assertion = { id: "A1", description: "the discount line names the code", kind: "text_contains", expected: { literal: "SAVE10" } };
  const present: Assertion = { id: "A2", description: "the code is shown in the summary", kind: "present" };
  const declined: Assertion = { id: "A3", description: "a declined-payment message is shown", kind: "present" };
  const none: Assertion = { id: "A4", description: "no declined-payment message is shown", kind: "absent" };
  const summary = { by: "role", role: "region", value: "Summary" };
  const { value, result } = await withApp(html(SUMMARY), scenario([contains, present, declined, none]), {}, async (run) => ({
    // Searching for the expected text and then reading it back proves nothing about where it is.
    searched: await check(run, "A1", byText("SAVE10")),
    // Read from the line the assertion is about, it is a comparison.
    line: await check(run, "A1", byText("Discount")),
    // Presence is allowed where the plan asks for presence, and records its scope.
    shown: await check(run, "A2", byText("SAVE10", { within: summary })),
    // Text that is in the page but hidden is not shown.
    hidden: await check(run, "A3", byText("Payment declined", { within: summary })),
    absent: await check(run, "A4", byText("Payment declined", { within: summary })),
  }));
  assert.equal(value.searched.ok, false);
  assert.match(value.searched.output, /located by the expected text itself \("SAVE10"\)\..*If the requirement is only that this text is shown, the plan must say so with a present assertion\. No result was recorded\./);
  assert.match(value.line.output, /expected SAVE10, actual Discount \(SAVE10\): \$2\.50 -> match/);
  assert.match(value.shown.output, /expected present, actual present -> match/);
  assert.match(value.hidden.output, /expected present, actual absent -> MISMATCH/);
  assert.match(value.absent.output, /expected absent, actual absent -> match/);
  const shown = result.assertionResults.find((r) => r.assertionId === "A2")!.evidence!;
  assert.deepEqual([shown.target.locatedBy, shown.target.within, shown.target.matched, shown.target.visible], ['text "SAVE10"', 'role region "Summary"', 1, true]);
  assert.equal(result.assertionResults.find((r) => r.assertionId === "A3")!.evidence!.target.matched, 0);
});

// ---- 4. assertions, scenarios, patterns, defects ---------------------------

test("several failed assertions from one cause are one pattern, and only evidence makes a pattern a defect candidate, never a confirmed root cause", () => {
  const a = (id: string, requirementId: string, alsoVerifies: string[] = []): Assertion => ({ id, description: id, kind: "number_equals", expected: { literal: 0 }, requirementId, ...(alsoVerifies.length ? { alsoVerifies } : {}) });
  // The benchmark's shop run: a minimum that is not re-checked after the quantity drops shows up five times in S4.
  const s4 = scenario([a("A6", "R18"), a("A7", "R19"), a("A8", "R18", ["R19"]), a("A9", "R19"), a("A10", "R19")], { id: "S4" });
  // S1: two readings of one rounding fault, and the heading read in place of the applied code.
  const s1 = scenario([a("A4", "R9"), a("A6", "R13"), a("A9", "R13")], { id: "S1" });
  // S2: a status code. S3: a wrong expectation in the plan, one page reading.
  const s2 = scenario([a("A1", "R5")], { id: "S2" });
  const s3 = scenario([a("A5", "R31")], { id: "S3" });
  const bad = (assertionId: string, expected: number | string, actual: number | string, standing: "state" | "corroborated" | "single") => ({ assertionId, expected, actual, pass: false, target: {}, standing });
  const failed = (scenarioId: string, assertionResults: ScenarioResult["assertionResults"]): ScenarioResult => ({ scenarioId, title: scenarioId, mode: "agent", verdict: "failed", reason: "r", environment: { baseUrl: "http://localhost:1" }, assertionResults, observations: {}, steps: [], evidence: { dir: "" }, startedAt: "2026-11-19T00:00:00Z", durationMs: 1 });
  const results = [
    failed("S4", [bad("A6", "absent", "present", "corroborated"), bad("A7", 48, 33, "corroborated"), bad("A8", 0, 1500, "state"), bad("A9", 4800, 3300, "state"), bad("A10", 48, 33, "corroborated")]),
    failed("S1", [bad("A4", "SAVE10", "Promo code", "single"), bad("A6", 2.49, 2.5, "corroborated"), bad("A9", 249, 250, "state")]),
    failed("S2", [bad("A1", 403, 200, "state")]),
    failed("S3", [bad("A5", 416, 316, "single")]),
  ];
  const run = runOf(results, [s4, s1, s2, s3], { confirmations: { S4: "reproduced", S1: "reproduced", S2: "replay diverged", S3: "replay diverged" } });

  const patterns = failurePatterns(run);
  assert.deepEqual(patterns.map((p) => [p.id, p.evidence, p.comparisons.map((c) => `${c.scenarioId}/${c.assertionId}`).join(" "), p.requirementIds.join(" ")]), [
    // Five comparisons, two requirements, one cause: one pattern.
    ["F1", "evidence-backed", "S4/A6 S4/A7 S4/A8 S4/A9 S4/A10", "R18 R19"],
    // The heading read in place of the code is on its own, and is not a defect on this evidence.
    ["F2", "unconfirmed", "S1/A4", "R9"],
    ["F3", "evidence-backed", "S1/A6 S1/A9", "R13"],
    // Backed by the API, but the failure did not repeat when replayed.
    ["F4", "unconfirmed", "S2/A1", "R5"],
    ["F5", "unconfirmed", "S3/A5", "R31"],
  ]);
  assert.equal(patterns[0]!.description, "comparisons resting on R18, R19: numbers off by 15, 1500; text, presence or status that differs");
  assert.match(patterns[0]!.basis, /S4\/A6 is backed by a second comparison through another target, and the failure repeats/);
  assert.equal(patterns[1]!.basis, "rests on single page observations; nothing else confirms it");
  // Two status codes are not a quantity with a difference.
  assert.equal(patterns[3]!.description, "comparisons resting on R5: text, presence or status that differs");
  assert.match(patterns[3]!.basis, /backed by the application's own API response, but the failure did not repeat when replayed/);

  // Four numbers, four meanings.
  assert.deepEqual(failureCounts(run), { assertions: 10, scenarios: 4, patterns: 5, candidates: 2 });
  const body = render({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), run } as Parameters<typeof render>[0], "https://example.invalid/r").body;
  assert.match(body, /- Failed assertions: \*\*10\*\*\n- Failed scenarios: \*\*4\*\*\n- Failure patterns: \*\*5\*\*\n- Evidence-backed defect candidates: \*\*2\*\*/);
  assert.match(body, /An unconfirmed pattern may be a defect, a wrong locator or a wrong expectation\./);
  assert.match(body, /\| F2 \| unconfirmed \| comparisons resting on R9: text, presence or status that differs \| S1\/A4 \| R9 \| rests on single page observations; nothing else confirms it \|/);
  assert.match(body, /\| F1 \| \*\*evidence-backed\*\* \|/);
  assert.match(body, /whether two candidates share one root cause, or one candidate hides two, is not established by this report\./);
  // Nothing in the report claims a confirmed defect or root cause.
  assert.doesNotMatch(body, /distinct pattern\*\*|off by 203|[Cc]onfirmed (distinct )?defect|confirmed root cause/);

  // Without a repeat or any standing on record, nothing is called a defect.
  const bare = runOf(results.map((r) => ({ ...r, assertionResults: r.assertionResults.map(({ standing: _s, ...rest }) => rest) })), [s4, s1, s2, s3]);
  assert.equal(failureCounts(bare).candidates, 0);
});
