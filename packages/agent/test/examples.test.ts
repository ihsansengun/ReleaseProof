// In the independent evaluation of 20 November an acceptance criterion named
// four search terms that must find no user. The plan ran three; the fourth,
// the one the defective build got wrong, sat in a scenario that the scenario
// limit left out, and nothing said that a criterion with four named inputs
// had been tried with three. These tests rebuild that criterion. No model is
// used: the analysis and the plan are written out as a model would return them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute } from "../src/analyse.ts";
import { render } from "../src/ci/report.ts";
import { planToDraft } from "../src/drivers/recorded.ts";
import { assess } from "../src/report/readiness.ts";
import { Manifest, type AnalysisDraft, type PlanDraft, type RunReport } from "../src/schema.ts";
import type { SourceRecord } from "../src/sources.ts";
import { validatePlan } from "../src/validate.ts";

const TICKET = `Acceptance criteria:
- Only a complete address matches. Searching for "@example.test", "mary@", "example.test" or "%@example.test" finds no user: the list shows "No users found." and the page title reads "Users (0)".
- Searching by name works as before: "jd" finds John Doe.
- An empty search lists all users.`;
const sources: SourceRecord[] = [
  { id: "T2", kind: "ticket-description", trust: "authoritative", origin: "ticket K-2: description", basis: "test", text: TICKET, sha256: "" },
  { id: "P1", kind: "pr-description", trust: "pr-controlled", origin: "pull request #5", basis: "test", text: 'Searching for "x@" also finds no user.', sha256: "" },
];
const terms = 'Searching for "@example.test", "mary@", "example.test" or "%@example.test" finds no user';
const example = (input: string, quote = terms) => ({ input, expected: "finds no user", quote });
const draft: AnalysisDraft = {
  featureSummary: "x",
  requirements: [
    {
      id: "R7", text: "Only a complete address matches", kind: "documented", sourceId: "T2", quote: "Only a complete address matches.", relation: "none", relatedRequirementId: "",
      examples: [
        example("@example.test"), example("mary@"), example("example.test"), example("%@example.test"),
        // Not in the ticket at all: a model's own idea of a fifth case.
        example("m%@example.test", 'Searching for "m%@example.test" finds no user'),
        // In the ticket's words, but those words do not contain the input given.
        example("john@", terms),
        // The same input twice is one example.
        example("mary@"),
      ],
    },
    { id: "R13", text: "Name search as before", kind: "documented", sourceId: "T2", quote: '"jd" finds John Doe', relation: "none", relatedRequirementId: "", examples: [{ input: "jd", expected: "finds John Doe", quote: '"jd" finds John Doe' }] },
    { id: "R17", text: "Empty search lists all", kind: "documented", sourceId: "T2", quote: "An empty search lists all users.", relation: "none", relatedRequirementId: "" },
    // A statement of the pull request: it cannot carry examples that count.
    { id: "R30", text: "x@ finds nobody", kind: "documented", sourceId: "P1", quote: 'Searching for "x@" also finds no user.', relation: "adds", relatedRequirementId: "R7", examples: [example("x@", 'Searching for "x@" also finds no user.')] },
  ],
  ambiguities: [], risks: [], supersessions: [], contradictions: [],
};

test("only inputs the approved source names become examples, each with an id of its own", () => {
  const { analysis, notes } = attribute(draft, sources);
  const r7 = analysis.requirements.find((r) => r.id === "R7")!;
  assert.deepEqual(r7.examples!.map((e) => [e.id, e.input]), [["R7.1", "@example.test"], ["R7.2", "mary@"], ["R7.3", "example.test"], ["R7.4", "%@example.test"]]);
  assert.match(notes.join("\n"), /An example given for R7 \("m%@example\.test"\) was dropped: its words are not in T2, or do not contain it\./);
  assert.match(notes.join("\n"), /An example given for R7 \("john@"\) was dropped/);
  assert.deepEqual(analysis.requirements.find((r) => r.id === "R13")!.examples!.map((e) => e.id), ["R13.1"]);
  // A requirement without named inputs has none, and a claim of the pull request never has any.
  assert.equal(analysis.requirements.find((r) => r.id === "R17")!.examples, undefined);
  assert.equal(analysis.requirements.find((r) => r.id === "R30")!.examples, undefined);
  assert.equal(analysis.requirements.find((r) => r.id === "R30")!.kind, "claimed");
});

const analysis = attribute(draft, sources).analysis;
const manifest = Manifest.parse({ baseUrl: "http://localhost:1" });
type DraftScenario = PlanDraft["scenarios"][number];
const count = (id: string, requirementId: string, exampleIds: string[] = []): DraftScenario["assertions"][number] => ({
  id, description: `users listed (${exampleIds.join(", ") || requirementId})`, kind: "number_equals", expectedNumber: 0, expectedText: null, expectedFormula: null, unit: "plain", alsoVerifies: [], requirementId, exampleIds,
});
const scenario = (id: string, title: string, assertions: DraftScenario["assertions"], over: Partial<DraftScenario> = {}): DraftScenario => ({
  id, title, basis: "requirement", requirementIds: [...new Set(assertions.map((a) => a.requirementId))], riskIds: [], intent: "i", setup: "", fixtures: [], observations: [], status: "runnable", blockedReason: "", ambiguityIds: [], assertions, ...over,
});

// The plan of that run in small: three terms in one scenario, the wildcard in a scenario of its own listed last.
const asPlanned: PlanDraft = {
  scenarios: [
    scenario("S1", "Three partial addresses find no user", [count("A1", "R7", ["R7.1"]), count("A2", "R7", ["R7.2"]), count("A3", "R7", ["R7.3"])]),
    scenario("S2", "Name search", [{ ...count("A1", "R13", ["R13.1"]), expectedNumber: 1 }]),
    scenario("S3", "Empty search", [{ ...count("A1", "R17"), expectedNumber: 3 }]),
    scenario("S4", "Name search again, in upper case", [{ ...count("A1", "R13"), expectedNumber: 1 }]),
    scenario("S5", "A wildcard address finds no user", [count("A1", "R7", ["R7.4"])]),
  ],
};

test("a scenario that brings an example not yet covered is chosen before one that repeats what is covered", () => {
  const plan = validatePlan(asPlanned, analysis, manifest, 4).plan;
  const ran = plan.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario.id);
  // Under a limit of four, the wildcard scenario runs although it was listed last; the repeat is what waits.
  assert.deepEqual(ran.sort(), ["S1", "S2", "S3", "S5"]);
  assert.equal(plan.scenarios.find((s) => s.scenario.id === "S4")!.status, "deferred");
  assert.deepEqual(plan.scenarios.find((s) => s.scenario.id === "S5")!.selection!.reasons, ["stated example R7.4"]);
  assert.equal(plan.selection!.exampleGaps, undefined);

  // Under a limit of three something named has to wait, and the plan says exactly what.
  const tight = validatePlan(asPlanned, analysis, manifest, 3).plan;
  assert.deepEqual(tight.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario.id), ["S1", "S2", "S3"]);
  assert.deepEqual(tight.selection!.exampleGaps, ['R7: the stated example "%@example.test" is in a scenario that was planned and not run']);

  // An example nobody planned is a gap too, and a citation of another requirement's example is removed.
  const careless: PlanDraft = { scenarios: [scenario("S1", "Two terms", [count("A1", "R7", ["R7.1", "R13.1", "R7.9"]), count("A2", "R7", ["R7.2"])])] };
  const checked = validatePlan(careless, analysis, manifest, 4);
  assert.deepEqual(checked.plan.scenarios[0]!.scenario.assertions[0]!.exampleIds, ["R7.1"]);
  assert.match(checked.plan.notes.join("\n"), /S1\/A1 cites example "R13\.1", which is not an example of R7; the citation was removed\./);
  assert.deepEqual(checked.plan.selection!.exampleGaps, [
    'R7: the stated example "example.test" is in no scenario of the plan',
    'R7: the stated example "%@example.test" is in no scenario of the plan',
    'R13: the stated example "jd" is in no scenario of the plan',
  ]);
  // The citations survive being recorded and read back.
  assert.deepEqual(planToDraft(checked.plan).scenarios[0]!.assertions[0]!.exampleIds, ["R7.1"]);
});

const report = (plan: ReturnType<typeof validatePlan>["plan"], results: { scenarioId: string; verdict: string; reason?: string; matched?: string[]; mismatched?: string[] }[]) =>
  ({
    ticketKey: "K-2", driver: "test", executionMode: "autonomous", pullRequest: { number: 5, headSha: "a".repeat(40), title: "t" },
    environment: { baseUrl: "http://localhost:1", deployedSha: "a".repeat(40) }, context: { sources: [] },
    analysis, analysisNotes: [], plan,
    results: results.map((r) => ({
      scenarioId: r.scenarioId, title: plan.scenarios.find((s) => s.scenario.id === r.scenarioId)!.scenario.title, mode: "agent", verdict: r.verdict, reason: r.reason ?? "", environment: { baseUrl: "" },
      assertionResults: [...(r.matched ?? []).map((id) => ({ assertionId: id, expected: 0, actual: 0, pass: true, target: {} })), ...(r.mismatched ?? []).map((id) => ({ assertionId: id, expected: 0, actual: 2, pass: false, target: {} }))],
      observations: {}, steps: [], evidence: { dir: "" }, startedAt: "2026-11-20T00:00:00Z", durationMs: 1,
    })),
    confirmations: {}, timings: [], startedAt: "2026-11-20T00:00:00Z",
  }) as unknown as RunReport;

test("a requirement that names four inputs is not verified by three, and the report says which one is missing and why", () => {
  // As it went: the three terms matched, the wildcard scenario was left out by the limit.
  const tight = validatePlan(asPlanned, analysis, manifest, 3).plan;
  const asItWent = report(tight, [{ scenarioId: "S1", verdict: "passed", matched: ["A1", "A2", "A3"] }, { scenarioId: "S2", verdict: "passed", matched: ["A1"] }]);
  const a = assess(asItWent);
  const r7 = a.requirements.find((r) => r.id === "R7")!;
  assert.equal(r7.status, "unverified");
  assert.match(r7.detail, /^3 of 4 stated examples compared; not compared: "%@example\.test" \(deferred\)\. Comparisons made: S1\/A1 match; S1\/A2 match; S1\/A3 match$/);
  assert.deepEqual(r7.examples!.map((e) => [e.id, e.status]), [["R7.1", "matched"], ["R7.2", "matched"], ["R7.3", "matched"], ["R7.4", "deferred"]]);
  // A requirement whose every named input matched is verified, as before.
  assert.equal(a.requirements.find((r) => r.id === "R13")!.status, "verified");
  assert.ok(a.reasons.includes("1 of 5 inputs or values the requirements name were not compared"));
  assert.equal(a.readiness, "incomplete");

  const body = render({ status: "completed", repo: "acme/tool", pr: 5, headSha: "a".repeat(40), run: asItWent } as Parameters<typeof render>[0], "https://example.invalid/r").body;
  assert.match(body, /### Stated examples/);
  // The report writes "@" so that it cannot become a mention; the input is otherwise as the source has it.
  assert.match(body, /\| R7 \| R7\.4 \| %@\u200b?example\.test \| finds no user \| not run \(scenario limit\): S5\/A1: planned and not run because of the scenario limit \|/);
  assert.match(body, /Inputs or values the requirements name that no scenario that ran covers:\n\n- R7: the stated example "%@\u200b?example\.test" is in a scenario that was planned and not run/);

  // With room for it, the wildcard runs. On a build that gets it wrong the requirement fails; on one that gets it right it is verified.
  const roomy = validatePlan(asPlanned, analysis, manifest, 4).plan;
  const base = [{ scenarioId: "S1", verdict: "passed", matched: ["A1", "A2", "A3"] }, { scenarioId: "S2", verdict: "passed", matched: ["A1"] }, { scenarioId: "S3", verdict: "passed", matched: ["A1"] }];
  const wrong = assess(report(roomy, [...base, { scenarioId: "S5", verdict: "failed", mismatched: ["A1"] }]));
  assert.equal(wrong.requirements.find((r) => r.id === "R7")!.status, "failed");
  assert.equal(wrong.requirements.find((r) => r.id === "R7")!.examples![3]!.status, "mismatched");
  const right = assess(report(roomy, [...base, { scenarioId: "S5", verdict: "passed", matched: ["A1"] }]));
  assert.equal(right.requirements.find((r) => r.id === "R7")!.status, "verified");

  // An example whose scenario ran and could not compare it is said to be that, not "deferred".
  const stuck = assess(report(roomy, [...base, { scenarioId: "S5", verdict: "blocked", reason: "Not checked: A1." }]));
  assert.deepEqual(stuck.requirements.find((r) => r.id === "R7")!.examples![3], { id: "R7.4", input: "%@example.test", expected: "finds no user", status: "blocked", detail: "S5/A1 not compared (blocked)" });
  const stopped = assess(report(roomy, [...base, { scenarioId: "S5", verdict: "errored", reason: "Application error: HTTP 500." }]));
  assert.equal(stopped.requirements.find((r) => r.id === "R7")!.examples![3]!.status, "errored");
  assert.equal(stopped.requirements.find((r) => r.id === "R7")!.status, "errored");
});

test("a requirement without named inputs is judged as before", () => {
  const plan = validatePlan(asPlanned, analysis, manifest, 4).plan;
  const a = assess(report(plan, [{ scenarioId: "S3", verdict: "passed", matched: ["A1"] }]));
  const r17 = a.requirements.find((r) => r.id === "R17")!;
  assert.equal(r17.status, "verified");
  assert.equal(r17.examples, undefined);
});
