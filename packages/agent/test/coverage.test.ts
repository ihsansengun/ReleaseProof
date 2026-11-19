// Coverage that says what was really compared (R2), and failures that can be
// read without opening an artifact, with nothing sensitive in them (R8).
import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../src/ci/report.ts";
import { buildDiagnostics, diagnosticLines, redact, renderDiagnostics } from "../src/report/diagnostics.ts";
import { failurePatterns } from "../src/report/patterns.ts";
import { assess } from "../src/report/readiness.ts";
import { Manifest, type Analysis, type PlanDraft, type RunReport } from "../src/schema.ts";
import { validatePlan } from "../src/validate.ts";

const documented = (id: string, quote: string): Analysis["requirements"][number] => ({ id, text: quote, kind: "documented", quote, sourceId: "T2", trust: "authoritative", origin: "ticket", relation: "none" });
const analysis: Analysis = {
  featureSummary: "",
  requirements: [
    documented("R1", "A voucher takes 15.00 off a qualifying subtotal"),
    documented("R2", "The minimum subtotal for a voucher is 60.00"),
    documented("R3", "A declined charge leaves the basket as it was"),
    documented("R4", "A voucher can be used once per account"),
    { id: "R9", text: "claim", kind: "claimed", quote: "anything goes", sourceId: "P1", trust: "pr-controlled", origin: "pr", relation: "adds" },
  ],
  ambiguities: [],
  risks: [],
};
type Outcome = { assertionId: string; expected: number | string; actual: number | string; pass: boolean };
const run = (scenarios: { id: string; requirementIds: string[]; assertions: { id: string; requirementId: string; alsoVerifies?: string[] }[]; outcomes: Outcome[] }[]) => ({
  analysis,
  plan: { scenarios: scenarios.map((s) => ({ status: "runnable", blockedReason: "", scenario: { id: s.id, requirementIds: s.requirementIds, assertions: s.assertions } })) },
  results: scenarios.map((s) => ({ scenarioId: s.id, verdict: s.outcomes.some((o) => !o.pass) ? ("failed" as const) : ("passed" as const), reason: "", assertionResults: s.outcomes })),
});
const status = (a: ReturnType<typeof assess>) => Object.fromEntries(a.requirements.map((r) => [r.id, r.status]));

test("a requirement that a comparison also verifies is counted as verified; one a scenario only passes through is not", () => {
  // The threshold rule (R2) is exactly what the comparison exercises, though its expected value rests on R1.
  const credited = assess(run([{ id: "S1", requirementIds: ["R1", "R2", "R3"], assertions: [{ id: "A1", requirementId: "R1", alsoVerifies: ["R2"] }], outcomes: [{ assertionId: "A1", expected: 45, actual: 45, pass: true }] }]));
  assert.deepEqual(status(credited), { R1: "verified", R2: "verified", R3: "exercised", R4: "not planned" });
  assert.match(credited.requirements.find((r) => r.id === "R3")!.detail, /lists this requirement, but no comparison is tied to it/);
  // "Exercised" is not "verified": the run is not ready on the strength of it.
  assert.equal(credited.readiness, "incomplete");
  assert.equal(credited.counts.exercised, 1);

  // Without the link, the same run used to report R2 as not planned. It is now at least shown as exercised.
  const unlinked = assess(run([{ id: "S1", requirementIds: ["R1", "R2"], assertions: [{ id: "A1", requirementId: "R1" }], outcomes: [{ assertionId: "A1", expected: 45, actual: 45, pass: true }] }]));
  assert.equal(status(unlinked).R2, "exercised");
});

test("a failed comparison fails the requirement it rests on, not every requirement linked to it", () => {
  const a = assess(run([
    { id: "S1", requirementIds: ["R1", "R2"], assertions: [{ id: "A1", requirementId: "R1", alsoVerifies: ["R2", "R3"] }], outcomes: [{ assertionId: "A1", expected: 45, actual: 45.01, pass: false }] },
    { id: "S2", requirementIds: ["R3"], assertions: [{ id: "A1", requirementId: "R3" }], outcomes: [{ assertionId: "A1", expected: 1, actual: 1, pass: true }] },
  ]));
  // R1 failed. R2 is left unconfirmed, with the reason. R3 was confirmed by its own comparison elsewhere.
  assert.deepEqual(status(a), { R1: "failed", R2: "unverified", R3: "verified", R4: "not planned" });
  assert.match(a.requirements.find((r) => r.id === "R2")!.detail, /did not match; its expected value rests on R1/);
  assert.equal(a.counts.failed, 1);
  assert.equal(a.readiness, "not ready");
});

test("the plan validator keeps only approved requirements in an assertion's extra links", () => {
  const draft: PlanDraft = {
    scenarios: [{
      id: "S1", title: "t", basis: "requirement", requirementIds: ["R1"], riskIds: [], intent: "i", setup: "", fixtures: [], observations: [], status: "runnable", blockedReason: "", ambiguityIds: [],
      assertions: [{ id: "A1", description: "total", kind: "number_equals", expectedNumber: 45, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId: "R1", alsoVerifies: ["R2", "R2", "R1", "R9", "R77"] }],
    }],
  };
  const { plan, problems } = validatePlan(draft, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 5);
  assert.deepEqual(plan.scenarios[0]!.scenario.assertions[0]!.alsoVerifies, ["R2"]);
  assert.deepEqual(problems, [], "a dropped link is noted, not a reason to redo the plan");
  assert.match(plan.notes.join("\n"), /lists "R9" as also verified, which is not an approved requirement/);
  assert.match(plan.notes.join("\n"), /lists "R77"/);
});

// The comparisons that failed in the live run of 19 November: three defects, nine failed comparisons, ten requirements marked failed.
const liveRun = run([
  { id: "S1", requirementIds: [], assertions: [{ id: "A1", requirementId: "R1" }, { id: "A2", requirementId: "R1" }], outcomes: [{ assertionId: "A1", expected: 2.49, actual: 2.5, pass: false }, { assertionId: "A2", expected: 22.5, actual: 22.49, pass: false }] },
  { id: "S4", requirementIds: [], assertions: [{ id: "A1", requirementId: "R4" }, { id: "A2", requirementId: "R4" }], outcomes: [{ assertionId: "A1", expected: 12.99, actual: 13, pass: false }, { assertionId: "A2", expected: 116.96, actual: 116.95, pass: false }] },
  { id: "S5", requirementIds: [], assertions: [{ id: "A1", requirementId: "R3" }, { id: "A2", requirementId: "R3" }, { id: "A3", requirementId: "R3" }], outcomes: [{ assertionId: "A1", expected: "absent", actual: "present", pass: false }, { assertionId: "A2", expected: 2.49, actual: 0, pass: false }, { assertionId: "A3", expected: 22.5, actual: 24.99, pass: false }] },
  { id: "S2", requirementIds: [], assertions: [{ id: "A1", requirementId: "R2" }, { id: "A2", requirementId: "R2" }, { id: "A3", requirementId: "R2" }], outcomes: [{ assertionId: "A1", expected: 48, actual: 33, pass: false }, { assertionId: "A2", expected: "absent", actual: "present", pass: false }, { assertionId: "A3", expected: 48, actual: 48, pass: true }] },
]);

test("failed comparisons are grouped into patterns, so one defect seen many times is not counted many times", () => {
  const patterns = failurePatterns(liveRun);
  assert.deepEqual(patterns.map((p) => [p.id, p.description, p.comparisons.length]), [
    ["F1", "a number that is off by 0.01", 4],
    ["F2", "a number that is off by 2.49", 3],
    ["F3", "a number that is off by 15", 2],
  ]);
  // Nothing is hidden by the grouping: every failed comparison is in exactly one pattern.
  assert.equal(patterns.reduce((n, p) => n + p.comparisons.length, 0), 9);
  assert.deepEqual(patterns[0]!.scenarios, ["S1", "S4"]);
  assert.deepEqual(patterns[0]!.requirementIds, ["R1", "R4"]);
  // A non-numeric failure joins its scenario's numeric pattern; alone, it is a pattern of its own.
  assert.ok(patterns[1]!.comparisons.some((c) => c.scenarioId === "S5" && c.assertionId === "A1"));
  const alone = failurePatterns(run([{ id: "S9", requirementIds: [], assertions: [{ id: "A1", requirementId: "R1" }], outcomes: [{ assertionId: "A1", expected: "Saved", actual: "Error", pass: false }] }]));
  assert.deepEqual(alone.map((p) => p.description), ["text or presence that differs, in scenario S9"]);
  assert.deepEqual(failurePatterns(run([])), []);
});

const fullRun = (): RunReport => ({
  ticketKey: "ABC-1",
  pullRequest: { repo: "acme/tool", number: 7, headSha: "a".repeat(40), title: "t" },
  environment: { baseUrl: "http://10.0.0.2:8080" },
  driver: "test",
  executionMode: "autonomous",
  context: { docs: [], changedFiles: [], omitted: [] },
  analysis,
  analysisNotes: [],
  plan: {
    notes: [],
    clarifications: [],
    scenarios: [{
      status: "runnable", blockedReason: "", ambiguityIds: [], riskIds: [],
      scenario: { id: "S1", title: "Voucher for jane.doe@example.com", basis: "requirement", requirementIds: ["R1"], intent: "i", fixtures: {}, assertions: [
        { id: "A1", description: "total after the voucher", kind: "number_equals", expected: { literal: 45 }, requirementId: "R1", provenance: { sourceId: "T2", trust: "authoritative", origin: "Jira issue ABC-1: comment by Jane Doe (712020:abc)", quote: "q" } },
        { id: "A2", description: "voucher shown", kind: "present", requirementId: "R1" },
      ] },
    }],
  },
  results: [{
    scenarioId: "S1", title: "Voucher for jane.doe@example.com", mode: "agent", verdict: "failed", reason: "A1: expected 45, got 45.01",
    environment: { baseUrl: "http://10.0.0.2:8080" },
    assertionResults: [{ assertionId: "A1", expected: 45, actual: 45.01, pass: false, target: { source: "page", by: "role", role: "cell", value: "Total" }, screenshot: "/home/runner/work/out/run/scenarios/S1/check-A1.png" }],
    observations: {},
    steps: [
      ...Array.from({ length: 14 }, (_, i) => ({ tool: "click", input: { by: "role", role: "link", value: `Item ${i}` }, ok: true, summary: `page ${i}` })),
      { tool: "fill", input: { by: "label", value: "Password", text: "{{secret:owner.password}}" }, ok: true, summary: "filled" },
      { tool: "request", input: { method: "POST", path: "/sign-in", headers: { Authorization: "Bearer abcdef0123456789abcdef", Cookie: "session=s3cr3tvalue99; theme=dark" } }, ok: true, summary: 'HTTP 200 {"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U","email":"jane.doe@example.com","csrf_token=9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100"}' },
      { tool: "check", input: { assertionId: "A1" }, ok: false, summary: "::error::expected 45, got 45.01\u001b[31m\nsecond line" },
    ],
    evidence: { dir: "/home/runner/work/out/run/scenarios/S1" },
    startedAt: "2026-01-01T00:00:00Z",
    durationMs: 1,
  }],
  confirmations: { S1: "reproduced" },
  timings: [],
  startedAt: "2026-01-01T00:00:00Z",
});

test("redaction removes credentials, tokens, addresses and opaque values, and keeps the engine's own placeholders", () => {
  const cases: [string, RegExp, RegExp][] = [
    ["Authorization: Bearer abcdef0123456789", /Authorization: \[redacted\]/, /abcdef0123456789/],
    ["sent Bearer abcdef0123456789 along", /sent Bearer \[redacted\] along/, /abcdef0123456789/],
    ["password=hunter2&next=/", /password=\[redacted\]&next/, /hunter2/],
    ['{"password": "hunter2", "name": "x"}', /"password": "\[redacted\]"/, /hunter2/],
    ["Set-Cookie: session=abc123xyz; Path=/", /Set-Cookie: \[redacted\]/, /abc123xyz/],
    ["document.cookie session=abc123xyz", /session=\[redacted\]/, /abc123xyz/],
    ["csrf_token=9f8e7d", /csrf_token=\[redacted\]/, /9f8e7d/],
    ["contact jane.doe@example.co.uk today", /contact \[redacted e-mail\] today/, /jane\.doe/],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end", /jwt \[redacted token\] end/, /eyJ/],
    ["key 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa9988 end", /key \[redacted value\] end/, /9f8e7d6c/],
  ];
  for (const [input, kept, gone] of cases) {
    const out = redact(input);
    assert.match(out, kept, input);
    assert.doesNotMatch(out, gone, input);
  }
  // A placeholder names a secret without containing it, and ordinary text is untouched.
  assert.equal(redact('fill "Password" with {{secret:owner.password}}'), 'fill "Password" with {{secret:owner.password}}');
  assert.equal(redact("Total 45.01 where 45 was expected; 3 items"), "Total 45.01 where 45 was expected; 3 items");
});

test("a failure can be inspected from the diagnostics alone, and nothing sensitive is in them", () => {
  const d = buildDiagnostics(fullRun());
  const s = d.scenarios[0]!;
  assert.equal(s.verdict, "failed");
  assert.equal(s.repeat, "reproduced");
  assert.equal(s.stepsRecorded, 17);
  assert.deepEqual(s.lastSteps.map((x) => x.n), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  // The failed comparison: what, expected, observed, which requirement and source, how it was located, which screenshot.
  assert.deepEqual(s.comparisons[0], {
    assertionId: "A1", description: "total after the voucher", expected: "45", observed: "45.01", outcome: "mismatch",
    requirementId: "R1", sourceId: "T2", pattern: "F1", target: '{"source":"page","by":"role","role":"cell","value":"Total"}', screenshot: "check-A1.png",
  });
  assert.equal(s.comparisons[1]!.outcome, "not compared");
  // Paths on the runner are not carried over, only the place inside the evidence.
  assert.equal(s.evidence, "scenarios/S1");

  const everything = JSON.stringify(d) + renderDiagnostics(d) + diagnosticLines(d).join("\n");
  for (const secret of [/abcdef0123456789abcdef/, /s3cr3tvalue99/, /eyJhbGci/, /jane\.doe/, /9f8e7d6c5b4a/, /Jane Doe/, /712020:abc/, /\/home\/runner/]) {
    assert.doesNotMatch(everything, secret);
  }
  assert.match(everything, /\{\{secret:owner\.password\}\}/);

  // In a job log every line is prefixed, bounded and free of control characters, so none is a runner command.
  const lines = diagnosticLines(d);
  assert.ok(lines.length > 5);
  for (const line of lines) {
    assert.match(line, /^diag\| /);
    assert.doesNotMatch(line, /[\u0000-\u001f]/);
    assert.ok(line.length <= 406);
  }
  assert.ok(lines.some((l) => /step 17 check .* FAILED: ::error::expected 45, got 45\.01/.test(l)), "the text is kept, defused by its prefix");
  const clean = fullRun();
  clean.results[0]!.verdict = "passed";
  // It is recorded all the same, so that the pass can be examined.
  const passedLines = diagnosticLines(buildDiagnostics(clean));
  assert.match(passedLines[0]!, /^diag\| S1 passed: /);
  assert.doesNotMatch(passedLines.join("\n"), /jane\.doe|s3cr3tvalue99/);
});

test("the pull request report gives the pattern count beside the failures and a column for exercised-only requirements", () => {
  const r = fullRun();
  const body = render({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), run: r } as Parameters<typeof render>[0], "https://example.invalid/run").body;
  assert.match(body, /1 failed comparison in 1 scenario, falling into \*\*1 distinct pattern\*\*/);
  assert.match(body, /\| F1 \| a number that is off by 0\.01 \| S1\/A1 \| R1 \|/);
  assert.match(body, /\| \| Passed \/ verified \| Failed \| Blocked \| Unverified \| Exercised only \| Not planned \|/);
});
