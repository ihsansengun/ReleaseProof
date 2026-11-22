// KAN-16: the result of a remote run. The engine states the run-level verdict,
// and an observation is never reported as a verification while the result is
// not trusted. Built from hand-made run records: no browser, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceIdOf, filesThatMayLeave, remoteResult, REMOTE_RESULT_FORMAT_VERSION } from "../src/remote/result.ts";
import { LEAKED_BEFORE, LEAKED_PATHS, SECRETS_BEFORE } from "./leaked-before.ts";

const RUN_ID = "a0000000-0000-4000-8000-000000000410";
import type { RemoteRun } from "../src/remote/run.ts";
import type { ScenarioResult, Verdict } from "../src/schema.ts";

const QUOTE = "After a first paid order of 60.00 the loyalty balance is 160.";
const requirement = (id: string) => ({ id, text: QUOTE, kind: "documented" as const, quote: QUOTE, sourceId: "rules-r3", trust: "authoritative" as const, origin: 'criteria snapshot "rules-r3"' });
const planned = (id: string, requirementId: string, status: "runnable" | "blocked" = "runnable") => ({
  status,
  blockedReason: status === "blocked" ? "needs a decision" : "",
  ambiguityIds: [],
  riskIds: [],
  scenario: { id, title: id, basis: "requirement" as const, requirementIds: [requirementId], intent: "", fixtures: {}, assertions: [{ id: "A1", description: "Balance", kind: "number_equals" as const, unit: "plain" as const, expected: { literal: 160 }, requirementId }] },
});
const scenario = (id: string, verdict: Verdict, actual: number | null, more: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: id,
  title: id,
  mode: "replay",
  verdict,
  reason: verdict === "passed" ? "All 1 assertions matched." : `${verdict} for a reason`,
  environment: { baseUrl: "http://localhost:1/" },
  assertionResults: actual === null ? [] : [{ assertionId: "A1", expected: 160, actual, pass: actual === 160, target: {}, screenshot: `/somewhere/on/this/machine/scenarios/${id}/check-A1.png` }],
  observations: {},
  steps: [
    { tool: "navigate", input: { path: "/account" }, ok: true, summary: "URL: /account" },
    { tool: "check", input: { assertionId: "A1", target: { source: "page", by: "testid", value: "loyalty-balance" } }, ok: actual !== null, summary: actual === null ? "Error: not found" : `Recorded A1: expected 160, actual ${actual}` },
  ],
  capture: {
    steps: [
      { step: 1, atMs: 40, durationMs: 300, screenshot: "step-1.png" },
      { step: 2, atMs: 350, durationMs: 120, screenshot: "step-2.png" },
    ],
    console: [],
    network: [],
    leftOut: { screenshots: 0, console: 0, network: 0 },
  },
  evidence: { trace: "trace.zip", dir: `scenarios/${id}` },
  startedAt: "2026-11-22T10:00:00.000Z",
  durationMs: 1200,
  ...more,
});
const notExecuted = (id: string): ScenarioResult => ({ ...scenario(id, "unverified", null), steps: [], reason: "Not executed: the run had reached its time limit.", evidence: { dir: "" } });

function record(results: ScenarioResult[], over: Partial<RemoteRun> = {}): RemoteRun {
  const ids = results.map((result) => result.scenarioId);
  return {
    recordVersion: 1,
    runId: "a0000000-0000-4000-8000-000000000410",
    workspaceId: "a0000000-0000-4000-8000-00000000000a",
    projectId: "a0000000-0000-4000-8000-000000000101",
    target: { baseUrl: "http://localhost:1/", localTarget: true },
    evidenceRoutes: [{ id: "points-api", path: "/api/points" }, { id: "sign-in", path: "/api/sign-in" }],
    snapshots: [{ id: "rules-r3", sha256: "ab".repeat(32), approvedBy: "owner-a@releaseproof.test", approvedAt: "2026-11-20T09:30:00Z", keyId: "control-plane-2026-11" }],
    executionMode: "recorded",
    verdictsTrusted: false,
    limits: { maxScenarios: 5, maxMinutes: 10, maxUsd: 0 },
    analysis: { featureSummary: "Loyalty points at checkout.", requirements: ids.map((_, index) => requirement(`R${index + 1}`)), ambiguities: [], risks: [], conflicts: [] } as never,
    analysisNotes: [],
    plan: { scenarios: ids.map((id, index) => planned(id, `R${index + 1}`)), notes: [], clarifications: [] } as never,
    planProblems: [],
    results,
    startedAt: "2026-11-22T10:00:00.000Z",
    durationMs: 5000,
    ...over,
  };
}

test("the file follows the result contract's version 1: version, run and verdict where that version puts them", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.equal(result.formatVersion, REMOTE_RESULT_FORMAT_VERSION);
  assert.equal(result.formatVersion, 1);
  assert.equal(result.runId, "a0000000-0000-4000-8000-000000000410");
  assert.ok(["passed", "failed", "errored", "blocked", "unverified"].includes(result.verdict));
  assert.deepEqual(result.producer, { name: "releaseproof-engine", resultSchema: 1, kind: "remote-run", executionMode: "recorded" });
  assert.deepEqual(result.extensions, {});
});

test("every comparison matched, and the result is not trusted: the verdict is unverified, never passed", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.equal(result.verdictsTrusted, false);
  assert.equal(result.verdict, "unverified");
  assert.equal(result.verdictBasis.observed, "passed");
  assert.match(result.verdictBasis.notTrustedBecause ?? "", /chosen by the recording/);
  assert.equal(result.executionStatus, "completed", "the run finished; that is another fact than its verdict");
});

test("a matched comparison is reported as observed, not as a verified requirement", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  const [requirement] = result.requirements;
  assert.equal(requirement!.status, "unverified");
  assert.equal(requirement!.observedStatus, "verified");
  assert.match(requirement!.reason, /^Observed, not verified\./);
  assert.equal(requirement!.expected, "160");
  assert.equal(requirement!.observed, "160");
  assert.equal(result.coverage.requirements.verified, 0);
  assert.equal(result.coverage.requirements.unverified, 1);
  assert.equal(result.coverage.observedOnly, 1);
});

test("the worst outcome decides: failed, then errored, then blocked, then unverified", () => {
  const verdictOf = (...verdicts: Verdict[]) => remoteResult(record(verdicts.map((verdict, index) => scenario(`S${index + 1}`, verdict, verdict === "passed" ? 160 : verdict === "failed" ? 60 : null)))).verdict;
  assert.equal(verdictOf("passed", "failed", "errored", "blocked", "unverified"), "failed");
  assert.equal(verdictOf("passed", "errored", "blocked", "unverified"), "errored");
  assert.equal(verdictOf("passed", "blocked", "unverified"), "blocked");
  assert.equal(verdictOf("passed", "unverified"), "unverified");
});

test("a mismatch is reported as it is: failed, with what was expected and what was observed", () => {
  const result = remoteResult(record([scenario("S1", "failed", 60)]));
  assert.equal(result.verdict, "failed");
  assert.equal(result.verdictBasis.observed, "failed");
  assert.equal(result.verdictBasis.notTrustedBecause, undefined);
  assert.equal(result.requirements[0]!.status, "failed");
  assert.equal(result.requirements[0]!.observed, "60");
  assert.equal(result.steps.find((step) => step.action === "check")!.outcome, "mismatch");
});

test("a run that did not do everything planned is never passed, even by observation", () => {
  const early = remoteResult(record([scenario("S1", "passed", 160), notExecuted("S2")], { endedEarly: { reason: "The run reached its limit of 1 minute." } }));
  assert.equal(early.verdictBasis.observed, "unverified");
  assert.equal(early.verdict, "unverified");
  assert.equal(early.executionStatus, "ended early");
  assert.deepEqual(early.endedEarly, { reason: "The run reached its limit of 1 minute." });
  assert.deepEqual(early.coverage.scenarios, { planned: 2, executed: 1, notExecuted: 1 });

  const blockedInPlan = record([scenario("S1", "passed", 160)]);
  (blockedInPlan.plan.scenarios as unknown[]).push(planned("S2", "R1", "blocked"));
  assert.equal(remoteResult(blockedInPlan).verdictBasis.observed, "unverified");
});

test("a run in which nothing was executed says so, and is unverified", () => {
  const nothing = remoteResult(record([notExecuted("S1")]));
  assert.equal(nothing.executionStatus, "nothing executed");
  assert.equal(nothing.verdict, "unverified");
  assert.deepEqual(nothing.steps, []);
  assert.deepEqual(nothing.profiles, [], "no profile is said to have been tested");
  const empty = remoteResult(record([]));
  assert.equal(empty.verdict, "unverified");
  assert.equal(empty.verdictBasis.observed, "unverified");
});

test("evidence is named by its place in the output, and says what it shows, not what it proves", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.deepEqual(
    result.evidence.map((file) => [file.id, file.mediaType, file.path]),
    [
      [evidenceIdOf(RUN_ID, "S1-1", "screenshot"), "image/png", "scenarios/S1/step-1.png"],
      [evidenceIdOf(RUN_ID, "S1-2", "screenshot"), "image/png", "scenarios/S1/step-2.png"],
    ],
  );
  assert.ok(!JSON.stringify(result).includes("/somewhere/on/this/machine"), "no path of the engine's own machine");
  assert.deepEqual(result.steps.find((step) => step.action === "check")!.screenshot, { evidenceId: evidenceIdOf(RUN_ID, "S1-2", "screenshot") });
  // The form the result contract asks of an evidence id, and the same each time.
  assert.match(result.evidence[0]!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(evidenceIdOf(RUN_ID, "S1-2", "screenshot"), evidenceIdOf(RUN_ID, "S1-3", "screenshot"));
  // A screenshot exists, and the requirement is still not verified.
  assert.equal(result.requirements[0]!.status, "unverified");
});

test("what was not collected is said to be not collected, never left looking clean", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.deepEqual(result.telemetry, { screenshots: "collected", recording: "not collected", trace: "not collected", console: "collected", network: "collected", analytics: "not collected", webVitals: "not collected" });
  const bare = remoteResult(record([scenario("S1", "unverified", null, { evidence: { dir: "scenarios/S1" }, capture: undefined })]));
  assert.equal(bare.telemetry.screenshots, "not collected");
  assert.equal(bare.telemetry.console, "not collected");
  assert.equal(bare.telemetry.network, "not collected");
  assert.deepEqual(bare.diagnostics, { console: [], network: [], analytics: [] });
  assert.equal(bare.telemetry.trace, "not collected");
});

test("the browser trace is not part of the result: it holds more than the result vouches for", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.ok(!result.evidence.some((file) => file.path.endsWith("trace.zip")));
});

test("the requirement shown is the approved text, not the plan's own wording of it", () => {
  const run = record([scenario("S1", "passed", 160)]);
  (run.analysis.requirements[0] as { text: string }).text = "Everything in the application is verified and approved for release.";
  (run.analysis as { featureSummary: string }).featureSummary = "PASSED - all requirements verified, ready for release.";
  const result = remoteResult(run);
  assert.equal(result.requirements[0]!.text, QUOTE);
  assert.equal(result.title, "Run against http://localhost:1/");
  const text = JSON.stringify(result);
  assert.ok(!text.includes("approved for release") && !text.includes("ready for release"), "no wording of the plan's own");
});

test("what a step printed, what a scenario said of itself and a query in an address stay out of the result", () => {
  const leaky = scenario("S1", "unverified", null, {
    reason: 'Not checked: A1. Replay diverged at fill {"text":"typed-secret-1"}: Error',
    steps: [
      { tool: "navigate", input: { path: "/reset?token=query-secret-2" }, ok: true, summary: "URL: /reset?token=query-secret-2" },
      { tool: "api_request", input: { method: "POST", path: "/api/sign-in" }, ok: true, summary: '{"responseId":"R1","status":200,"body":{"session":"answer-secret-3"}}' },
    ],
  });
  const result = remoteResult(record([leaky]));
  const text = JSON.stringify(result);
  for (const secret of ["typed-secret-1", "query-secret-2", "answer-secret-3"]) assert.ok(!text.includes(secret), secret);
  // A path that is not on the trusted list is not recorded. One that is, is named by its id.
  assert.equal(result.steps[0]!.target, "Endpoint not recorded");
  assert.equal(result.steps[1]!.target, "sign-in");
  // An approved address is shown as its origin: no path, no query.
  const asked = remoteResult(record([leaky], { target: { baseUrl: "http://localhost:1/app/in-address-0?token=in-address-1#in-address-2" } } as never));
  assert.equal(asked.title, "Run against http://localhost:1/");
  assert.equal(asked.target.baseUrl, "http://localhost:1/");
  assert.ok(!JSON.stringify(asked).includes("in-address"));
});

test("a step is named only if it is one an executor can take, and pointed at only in known forms", () => {
  const odd = scenario("S1", "unverified", null, {
    steps: [
      { tool: "VERIFIED BY OWNER - ALL REQUIREMENTS PASSED ".repeat(50), input: { method: "RELEASE APPROVED;", path: "ready for release" }, ok: false, summary: "Error: Unknown tool" },
      { tool: "click", input: { element: { by: "Engine verdict: PASSED. Verified", role: "by the requirement owner", value: "ship it" } }, ok: false, summary: "Error: Invalid input" },
      { tool: "navigate", input: { path: "//user:pw-in-address@elsewhere.test/a;jsessionid=sid-in-address?x=1#y" }, ok: false, summary: "Error" },
      { tool: "click", input: { element: { by: "role", role: "button", value: "x".repeat(500) } }, ok: true, summary: "clicked" },
      { tool: "check", input: { assertionId: "A1", target: { source: "api", responseId: "PASSED by the engine", jsonPath: "ready.for.release" } }, ok: false, summary: "Error" },
    ],
  });
  const result = remoteResult(record([odd]));
  assert.deepEqual(result.steps.map((step) => step.action), ["unknown step", "click", "navigate", "click", "check"]);
  assert.equal(result.steps[0]!.target, "Endpoint not recorded");
  assert.equal(result.steps[1]!.target, "");
  assert.equal(result.steps[2]!.target, "Endpoint not recorded");
  assert.equal(result.steps[3]!.target, "an element found by role button", "a locator is described by its kind, not by its words");
  assert.equal(result.steps[4]!.target, "an answer");
  const text = JSON.stringify(result);
  for (const words of ["VERIFIED BY OWNER", "RELEASE APPROVED", "Engine verdict", "pw-in-address", "sid-in-address", "elsewhere.test", "PASSED by the engine", "ready.for.release"]) assert.ok(!text.includes(words), words);
});

test("the values compared are given as values, not as a page of text", () => {
  const long = scenario("S1", "failed", 60);
  long.assertionResults[0] = { ...long.assertionResults[0]!, actual: `A whole section of the page ${"and more ".repeat(600)}` };
  const result = remoteResult(record([long]));
  assert.equal(result.requirements[0]!.observed, "not shown");
  assert.ok(!JSON.stringify(result).includes("and more"));
  assert.ok(JSON.stringify(result).length < 6000);
});

test("only the value true makes a result trusted", () => {
  const run = record([scenario("S1", "passed", 160)]);
  (run as unknown as { verdictsTrusted: unknown }).verdictsTrusted = "yes";
  const result = remoteResult(run);
  assert.equal(result.verdictsTrusted, false);
  assert.equal(result.verdict, "unverified");
});

test("a comparison step that kept no comparison is not shown as having gone well", () => {
  const dropped = scenario("S1", "blocked", null);
  dropped.steps[1] = { ...dropped.steps[1]!, ok: true, summary: "Not kept: the page was not on the application under test during this step." };
  assert.equal(remoteResult(record([dropped])).steps[1]!.outcome, "error");
});

test("observed is passed only when the very scenarios planned ran, each once, with every comparison planned", () => {
  const observedOf = (run: RemoteRun) => remoteResult(run).verdictBasis.observed;
  assert.equal(observedOf(record([scenario("S1", "passed", 160)])), "passed");

  // Scenarios dropped to stay within the limit: not everything written was run.
  const trimmed = record([scenario("S1", "passed", 160)]);
  (trimmed.plan as { trimmedRunnable?: number }).trimmedRunnable = 3;
  assert.equal(observedOf(trimmed), "unverified");

  // An unresolved conflict about the approved requirements.
  const conflicted = record([scenario("S1", "passed", 160)]);
  (conflicted.analysis as { conflicts: unknown[] }).conflicts = [{ id: "C1", kind: "contradiction", description: "two rules disagree" }];
  assert.equal(observedOf(conflicted), "unverified");

  // The same scenario twice instead of the two planned.
  const twice = record([scenario("S1", "passed", 160), scenario("S2", "passed", 160)]);
  twice.results[1] = scenario("S1", "passed", 160);
  assert.equal(observedOf(twice), "unverified");

  // A result for a scenario that was never planned.
  const extra = record([scenario("S1", "passed", 160)]);
  extra.results.push(scenario("X9", "passed", 160));
  assert.equal(observedOf(extra), "unverified");

  // A scenario called passed with one of its two planned comparisons made.
  const half = record([scenario("S1", "passed", 160)]);
  (half.plan.scenarios[0]!.scenario.assertions as unknown[]).push({ id: "A2", description: "Second", kind: "number_equals", unit: "plain", expected: { literal: 160 }, requirementId: "R1" });
  assert.equal(observedOf(half), "unverified");

  // And whatever the record, never passed as a verdict.
  for (const run of [trimmed, conflicted, twice, extra, half]) assert.notEqual(remoteResult(run).verdict, "passed");
});

test("each requirement names the approved snapshot it comes from, with its hash and approver", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.deepEqual(result.requirements[0]!.source, { document: "rules-r3", revision: "ab".repeat(32), approvedBy: "owner-a@releaseproof.test", approvedAt: "2026-11-20T09:30:00Z" });
  assert.deepEqual(result.requirements[0]!.stepIds, ["S1-2"]);
  assert.equal(result.snapshots.length, 1);
});

test("the result has no pull-request or ticket field", () => {
  const text = JSON.stringify(remoteResult(record([scenario("S1", "passed", 160)]))).toLowerCase();
  for (const word of ["pullrequest", "pull_request", "ticketkey", "ticket", "repository", "commit"]) assert.ok(!text.includes(word), word);
});

// ---- what the browser showed and said ---------------------------------------------------

test("console errors and failed requests are tied to their steps, and say nothing about any requirement", () => {
  const noisy = scenario("S1", "passed", 160);
  noisy.capture!.console.push({ step: 1, level: "error", endpoint: "points-api", count: 3 }, { step: 2, level: "uncaught", endpoint: "Endpoint not recorded", count: 1 });
  noisy.capture!.network.push({ step: 1, status: 500, kind: "fetch", failure: "error answer", endpoint: "points-api", count: 2 }, { step: 2, status: 0, kind: "image", failure: "no answer", endpoint: "Endpoint not recorded", count: 1 });
  const quiet = remoteResult(record([scenario("S1", "passed", 160)]));
  const result = remoteResult(record([noisy]));
  assert.deepEqual(result.diagnostics.console, [
    { stepId: "S1-1", level: "error", endpoint: "points-api", count: 3 },
    { stepId: "S1-2", level: "uncaught", endpoint: "Endpoint not recorded", count: 1 },
  ]);
  assert.deepEqual(result.diagnostics.network, [
    { stepId: "S1-1", status: 500, kind: "fetch", failure: "error answer", endpoint: "points-api", count: 2 },
    { stepId: "S1-2", status: 0, kind: "image", failure: "no answer", endpoint: "Endpoint not recorded", count: 1 },
  ]);
  // Errors in the console change no verdict, no requirement and no count; and their absence earns nothing.
  for (const key of ["verdict", "verdictBasis", "requirements", "coverage", "executionStatus"] as const) assert.deepEqual(result[key], quiet[key], key);
});

test("a picture after every step changes no status, and a step with no picture names none", () => {
  const partial = scenario("S1", "passed", 160);
  partial.capture!.steps[0] = { step: 1, atMs: 40, durationMs: 300, noScreenshot: "The page was not on the application under test." };
  const result = remoteResult(record([partial]));
  assert.equal(result.steps[0]!.screenshot, undefined);
  assert.equal(result.steps[1]!.screenshot?.evidenceId, evidenceIdOf(RUN_ID, "S1-2", "screenshot"));
  assert.equal(result.evidence.length, 1);
  assert.equal(result.requirements[0]!.status, "unverified");
  assert.equal(result.verdict, "unverified");
});

test("the files that may leave a run's directory are the result and the pictures it names, and nothing else", () => {
  const pictured = scenario("S1", "passed", 160);
  pictured.capture!.steps = [{ step: 1, atMs: 0, durationMs: 5, screenshot: "step-1.png" }, { step: 2, atMs: 5, durationMs: 5, screenshot: "../../trace.zip" }, { step: 2, atMs: 5, durationMs: 5, screenshot: "check-A1.png" }];
  const files = filesThatMayLeave(remoteResult(record([pictured])));
  assert.deepEqual(files, ["result.json", "scenarios/S1/step-1.png"]);
});

test("a picture is named only by a file name the engine itself gives", () => {
  const odd = scenario("S1", "passed", 160);
  odd.capture!.steps[0]!.screenshot = "../../../etc/passwd";
  odd.capture!.steps[1]!.screenshot = "check-A1.png";
  assert.deepEqual(remoteResult(record([odd])).evidence, []);
});

test("steps are timed from the start of the run, so a later scenario's steps come later", () => {
  const second = scenario("S2", "passed", 160, { startedAt: "2026-11-22T10:00:05.000Z" });
  const result = remoteResult(record([scenario("S1", "passed", 160), second]));
  assert.deepEqual(result.steps.map((step) => step.atMs), [40, 350, 5040, 5350]);
});

test("what the size limits left out is counted and said", () => {
  const cut = scenario("S1", "passed", 160);
  cut.capture!.leftOut = { screenshots: 2, console: 5, network: 1 };
  assert.deepEqual(remoteResult(record([cut])).evidenceLimits, { leftOut: { screenshots: 2, console: 5, network: 1 } });
  assert.deepEqual(remoteResult(record([scenario("S1", "passed", 160)])).evidenceLimits, { leftOut: { screenshots: 0, console: 0, network: 0 } });
});

test("evidence ids are different for different steps and for different runs", () => {
  const other = "b0000000-0000-4000-8000-000000000410";
  const ids = [evidenceIdOf(RUN_ID, "S1-1", "screenshot"), evidenceIdOf(RUN_ID, "S1-2", "screenshot"), evidenceIdOf(other, "S1-1", "screenshot"), evidenceIdOf(other, "S1-2", "screenshot")];
  assert.equal(new Set(ids).size, 4);
});

test("what was collected is taken in by the result's own rules, whoever wrote the record", () => {
  const hostile = scenario("S1", "passed", 160);
  hostile.capture = {
    steps: [{ step: 1, atMs: Number.NaN, durationMs: -7, screenshot: "step-1.png" }, { step: 2, atMs: 350, durationMs: 120.6, screenshot: "step-2.png" }],
    console: [
      { step: 1, level: "<script>alert(1)</script>", count: 1, endpoint: "points-api" },
      // A record that still carries a text and a place, as earlier collectors wrote them: neither is read.
      { step: 99, level: "error", count: 1, text: `password=hunter2 ${"y".repeat(100_000)}`, source: { path: "/app.js?token=in-source-1", line: 3.5, column: "<b>" }, endpoint: "/reset/token/in-endpoint-1" },
      { step: 1, level: "error", count: 0, endpoint: "points-api" },
      // An id of the right form that is not on the list, and things that are not ids at all.
      { step: 1, level: "error", count: 1, endpoint: "not-on-the-list" },
      { step: 1, level: "error", count: 1, endpoint: { toString: () => "points-api" } },
      { step: 1, level: "uncaught", count: 2, endpoint: "points-api" },
      ...Array.from({ length: 5_000 }, () => ({ step: 2, level: "error", count: 1, endpoint: "https://elsewhere.example/reset/token/in-endpoint-2" })),
    ] as never,
    network: [
      { step: 1, method: "HUNTER2SECRET", path: "https://elsewhere.example/x?token=abc#frag", status: 500, kind: "fetch", count: 1, endpoint: "https://elsewhere.example/x" },
      { step: -5, status: Number.NaN, kind: "fetch", count: 1, endpoint: "points-api" },
      { step: 2, status: 200, kind: "fetch", count: 1, endpoint: "points-api" },
      { step: 2, status: 400, kind: "K".repeat(50_000), failure: "f".repeat(50_000), count: 3, endpoint: "points-api" },
      { step: 2, status: 0, kind: "fetch", failure: "error answer", count: 1.5, endpoint: "points-api" },
    ] as never,
    leftOut: { screenshots: -3, console: 1.5, network: null as never },
  };
  const result = remoteResult(record([hostile]));
  const text = JSON.stringify(result);
  assert.ok(text.length < 120_000, `the result stays small: ${text.length}`);
  assert.ok(!text.includes("<script>") && !text.includes("HUNTER2SECRET") && !text.includes("elsewhere.example") && !text.includes("null"));
  assert.ok(result.diagnostics.console.length <= 60);
  for (const entry of result.diagnostics.console) {
    assert.deepEqual(Object.keys(entry).sort(), ["count", "endpoint", "level", "stepId"], JSON.stringify(entry));
    assert.ok(/^S1-[12]$/.test(entry.stepId) && ["points-api", "Endpoint not recorded"].includes(entry.endpoint), JSON.stringify(entry));
  }
  for (const gone of ["password", "hunter2", "yyyy", "in-source", "in-endpoint", "not-on-the-list", "<b>", "3.5", "ffff", "frag", "/x", "/reset", "/app"]) assert.ok(!text.includes(gone), gone);
  // An endpoint is named only by an id on the list; anything else reads as not recorded.
  assert.deepEqual(result.diagnostics.console.slice(0, 4), [
    { stepId: "S1-2", level: "error", endpoint: "Endpoint not recorded", count: 1 },
    { stepId: "S1-1", level: "error", endpoint: "Endpoint not recorded", count: 1 },
    { stepId: "S1-1", level: "error", endpoint: "Endpoint not recorded", count: 1 },
    { stepId: "S1-1", level: "uncaught", endpoint: "points-api", count: 2 },
  ]);
  // A request is given by its status, a kind from the browser's list and whether it was answered, said from the status.
  assert.deepEqual(result.diagnostics.network, [
    { stepId: "S1-1", status: 500, kind: "fetch", failure: "error answer", endpoint: "Endpoint not recorded", count: 1 },
    { stepId: "S1-2", status: 400, kind: "other", failure: "error answer", endpoint: "points-api", count: 3 },
  ]);
  // Left out, and counted: entries whose kind, count or status is not one an entry can have, and everything past the limit.
  assert.equal(result.evidenceLimits.leftOut.network, 3);
  assert.equal(result.evidenceLimits.leftOut.console, 2 + (5_006 - 60));
  // A count is never more than a hundred, whatever a record says.
  const many = scenario("S1", "passed", 160);
  many.capture!.console.push({ step: 1, level: "error", endpoint: "points-api", count: 999_999 });
  many.capture!.network.push({ step: 1, status: 500, kind: "fetch", failure: "error answer", endpoint: "points-api", count: 1e9 });
  const capped = remoteResult(record([many]));
  assert.equal(capped.diagnostics.console[0]!.count, 100);
  assert.equal(capped.diagnostics.network[0]!.count, 100);
  assert.equal(result.evidenceLimits.leftOut.screenshots, 0);
  assert.equal(result.steps[0]!.atMs, undefined);
  assert.equal(result.steps[0]!.durationMs, undefined);
  assert.equal(result.steps[1]!.durationMs, 121);
  assert.equal(result.verdict, "unverified");
});

test("what a step pointed at is given by the kind of locator or the name of a listed endpoint: never a locator's words or a path", () => {
  const pointed = scenario("S1", "unverified", null, {
    steps: [
      { tool: "navigate", input: { path: "/reset/tok4f9a8b7c6d5e4f3a2b1c" }, ok: true, summary: "" },
      { tool: "navigate", input: { path: "/users/ada@example.test/password=in-path-1" }, ok: true, summary: "" },
      { tool: "click", input: { element: { by: "text", value: "password=in-words-2 ada@example.test Bearer in-words-3" } }, ok: true, summary: "" },
      { tool: "navigate", input: { path: "/account/settings" }, ok: true, summary: "" },
    ],
  });
  const result = remoteResult(record([pointed]));
  const text = JSON.stringify(result);
  for (const secret of ["tok4f9a8b7c6d5e4f3a2b1c", "ada@example.test", "in-path-1", "in-words-2", "in-words-3"]) assert.ok(!text.includes(secret), `${secret} in ${JSON.stringify(result.steps.map((step) => step.target))}`);
  // A path is not given, ordinary or not, unless it is on the trusted list.
  assert.deepEqual(result.steps.map((step) => step.target), ["Endpoint not recorded", "Endpoint not recorded", "an element found by text", "Endpoint not recorded"]);
  assert.ok(!text.includes("/account") && !text.includes("settings"));
});

test("nothing that got through an earlier way of cleaning reaches the result, whichever field carried it", () => {
  const steps = [
    ...LEAKED_BEFORE.map((line) => ({ tool: "click", input: { element: { by: "text", value: line } }, ok: true, summary: line })),
    ...LEAKED_PATHS.map((way) => ({ tool: "navigate", input: { path: way }, ok: true, summary: `URL: ${way}` })),
    ...LEAKED_BEFORE.map((line) => ({ tool: "navigate", input: { path: `/${line}` }, ok: true, summary: "" })),
  ];
  const leaky = scenario("S1", "failed", 0, { steps, reason: LEAKED_BEFORE.join(" ") });
  leaky.assertionResults = LEAKED_BEFORE.map((line, index) => ({ ...leaky.assertionResults[0]!, pass: index % 2 === 0, actual: line, expected: line }));
  leaky.capture = {
    steps: [],
    // As an earlier collector wrote entries, with the text in them; and with the text where a place should be.
    console: LEAKED_BEFORE.flatMap((line) => [{ step: 1, level: "error", count: 1, text: line, endpoint: line }, { step: 1, level: "uncaught", count: 1, source: { path: `/${line}`, line: 1, column: 1 }, endpoint: `/${line}` }]) as never,
    network: [...LEAKED_PATHS, ...LEAKED_BEFORE.map((line) => `/${line}`)].map((way) => ({ step: 1, method: way, path: way, status: 500, kind: way, failure: way, endpoint: way, count: 1 })) as never,
    leftOut: { screenshots: 0, console: 0, network: 0 },
  };
  const result = remoteResult(record([leaky]));
  const text = JSON.stringify(result);
  for (const secret of [...SECRETS_BEFORE, ...LEAKED_PATHS.flatMap((way) => way.split("/").filter((part) => part.length > 3))]) assert.ok(!text.includes(secret), `${JSON.stringify(secret)} in the result`);
  // No address and no part of one, in any field a page or a recording could have written to.
  assert.ok(!/[/?%#]/.test(JSON.stringify([result.steps.map((step) => [step.action, step.target, step.note]), result.diagnostics])), "no address in steps or diagnostics");
  // In every field a page or a recording could have written to: plain printable characters only.
  const fromOutside = JSON.stringify([result.steps, result.diagnostics, result.evidence, result.requirements.map((requirement) => [requirement.expected, requirement.observed, requirement.stepIds])]);
  const odd = /[^\x20-\x7e]/.exec(fromOutside);
  assert.equal(odd, null, odd ? `a character that is not plain: ${JSON.stringify(fromOutside.slice(Math.max(0, odd.index - 120), odd.index + 20))}` : "");
});

test("a value of a comparison is given only when it is a plain number, in the step's note and under the requirement alike", () => {
  const shown = scenario("S1", "failed", 0);
  shown.assertionResults = shown.assertionResults.map((made) => ({ ...made, pass: false, actual: "Signed in. password=shown-secret-1 ada@example.test \u202eBearer shown-secret-2" }));
  // A value with a credential's name and words before the sign, as a page might show it.
  shown.assertionResults.push({ ...shown.assertionResults[0]!, actual: "password for admin: shown-secret-3" });
  const result = remoteResult(record([shown]));
  const text = JSON.stringify(result);
  for (const secret of ["shown-secret-1", "shown-secret-2", "shown-secret-3", "ada@example.test", "\u202e"]) assert.ok(!text.includes(secret), `${JSON.stringify(secret)} in ${JSON.stringify(result.requirements.map((requirement) => requirement.observed))}`);
  // A value that is words is said not to be shown. One that is a plain number is given.
  assert.ok(result.requirements.every((requirement) => requirement.observed.split("; ").every((value) => value === "not shown")), JSON.stringify(result.requirements.map((requirement) => requirement.observed)));
  assert.ok(result.steps.some((step) => /^Expected 160, observed not shown: mismatch\.$/.test(step.note)), JSON.stringify(result.steps.map((step) => step.note)));
  const plain = remoteResult(record([scenario("S1", "failed", 40)]));
  assert.ok(plain.requirements.some((requirement) => requirement.expected === "160" && requirement.observed === "40"));
  // A scenario's name that is not text does not stop the result from being built.
  const odd = scenario("S1", "passed", 160);
  (odd as { scenarioId: unknown }).scenarioId = 12345;
  assert.doesNotThrow(() => remoteResult(record([odd])));
});

test("a scenario is named only by a plain name, and a record that is not one does not count as having listened", () => {
  const named = scenario("../../<b>S1</b>", "passed", 160);
  named.capture = null as never;
  const result = remoteResult(record([named]));
  assert.ok(result.steps.every((step) => step.scenarioId === "scenario" && /^scenario-\d+$/.test(step.id)), JSON.stringify(result.steps.map((step) => step.id)));
  assert.equal(result.telemetry.console, "not collected");
  assert.equal(result.telemetry.network, "not collected");
  const empty = scenario("S1", "passed", 160);
  empty.capture = {} as never;
  assert.equal(remoteResult(record([empty])).telemetry.console, "not collected");
});

test("an entry that cannot be read is left out and counted, and the rest of the result stands", () => {
  const odd = scenario("S1", "passed", 160);
  const getter = { step: 1, status: 404, kind: "fetch", count: 1, get endpoint(): string { throw new Error("hunter2x9"); } };
  odd.capture!.network.push(getter as never, { step: 1, status: 404, kind: "fetch", failure: "error answer", endpoint: "points-api", count: 1 });
  odd.capture!.console.push(null as never, { step: 1, level: "error", count: 1, endpoint: "points-api" });
  const result = remoteResult(record([odd]));
  assert.deepEqual(result.diagnostics.network, [{ stepId: "S1-1", status: 404, kind: "fetch", failure: "error answer", endpoint: "points-api", count: 1 }]);
  assert.equal(result.diagnostics.console.length, 1);
  assert.ok(result.evidenceLimits.leftOut.network >= 1 && result.evidenceLimits.leftOut.console >= 1);
  assert.ok(!JSON.stringify(result).includes("hunter2"));
  assert.equal(result.verdict, "unverified");
});
