// KAN-16: the result of a remote run. The engine states the run-level verdict,
// and an observation is never reported as a verification while the result is
// not trusted. Built from hand-made run records: no browser, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteResult, REMOTE_RESULT_FORMAT_VERSION } from "../src/remote/result.ts";
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
      ["S1-check-A1", "image/png", "scenarios/S1/check-A1.png"],
      ["S1-trace", "application/zip", "scenarios/S1/trace.zip"],
    ],
  );
  assert.ok(!JSON.stringify(result).includes("/somewhere/on/this/machine"), "no path of the engine's own machine");
  assert.deepEqual(result.steps.find((step) => step.action === "check")!.screenshot, { evidenceId: "S1-check-A1" });
  // A screenshot exists, and the requirement is still not verified.
  assert.equal(result.requirements[0]!.status, "unverified");
});

test("what was not collected is said to be not collected, never left looking clean", () => {
  const result = remoteResult(record([scenario("S1", "passed", 160)]));
  assert.deepEqual(result.telemetry, { screenshots: "collected", recording: "not collected", trace: "collected", console: "not collected", network: "not collected", analytics: "not collected", webVitals: "not collected" });
  const bare = remoteResult(record([scenario("S1", "unverified", null, { evidence: { dir: "scenarios/S1" } })]));
  assert.equal(bare.telemetry.screenshots, "not collected");
  assert.equal(bare.telemetry.trace, "not collected");
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
