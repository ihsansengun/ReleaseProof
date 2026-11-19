import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute } from "../src/analyse.ts";
import { linkIsSafe } from "../src/discover.ts";
import { requestAllowed } from "../src/execute/tools.ts";
import { flattenAdf, normaliseIssue } from "../src/ingest/jira.ts";
import { Manifest, type AnalysisDraft, type PlanDraft } from "../src/schema.ts";
import type { SourceRecord } from "../src/sources.ts";
import { SecretVault } from "../src/secrets.ts";
import { validatePlan } from "../src/validate.ts";

const sources: SourceRecord[] = [
  { id: "T2", kind: "ticket-description", trust: "authoritative", origin: "ticket X-1: description", basis: "test", text: "Rules:\n- A user can hold at most\n  five items.\n- Nothing else.", sha256: "" },
  { id: "P1", kind: "pr-description", trust: "pr-controlled", origin: "pull request #1", basis: "test", text: "A user can hold at most six items.", sha256: "" },
];
const draft: AnalysisDraft = {
  featureSummary: "x",
  requirements: [
    { id: "R1", text: "Limit is five", kind: "documented", sourceId: "T2", quote: "A user can hold at most **five** items.", relation: "none", relatedRequirementId: "" },
    { id: "R2", text: "Made up", kind: "documented", sourceId: "T2", quote: "A user can hold at most six items.", relation: "none", relatedRequirementId: "" },
    { id: "R3", text: "From the pull request", kind: "documented", sourceId: "P1", quote: "A user can hold at most six items.", relation: "contradicts", relatedRequirementId: "R1" },
    { id: "R4", text: "Guess", kind: "inferred", sourceId: "", quote: "", relation: "none", relatedRequirementId: "" },
  ],
  ambiguities: [{ id: "Q1", question: "?", why: "", relatedRequirementIds: [] }],
  risks: [{ id: "K1", description: "", basis: "", relatedRequirementIds: [] }],
  supersessions: [],
  contradictions: [],
};

test("a requirement is documented only if its quote is in the authoritative source it names", () => {
  const { analysis: checked, notes } = attribute(draft, sources);
  assert.deepEqual(
    checked.requirements.map((r) => r.kind),
    ["documented", "inferred", "claimed", "inferred"],
  );
  assert.equal(checked.requirements[0]!.trust, "authoritative");
  assert.match(notes.join("\n"), /R2 .* does not appear in source T2/);
  assert.match(notes.join("\n"), /R3 is a claim/);
});

const manifest = Manifest.parse({
  baseUrl: "http://localhost:1",
  fixtures: { account: { description: "d", path: "/x", account: true } },
});
const scenario = (over: Partial<PlanDraft["scenarios"][number]>): PlanDraft["scenarios"][number] => ({
  id: "S1",
  title: "t",
  basis: "requirement",
  requirementIds: ["R1"],
  riskIds: [],
  intent: "do it",
  setup: "",
  fixtures: [{ alias: "user", type: "account" }],
  status: "runnable",
  blockedReason: "",
  ambiguityIds: [],
  assertions: [],
  ...over,
});
const assertion = (over: Partial<PlanDraft["scenarios"][number]["assertions"][number]>) => ({
  id: "A1",
  description: "count shown",
  kind: "number_equals" as const,
  expectedNumber: 5,
  expectedText: null,
  expectedFormula: null,
  alsoVerifies: [] as string[],
  requirementId: "R1",
  ...over,
});
const checkedAnalysis = attribute(draft, sources).analysis;
const check = (draft: PlanDraft) => validatePlan(draft, checkedAnalysis, manifest, 10);

test("a sound scenario passes validation unchanged", () => {
  const { plan, problems } = check({ scenarios: [scenario({ assertions: [assertion({}), assertion({ id: "A2", expectedNumber: null, expectedFormula: "before + 1" })] })] });
  assert.deepEqual(problems, []);
  assert.equal(plan.scenarios[0]!.status, "runnable");
  assert.deepEqual(plan.scenarios[0]!.scenario.assertions[1]!.expected, { formula: "before + 1" });
  assert.deepEqual(plan.scenarios[0]!.scenario.fixtures, { user: "account" });
});

test("an expectation without a documented source is removed and becomes a question", () => {
  for (const requirementId of ["R4", "R2", "R9"]) {
    const { plan } = check({ scenarios: [scenario({ assertions: [assertion({ requirementId })] })] });
    assert.equal(plan.scenarios[0]!.status, "blocked", requirementId);
    assert.equal(plan.scenarios[0]!.scenario.assertions.length, 0);
    assert.equal(plan.clarifications.length, 1);
  }
});

test("malformed expectations, unknown fixtures and repeated ids are caught", () => {
  const bad = check({
    scenarios: [
      scenario({ assertions: [assertion({ expectedFormula: "a +" , expectedNumber: null }), assertion({ id: "A2", kind: "text_equals", expectedNumber: null })] }),
      scenario({ id: "S2", fixtures: [{ alias: "x", type: "nonexistent" }], assertions: [assertion({})] }),
      scenario({ id: "S2", assertions: [assertion({})] }),
      scenario({ id: "S3", status: "blocked", blockedReason: "needs Q1", ambiguityIds: ["Q1", "Q7"], assertions: [assertion({})] }),
    ],
  });
  assert.equal(bad.plan.scenarios.length, 3);
  assert.deepEqual(bad.plan.scenarios.map((s) => s.status), ["blocked", "blocked", "blocked"]);
  assert.deepEqual(bad.plan.scenarios[2]!.ambiguityIds, ["Q1"]);
  assert.equal(bad.plan.scenarios[2]!.scenario.assertions.length, 0);
  assert.ok(bad.problems.length >= 5);
});

test("the plan size limit is enforced", () => {
  const many = { scenarios: Array.from({ length: 4 }, (_, i) => scenario({ id: `S${i + 1}`, assertions: [assertion({})] })) };
  const trimmedPlan = validatePlan(many, checkedAnalysis, manifest, 3);
  assert.equal(trimmedPlan.plan.scenarios.length, 3);
  assert.deepEqual(trimmedPlan.problems, []);
  assert.equal(trimmedPlan.plan.notes.length, 1);
  const withBlocked = { scenarios: [...many.scenarios, scenario({ id: "S9", status: "blocked", blockedReason: "needs Q1" })] };
  assert.deepEqual(
    validatePlan(withBlocked, checkedAnalysis, manifest, 3).plan.scenarios.map((s) => s.scenario.id),
    ["S1", "S2", "S3", "S9"],
  );
});

test("Jira documents are flattened with their structure", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "heading", content: [{ type: "text", text: "Acceptance criteria" }] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First " }, { type: "text", text: "rule" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second rule" }] }] },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "line two" }] },
    ],
  };
  assert.equal(flattenAdf(adf), "Acceptance criteria\n- First rule\n- Second rule\nLine one\nline two\n");
  const ticket = normaliseIssue({
    key: "X-1",
    fields: { summary: "S", description: adf, comment: { comments: [{ author: { displayName: "Ana" }, created: "t", body: "plain v2 body" }] } },
  });
  assert.equal(ticket.comments[0]!.body, "plain v2 body");
  assert.match(ticket.description, /^Acceptance criteria\n- First rule/);
});

test("secrets are shown as placeholders, resolved for tools and scrubbed from output", () => {
  const vault = new SecretVault();
  const masked = vault.maskFixtures(
    { user: { handle: "u1", password: "hunter2-long", pin: "9911", note: "" } },
    { user: ["pin"] },
  );
  assert.deepEqual(masked, { user: { handle: "u1", password: "{{secret:user.password}}", pin: "{{secret:user.pin}}", note: "" } });
  assert.deepEqual(vault.resolve({ text: "{{secret:user.password}}", other: ["{{secret:nope}}"] }), {
    text: "hunter2-long",
    other: ["{{secret:nope}}"],
  });
  assert.equal(vault.scrub('textbox "Password": hunter2-long / 9911'), 'textbox "Password": {{secret:user.password}} / {{secret:user.pin}}');
});

test("write policy and link safety", () => {
  assert.equal(requestAllowed("none", "GET", "/a"), true);
  assert.equal(requestAllowed("none", "POST", "/a"), false);
  assert.equal(requestAllowed(["POST /sign-in", "POST /session/*"], "POST", "/sign-in"), true);
  assert.equal(requestAllowed(["POST /sign-in", "POST /session/*"], "POST", "/session/new"), true);
  assert.equal(requestAllowed(["POST /sign-in"], "DELETE", "/sign-in"), false);
  assert.equal(requestAllowed(["POST /sign-in"], "POST", "/sign-in/other"), false);
  assert.equal(linkIsSafe("Settings", "/settings", []), true);
  assert.equal(linkIsSafe("Sign out", "/bye", []), false);
  assert.equal(linkIsSafe("Item", "/items/3/delete", []), false);
  assert.equal(linkIsSafe("Archive", "/archive?id=3", ["archive"]), false);
});
