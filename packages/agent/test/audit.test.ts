import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute } from "../src/analyse.ts";
import { buildAuditTrail, renderAuditTrail } from "../src/report/audit.ts";
import { Manifest, type AnalysisDraft, type RunReport } from "../src/schema.ts";
import { sha256, type SourceRecord } from "../src/sources.ts";
import { validatePlan } from "../src/validate.ts";

const text = "Rules:\n- A member can hold at most five items.\n- Returning an item frees its slot.";
const sources: SourceRecord[] = [
  { id: "T2", kind: "ticket-description", trust: "authoritative", origin: "Jira issue ABC-1: description", basis: "issue fields of an authenticated Jira record", text, sha256: sha256(text) },
  { id: "P2", kind: "pr-doc-change", trust: "pr-controlled", origin: "text this pull request adds or changes in README.md", basis: "changed by the pull request", text: "A member can hold any number of items. <script>alert(1)</script> | x", sha256: "p", changeHash: "c".repeat(64), path: "README.md" },
];
const draft: AnalysisDraft = {
  featureSummary: "x",
  requirements: [
    { id: "R1", text: "Limit", kind: "documented", sourceId: "T2", quote: "A member can hold at most five items.", relation: "none", relatedRequirementId: "" },
    { id: "R2", text: "No limit", kind: "documented", sourceId: "P2", quote: "A member can hold any number of items. <script>alert(1)</script> | x", relation: "contradicts", relatedRequirementId: "R1" },
    { id: "R3", text: "Guess", kind: "inferred", sourceId: "", quote: "", relation: "none", relatedRequirementId: "" },
  ],
  ambiguities: [{ id: "Q1", question: "What happens at six?", why: "", relatedRequirementIds: [] }],
  risks: [],
  supersessions: [],
  contradictions: [],
};

function sampleRun(): RunReport {
  const { analysis } = attribute(draft, sources);
  const assertion = (id: string, requirementId: string, n: number) => ({ id, description: `held items ${id}`, kind: "number_equals" as const, expectedNumber: n, expectedText: null, expectedFormula: null, requirementId, alsoVerifies: [] as string[] });
  const scenario = (id: string, assertions: ReturnType<typeof assertion>[]) => ({ id, title: `Scenario ${id}`, basis: "requirement" as const, requirementIds: ["R1"], riskIds: [], intent: "i", setup: "", fixtures: [], status: "runnable" as const, blockedReason: "", ambiguityIds: [], assertions });
  const { plan } = validatePlan(
    { scenarios: [scenario("S1", [assertion("A1", "R1", 5), assertion("A2", "R2", 99)]), scenario("S2", [assertion("A1", "R1", 5)]), scenario("S3", [assertion("A1", "R3", 1)])] },
    analysis,
    Manifest.parse({ baseUrl: "http://localhost:1" }),
    10,
  );
  return {
    ticketKey: "ABC-1",
    pullRequest: { repo: "acme/tool", number: 7, headSha: "a".repeat(40), title: "t" },
    environment: { baseUrl: "http://x", deployedSha: "a".repeat(40) },
    driver: "test-model",
    executionMode: "autonomous",
    context: {
      docs: [],
      changedFiles: [],
      omitted: [],
      sources: sources.map(({ text: _text, ...rest }) => rest),
      owners: { github: [{ id: 1001, login: "product-owner" }], jira: [{ accountId: "acc-owner" }], fixtureAuthors: [] },
      docChanges: [{ path: "README.md", kind: "modified", hash: "c".repeat(64), addedLines: ["x"], removedLines: ["y"] }],
      approvals: [{ commentId: 9, author: "attacker", accepted: false, reason: "attacker (GitHub user 2002) is not a listed requirement owner" }],
      authorityNotices: ["A note."],
      protectedRevision: "d".repeat(40),
    },
    analysis: { ...analysis, conflicts: [{ id: "C1", kind: "contradiction", description: "README says no limit." }] },
    analysisNotes: [],
    plan,
    results: [
      {
        scenarioId: "S1", title: "Scenario S1", mode: "agent", verdict: "failed", reason: "A1: expected 5, got 6",
        environment: { baseUrl: "http://x" }, assertionResults: [{ assertionId: "A1", expected: 5, actual: 6, pass: false, target: null, screenshot: "runs/x/scenarios/S1/A1.png" }],
        observations: {}, steps: [{ tool: "check", input: {}, ok: true, summary: "" }, { tool: "finish", input: {}, ok: true, summary: "" }] as never, evidence: { dir: "runs/x/scenarios/S1" }, startedAt: "", durationMs: 1,
      },
    ],
    confirmations: { S1: "reproduced" },
    timings: [],
    startedAt: "2026-11-19T00:00:00Z",
    ticketHash: "f".repeat(64),
  };
}

test("the audit trail links every assertion to its source, expected value and evidence", () => {
  const run = sampleRun();
  const trail = buildAuditTrail(run);

  // Every assertion in the plan appears exactly once.
  const planned = run.plan.scenarios.flatMap((s) => s.scenario.assertions.map((a) => `${s.scenario.id}/${a.id}`));
  assert.deepEqual(trail.assertions.map((a) => `${a.scenarioId}/${a.assertionId}`), planned);
  assert.deepEqual(planned, ["S1/A1", "S2/A1"], "assertions resting on a claim or a guess never reach the plan");

  const compared = trail.assertions[0]!;
  assert.equal(compared.requirementId, "R1");
  assert.equal(compared.sourceId, "T2");
  assert.equal(compared.sourceOrigin, "Jira issue ABC-1: description");
  assert.equal(compared.quote, "A member can hold at most five items.");
  assert.equal(compared.expectedAsPlanned, "5");
  assert.deepEqual(compared.evidence, { compared: true, expected: 5, observed: 6, outcome: "mismatch", scenarioVerdict: "failed", modelFreeRepeat: "reproduced", stepsRecorded: 2, evidenceDirectory: "runs/x/scenarios/S1", screenshot: "runs/x/scenarios/S1/A1.png" });
  // Planned but never executed: recorded as not compared, with the reason. Never as a pass.
  assert.deepEqual(trail.assertions[1]!.evidence, { compared: false, why: "the scenario was not run" });

  // No assertion rests on anything but an approved requirement from an authoritative source.
  const approved = new Set(trail.requirements.filter((r) => r.standing === "approved").map((r) => r.id));
  const authoritative = new Set(trail.sources.filter((s) => s.trust === "authoritative").map((s) => s.id));
  for (const a of trail.assertions) {
    assert.ok(approved.has(a.requirementId!), `${a.scenarioId}/${a.assertionId}`);
    assert.ok(authoritative.has(a.sourceId!), `${a.scenarioId}/${a.assertionId}`);
  }
  assert.deepEqual(trail.requirements.map((r) => r.standing.split(",")[0]), ["approved", "claimed", "inferred"]);

  // Sources keep their hash; the change and the refused command are on record; so are the owners in force.
  assert.equal(trail.sources.find((s) => s.id === "T2")!.sha256, sha256(text));
  assert.equal(trail.amendments.notApproved[0]!.changeHash, "c".repeat(64));
  assert.equal(trail.amendments.commands[0]!.accepted, false);
  assert.deepEqual(trail.authority.owners?.github, [{ id: 1001, login: "product-owner" }]);
  assert.equal(trail.authority.fingerprint, "f".repeat(64));
  assert.deepEqual(trail.questions, ["What happens at six?", ...run.plan.clarifications.map((c) => c.question)]);
});

test("the rendered trail carries hostile text as text and states approvals precisely", () => {
  const run = sampleRun();
  run.context.docChanges = [{ path: "README.md", kind: "modified", hash: "c".repeat(64), addedLines: ["x"], removedLines: [], approval: { approver: "product-owner", approverId: 1001, commentId: 500, commit: "a".repeat(40) } }];
  const out = renderAuditTrail(buildAuditTrail(run));
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /\*\*Approved:\*\* change `cccccccccccccccc` to `README\.md` .* by product-owner \(GitHub user 1001\), comment 500, for commit `aaaaaaaaaaaa`/);
  assert.match(out, /\| S1\/A1 held items A1 \| R1 from T2: "A member can hold at most five items\." \| `5` \(planned: 5\) \| `6` \| \*\*MISMATCH\*\*; scenario failed; repeat without a model: reproduced \| 2 steps/);
  assert.match(out, /## 1\. Sources[\s\S]*## 2\. Amendments[\s\S]*## 3\. Requirements[\s\S]*## 4\. Assertions and evidence[\s\S]*## 5\. Conflicts and open questions/);
});
