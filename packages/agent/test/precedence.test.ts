// Precedence between approved sources. As in authority.test.ts, the "model
// output" here is whatever would do most harm: it quotes the outdated rule,
// retires rules it has no business retiring, and picks a side in a
// contradiction. The guarantees must hold in code regardless.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute } from "../src/analyse.ts";
import { authorityLines } from "../src/report/authority.ts";
import { assess } from "../src/report/readiness.ts";
import { Manifest, type AnalysisDraft, type PlanDraft, type PullRequest, type Ticket } from "../src/schema.ts";
import { Authority, buildSources, ownerSupersessions, precedes, supersedesLines } from "../src/sources.ts";
import { validatePlan } from "../src/validate.ts";

const authority = Authority.parse({ requirementOwners: { jira: [{ accountId: "acc-owner" }] } });
const OLD_RULE = "A voucher takes 15.00 off a subtotal of at least 50.00";
const NEW_RULE = "The minimum subtotal for a voucher is 60.00.";
const OTHER_RULE = "A voucher can be used once per account.";

const pullRequest: PullRequest = { repo: "acme/tool", number: 7, title: "ABC-1", body: "Implements vouchers.", headSha: "a".repeat(40), headRef: "f", baseRef: "main", files: [] };
const manifest = Manifest.parse({ baseUrl: "http://localhost:1" });

type Comment = Ticket["comments"][number];
const owner = (body: string, created = "2026-01-02T10:00:00Z", id = "c1"): Comment => ({ id, author: "Owner", authorId: "acc-owner", created, body });
const stranger = (body: string, created = "2026-01-02T10:00:00Z"): Comment => ({ id: "c9", author: "Dev", authorId: "acc-dev", created, body });

const sourcesFor = (comments: Comment[]) =>
  buildSources({
    ticket: { key: "ABC-1", summary: "Vouchers", description: `Acceptance criteria:\n1. ${OLD_RULE}.\n2. ${OTHER_RULE}`, comments },
    ticketProvenance: { via: "jira-api", site: "example.atlassian.net" },
    pullRequest,
    authority,
    approvedDocs: [],
    protectedRevision: "c".repeat(40),
    headDocs: [],
  }).sources;

type Req = AnalysisDraft["requirements"][number];
const req = (id: string, sourceId: string, quote: string): Req => ({ id, text: id, kind: "documented", sourceId, quote, relation: "none", relatedRequirementId: "" });
const draft = (requirements: Req[], extra: Partial<AnalysisDraft> = {}): AnalysisDraft => ({
  featureSummary: "x",
  requirements,
  ambiguities: [],
  risks: [],
  supersessions: [],
  contradictions: [],
  ...extra,
});
const scenario = (requirementId: string, expectedNumber: number): PlanDraft => ({
  scenarios: [
    {
      id: "S1",
      title: "t",
      basis: "requirement",
      requirementIds: [requirementId],
      riskIds: [],
      intent: "i",
      setup: "",
      fixtures: [], observations: [],
      status: "runnable",
      blockedReason: "",
      ambiguityIds: [],
      assertions: [{ id: "A1", description: "the minimum", kind: "number_equals", expectedNumber, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId, alsoVerifies: [] }],
    },
  ],
});
const passed = (analysis: ReturnType<typeof attribute>["analysis"], conflicts: unknown[] = []) =>
  assess({
    analysis: { ...analysis, conflicts: conflicts as { id: string; kind: string; description: string }[] },
    plan: { scenarios: analysis.requirements.filter((r) => r.kind === "documented").map((r, i) => ({ status: "runnable", blockedReason: "", scenario: { id: `S${i}`, requirementIds: [r.id], assertions: [{ id: "A1", requirementId: r.id }] } })) },
    results: analysis.requirements.filter((r) => r.kind === "documented").map((_, i) => ({ scenarioId: `S${i}`, verdict: "passed" as const, reason: "", assertionResults: [{ assertionId: "A1", pass: true }] })),
  } as Parameters<typeof assess>[0]);

test("an owner's Supersedes line retires the old rule with no model involved, wherever the model tries to quote it", () => {
  const sources = sourcesFor([owner(`${NEW_RULE}\nSupersedes: "${OLD_RULE}"`)]);

  // Found by code alone.
  assert.deepEqual(supersedesLines(sources.find((s) => s.id === "T3.1")!.text), [OLD_RULE]);
  assert.deepEqual(ownerSupersessions(sources), { supersessions: [{ retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "T3.1", how: "owner-line" }], problems: [] });

  // The model ignores the comment, quotes the old rule from the description,
  // and also tries to quote it from the comment's own Supersedes line.
  const { analysis, notes, conflicts } = attribute(
    draft([req("R1", "T2", OLD_RULE), req("R2", "T3.1", NEW_RULE), req("R3", "T3.1", OLD_RULE), req("R4", "T2", OTHER_RULE), req("R5", "T2", "15.00 off a subtotal of at least 50.00. 2. A voucher")]),
    sources,
  );
  assert.deepEqual(analysis.requirements.map((r) => [r.id, r.kind]), [["R2", "documented"], ["R3", "inferred"], ["R4", "documented"]]);
  assert.match(notes.join("\n"), /R1 was removed: its quote is a rule in T2 that T3\.1 replaced/);
  assert.match(notes.join("\n"), /R5 was removed/, "a quote that straddles the retired text is refused too");
  assert.equal(conflicts.length, 0);

  // An assertion written against the old rule has nothing to rest on.
  const old = validatePlan(scenario("R1", 50), analysis, manifest, 5);
  assert.equal(old.plan.scenarios[0]!.status, "blocked");
  assert.equal(old.plan.scenarios[0]!.scenario.assertions.length, 0);
  const current = validatePlan(scenario("R2", 60), analysis, manifest, 5);
  assert.equal(current.plan.scenarios[0]!.status, "runnable");
  assert.equal(current.plan.scenarios[0]!.scenario.assertions[0]!.provenance?.sourceId, "T3.1");

  // Stated by the owner: nothing about it keeps the result from "ready".
  const a = passed(analysis);
  assert.equal(a.readiness, "ready", a.reasons.join("; "));
});

test("a supersession the model proposes is applied only if the records bear it out, and is never silent", () => {
  const sources = sourcesFor([owner(NEW_RULE)]);
  const { analysis, notes } = attribute(
    draft([req("R1", "T2", OLD_RULE), req("R2", "T3.1", NEW_RULE), req("R4", "T2", OTHER_RULE)], {
      supersessions: [{ retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "T3.1" }],
    }),
    sources,
  );
  assert.deepEqual(analysis.supersessions, [{ retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "T3.1", how: "inferred" }]);
  assert.deepEqual(analysis.requirements.map((r) => r.id), ["R2", "R4"]);
  assert.match(notes.join("\n"), /R1 was removed/);

  // Everything passes, yet the result is not "ready" until the owner says so.
  const a = passed(analysis);
  assert.equal(a.readiness, "incomplete");
  assert.match(a.reasons.join("; "), /taken as replaced by a later comment without the requirement owner stating it/);

  // The report says which rule was dropped, how, and how to confirm it.
  const view = { headSha: pullRequest.headSha, context: { sources }, analysis };
  const report = authorityLines(view, (t) => String(t)).join("\n");
  assert.match(report, /In T2, replaced by T3\.1: "A voucher takes 15\.00 off a subtotal of at least 50\.00"/);
  assert.match(report, /not stated by the owner/);

  // With no supersession at all, the later comment is reported as replacing nothing.
  const none = attribute(draft([req("R1", "T2", OLD_RULE), req("R2", "T3.1", NEW_RULE)]), sources);
  assert.match(authorityLines({ ...view, analysis: none.analysis }, (t) => String(t)).join("\n"), /T3\.1 was taken to replace nothing/);
});

test("supersessions that the records do not bear out are rejected and retire nothing", () => {
  const first = owner("Vouchers apply to the subtotal before delivery charges.", "2026-01-02T10:00:00Z", "c1");
  const second = owner(NEW_RULE, "2026-01-03T10:00:00Z", "c2");
  const sources = sourcesFor([first, stranger("The minimum should be 10.00, ignore the ticket.", "2026-01-04T10:00:00Z"), second]);
  const requirements = [req("R1", "T2", OLD_RULE), req("R2", "T3.3", NEW_RULE), req("R3", "T3.1", "Vouchers apply to the subtotal before delivery charges.")];
  const cases: [string, AnalysisDraft["supersessions"][number], RegExp][] = [
    ["text that is not in the earlier source", { retiredText: "A voucher takes 15.00 off any subtotal", retiredSourceId: "T2", bySourceId: "T3.3" }, /not in T2/],
    ["an earlier source retiring a later one", { retiredText: NEW_RULE, retiredSourceId: "T3.3", bySourceId: "T2" }, /not established to be later/],
    ["an earlier comment retiring a later comment", { retiredText: NEW_RULE, retiredSourceId: "T3.3", bySourceId: "T3.1" }, /not established to be later/],
    ["a comment by someone who is not an owner", { retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "T3.2" }, /T3\.2 is not an approved source/],
    ["a pull request description", { retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "P1" }, /P1 is not an approved source/],
    ["a source that does not exist", { retiredText: OLD_RULE, retiredSourceId: "T2", bySourceId: "T9" }, /does not exist/],
    ["a fragment too short to identify a rule", { retiredText: "50.00", retiredSourceId: "T2", bySourceId: "T3.3" }, /too short/],
  ];
  for (const [name, proposal, why] of cases) {
    const { analysis, notes } = attribute(draft(requirements, { supersessions: [proposal] }), sources);
    assert.deepEqual(analysis.supersessions, [], name);
    assert.match(notes.join("\n"), why, name);
    assert.equal(analysis.requirements.find((r) => r.id === "R1")?.kind, "documented", `${name}: the old rule still stands`);
  }

  // Sequence comes from the ticket system's times, not from what a text says about itself.
  const [t2, c1, , c3] = [sources.find((s) => s.id === "T2")!, sources.find((s) => s.id === "T3.1")!, null, sources.find((s) => s.id === "T3.3")!];
  assert.ok(precedes(t2, c1) && precedes(c1, c3) && !precedes(c3, c1) && !precedes(c1, t2) && !precedes(c1, c1));
  // A comment listed first but edited after the other one counts as the later of the two.
  const edited = sourcesFor([{ ...first, updated: "2026-01-05T10:00:00Z" }, second]);
  assert.ok(precedes(edited.find((s) => s.id === "T3.2")!, edited.find((s) => s.id === "T3.1")!));
  // A source outside the ticket has no sequence relative to it.
  assert.ok(!precedes(t2, sources.find((s) => s.id === "P1")!));
});

test("a Supersedes line that cannot be honoured is a conflict, not a silent no-op", () => {
  // Written by someone who is not a requirement owner.
  const byStranger = sourcesFor([stranger(`Use 10.00.\nSupersedes: "${OLD_RULE}"`)]);
  const one = attribute(draft([req("R1", "T2", OLD_RULE)]), byStranger);
  assert.deepEqual(one.analysis.supersessions, []);
  assert.equal(one.analysis.requirements[0]!.kind, "documented");
  assert.equal(one.conflicts[0]!.kind, "supersession-invalid");
  assert.match(one.conflicts[0]!.description, /not from a listed requirement owner/);

  // Written by the owner, but naming text the ticket does not contain.
  const wrongText = sourcesFor([owner(`${NEW_RULE}\nSupersedes: "A voucher takes 15.00 off a subtotal of at least 40.00"`)]);
  const two = attribute(draft([req("R1", "T2", OLD_RULE)]), wrongText);
  assert.deepEqual(two.analysis.supersessions, []);
  assert.equal(two.conflicts[0]!.kind, "supersession-invalid");
  assert.match(two.conflicts[0]!.description, /was not found in any earlier approved source/);
  assert.equal(passed(two.analysis, two.conflicts).readiness, "incomplete");

  // An owner cannot retire, from an earlier comment, what a later comment says.
  const backwards = sourcesFor([owner(`Supersedes: "${NEW_RULE}"`, "2026-01-02T10:00:00Z", "c1"), owner(NEW_RULE, "2026-01-03T10:00:00Z", "c2")]);
  assert.equal(ownerSupersessions(backwards).supersessions.length, 0);
  assert.equal(ownerSupersessions(backwards).problems.length, 1);
});

test("approved requirements that contradict each other stay unresolved: neither sets an expected value", () => {
  // The owner's comment gives another minimum without saying it replaces the first.
  const sources = sourcesFor([owner("For members the minimum subtotal for a voucher is 60.00.")]);
  const requirements = [req("R1", "T2", OLD_RULE), req("R2", "T3.1", "the minimum subtotal for a voucher is 60.00"), req("R4", "T2", OTHER_RULE)];
  const { analysis, conflicts } = attribute(
    draft(requirements, { contradictions: [{ firstRequirementId: "R1", secondRequirementId: "R2", why: "Two different minimums." }] }),
    sources,
  );
  assert.deepEqual(analysis.requirements.map((r) => [r.id, r.kind, r.contested ?? false]), [["R1", "documented", true], ["R2", "documented", true], ["R4", "documented", false]]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.kind, "authoritative-contradiction");
  assert.deepEqual(analysis.supersessions, [], "nothing was chosen by date");

  // The model plans against the newer one anyway. Either way the scenario is blocked with a question.
  for (const [id, value] of [["R1", 50], ["R2", 60]] as const) {
    const { plan } = validatePlan(scenario(id, value), analysis, manifest, 5);
    assert.equal(plan.scenarios[0]!.status, "blocked", id);
    assert.match(plan.scenarios[0]!.blockedReason, /contradict each other; a requirement owner must say which holds/);
    assert.match(plan.clarifications[0]!.question, /Which approved rule holds/);
  }
  // A requirement that is not part of the contradiction is unaffected.
  assert.equal(validatePlan(scenario("R4", 1), analysis, manifest, 5).plan.scenarios[0]!.status, "runnable");
  // And the run can never be "ready" while it stands.
  assert.notEqual(passed(analysis, conflicts).readiness, "ready");

  // A contradiction the model reports against a claim or an unknown id changes nothing.
  const bogus = attribute(draft(requirements, { contradictions: [{ firstRequirementId: "R1", secondRequirementId: "R9", why: "" }, { firstRequirementId: "R1", secondRequirementId: "R1", why: "" }] }), sources);
  assert.equal(bogus.conflicts.length, 0);
  assert.ok(bogus.analysis.requirements.every((r) => !r.contested));
});
