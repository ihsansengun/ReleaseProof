// What the reliability gate of 20 November showed could not be done
// correctly: read a table cell whose text equals the expected text, compare
// a value as it was before the page changed, and get the scenario exactly at
// a threshold run under the limit. Each test rebuilds one of the gate's
// cases. No model is used.
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
import { buildDiagnostics, diagnosticLines } from "../src/report/diagnostics.ts";
import { standings } from "../src/report/standing.ts";
import { Manifest, type Analysis, type Assertion, type PlanDraft, type RunReport, type Scenario, type ScenarioResult } from "../src/schema.ts";
import { validatePlan } from "../src/validate.ts";

type Run = (tool: string, input: unknown) => Promise<{ ok: boolean; output: string }>;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withApp<T>(handler: Handler, scenario: Scenario, work: (run: Run) => Promise<T>): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-tg-")) });
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

const cell = (row: string, column: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "cell", value: column, row: { by: "text", value: row }, count: false, read: "text", ...extra });
const labelled = (value: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "labelled", value, count: false, read: "text", ...extra });
const byText = (value: string, extra: Record<string, unknown> = {}) => ({ source: "page", by: "text", value, count: false, read: "text", ...extra });
const scenario = (assertions: Assertion[], over: Partial<Scenario> = {}): Scenario => ({ id: "S4", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions, ...over });
const check = (run: Run, assertionId: string, target?: unknown) => run("check", { assertionId, ...(target ? { target } : {}), rationale: "r" });
const observe = (run: Run, name: string, target: unknown) => run("observe", { name, target, rationale: "r" });

// The requests table of the gate's time-off run: the status cell reads the very word the assertion expects.
const requests = (statusOfTrip: string) => `<h1>My requests</h1>
<table aria-label="Requests">
  <tr><th>Id</th><th>First day</th><th>Days</th><th>Reason</th><th>Status</th></tr>
  <tr><td>#15</td><td>2026-12-01</td><td>2</td><td>Family</td><td>Approved</td></tr>
  <tr><td>#16</td><td>2026-12-08</td><td>3</td><td>Trip</td><td>${statusOfTrip}</td></tr>
  <tr><td>#17</td><td>2026-12-20</td><td>1</td><td>Dentist</td><td>Pending</td></tr>
</table>
<p>Days remaining: <span>20</span></p>`;

const status: Assertion = { id: "A4", description: "the cancelled request shows as Cancelled", kind: "text_equals", expected: { literal: "Cancelled" }, requirementId: "R6" };

test("the status cell of one row is read by row and column, whatever it says (time-off S4 and S7)", async () => {
  const { value, result } = await withApp(html(requests("Cancelled")), scenario([status]), async (run) => ({
    // As in the gate: naming the cell by its own text is circular, and stays refused.
    byItsText: await check(run, "A4", { source: "page", by: "role", role: "cell", value: "Cancelled", count: false, read: "text" }),
    // The way out the escalated run took then, a neighbouring cell with a catch-all pattern, read "Trip".
    // Now the cell is identified by what its row contains and what its column is called.
    byRowAndColumn: await check(run, "A4", cell("Trip", "Status")),
  }));
  assert.equal(value.byItsText.ok, false);
  assert.match(value.byItsText.output, /located by the expected text itself/);
  assert.match(value.byRowAndColumn.output, /expected Cancelled, actual Cancelled -> match/);
  assert.equal(result.verdict, "passed");
  const evidence = result.assertionResults[0]!.evidence!;
  assert.equal(evidence.target.locatedBy, 'cell in row text "Trip", column "Status"');
  assert.equal(evidence.target.element!.tag, "td");
  assert.equal(evidence.raw, "Cancelled");

  // The other row by its id (S7 read the id cell itself); and a status that really is wrong fails.
  const byId = await withApp(html(requests("Cancelled")), scenario([status]), (run) => check(run, "A4", cell("#16", "Status")));
  assert.equal(byId.result.verdict, "passed");
  const wrong = await withApp(html(requests("Approved")), scenario([status]), (run) => check(run, "A4", cell("Trip", "Status")));
  assert.match(wrong.value.output, /expected Cancelled, actual Approved -> MISMATCH/);
  assert.equal(wrong.result.verdict, "failed");
});

test("row and column are identified independently of the value, and anything ambiguous reads nothing", async () => {
  const days: Assertion = { id: "A1", description: "days of the trip", kind: "number_equals", expected: { literal: 3 }, requirementId: "R1" };
  const { value, result } = await withApp(html(requests("Cancelled")), scenario([days, status]), async (run) => ({
    // A row may not be identified by the value sought.
    rowByValue: await check(run, "A4", cell("Cancelled", "Status")),
    // "2026" is in every row.
    manyRows: await check(run, "A1", cell("2026", "Days")),
    noRow: await check(run, "A1", cell("Holiday", "Days")),
    noColumn: await check(run, "A1", cell("Trip", "Length")),
    headerRow: await check(run, "A1", cell("First day", "Days")),
    // Column headers are matched whole and in any case: "day" is not "Days", "days" is.
    partColumn: await check(run, "A1", cell("Trip", "day")),
    good: await check(run, "A1", cell("Trip", "days")),
  }));
  assert.match(value.rowByValue.output, /located by the expected text itself \("Cancelled"\)/);
  assert.match(value.manyRows.output, /Ambiguous target: 3 rows match .* Nothing was read\./);
  assert.match(value.noRow.output, /Expected exactly one row .* found 0\. Nothing was read\./);
  assert.match(value.noColumn.output, /No cell was read: 0 columns are headed "Length"; the headers are: id \| first day \| days \| reason \| status\./);
  assert.match(value.headerRow.output, /No cell was read: the row matched is the header row\./);
  assert.match(value.partColumn.output, /0 columns are headed "day"/);
  assert.match(value.good.output, /expected 3, actual 3 -> match/);
  // Six refusals recorded nothing; the one assertion never compared leaves the scenario without a verdict.
  assert.deepEqual(result.assertionResults.map((r) => r.assertionId), ["A1"]);
  assert.equal(result.verdict, "unverified");

  // A header that appears twice, and a table with merged cells, cannot place a cell.
  const twice = `<table><tr><th>Name</th><th>Total</th><th>Total</th></tr><tr><td>Alpha</td><td>1</td><td>2</td></tr></table>`;
  const merged = `<table><tr><th>Name</th><th>Total</th></tr><tr><td colspan="2">Alpha 5</td></tr></table>`;
  const total: Assertion = { id: "A1", description: "total of Alpha", kind: "number_equals", expected: { literal: 9 }, requirementId: "R1" };
  const a = await withApp(html(twice), scenario([total]), (run) => check(run, "A1", cell("Alpha", "Total")));
  assert.match(a.value.output, /2 columns are headed "Total"/);
  const b = await withApp(html(merged), scenario([total]), (run) => check(run, "A1", cell("Alpha", "Total")));
  assert.match(b.value.output, /merged cells/);
  assert.equal(a.result.verdict, "unverified");
  assert.equal(b.result.verdict, "unverified");

  // Scoping: the same row text in two tables is resolved by naming the table.
  const two = `<table aria-label="Open"><tr><th>Name</th><th>State</th></tr><tr><td>Alpha</td><td>Open</td></tr></table>
    <table aria-label="Archive"><tr><th>Name</th><th>State</th></tr><tr><td>Alpha</td><td>Closed</td></tr></table>`;
  const state: Assertion = { id: "A1", description: "archived state", kind: "text_equals", expected: { literal: "Closed" }, requirementId: "R1" };
  const scoped = await withApp(html(two), scenario([state]), async (run) => ({
    unscoped: await check(run, "A1", cell("Alpha", "State")),
    scoped: await check(run, "A1", cell("Alpha", "State", { within: { by: "role", role: "table", value: "Archive" } })),
  }));
  assert.match(scoped.value.unscoped.output, /Ambiguous target: 2 rows/);
  assert.match(scoped.value.scoped.output, /expected Closed, actual Closed -> match/);
});

test("a value beside its label is read from a list, a row header or a form field", async () => {
  const page = `<dl><dt>Plan</dt><dd>Team</dd><dt>Seats:</dt><dd>12</dd></dl>
    <table><tr><th>Owner</th><td>Alex</td></tr><tr><th>Renewal</th><td>2027-01-01</td></tr></table>
    <label for="q">Quantity</label><input id="q" value="6">
    <label for="r">Region</label><select id="r"><option>North</option><option selected>South</option></select>
    <label>Orphan</label>
    <dl><dt>Plan</dt><dd>Legacy</dd></dl>`;
  const a = (id: string, kind: Assertion["kind"], literal: number | string): Assertion => ({ id, description: id, kind, expected: { literal }, requirementId: "R1" });
  const { value, result } = await withApp(html(page), scenario([a("A1", "number_equals", 12), a("A2", "text_equals", "Alex"), a("A3", "number_equals", 6), a("A4", "text_equals", "South"), a("A5", "text_equals", "Team"), a("A6", "text_equals", "x")]), async (run) => ({
    seats: await check(run, "A1", labelled("Seats")),
    owner: await check(run, "A2", labelled("Owner")),
    quantity: await check(run, "A3", labelled("Quantity")),
    region: await check(run, "A4", labelled("Region")),
    // Two terms read "Plan": ambiguous, nothing read.
    plan: await check(run, "A5", labelled("Plan")),
    orphan: await check(run, "A6", labelled("Orphan")),
    missing: await check(run, "A6", labelled("Budget")),
  }));
  assert.match(value.seats.output, /expected 12, actual 12 -> match/);
  assert.match(value.owner.output, /expected Alex, actual Alex -> match/);
  // A form control shows its value.
  assert.match(value.quantity.output, /expected 6, actual 6 -> match/);
  assert.match(value.region.output, /expected South, actual South -> match/);
  assert.match(value.plan.output, /Ambiguous target: 2 labels read "Plan"/);
  // A label with no control, and a label that is not there, have no value to read.
  assert.match(value.orphan.output, /Expected exactly one label "Orphan" with a value beside it, found 0/);
  assert.match(value.missing.output, /Expected exactly one label "Budget" with a value beside it, found 0/);
  assert.equal(result.verdict, "unverified");
  assert.deepEqual(result.assertionResults.map((r) => [r.assertionId, r.pass]), [["A1", true], ["A2", true], ["A3", true], ["A4", true]]);
});

// ---- immutable observations -------------------------------------------------

// The gate's shop page: the subtotal follows the quantity, and the scenario lowers the quantity twice.
function basket(): Handler {
  let quantity = 6;
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/set") quantity = Number(url.searchParams.get("q"));
    if (url.pathname === "/state") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ quantity, subtotalCents: quantity * 1200 }));
      return;
    }
    html(`<h1>Basket</h1>
      <table><tr><th>Item</th><th>Unit price</th><th>Quantity</th></tr><tr><td>Notebook</td><td>$12.00</td><td>${quantity}</td></tr></table>
      <p>Subtotal: $${(quantity * 12).toFixed(2)}</p>
      <p>State: <b>${quantity >= 5 ? "Eligible" : "Below minimum"}</b></p>`)(request, response);
  };
}
const SHOP_OBSERVATIONS: Scenario["observations"] = [
  { name: "unitPrice", what: "the unit price", when: "before any change", unit: "currency-units" },
  { name: "subtotalAtSix", what: "the subtotal", when: "at quantity 6, before it is lowered", unit: "currency-units" },
  { name: "stateAtSix", what: "the eligibility state", when: "at quantity 6, before it is lowered", unit: "plain", type: "text" },
  { name: "subtotalAtFour", what: "the subtotal", when: "after lowering the quantity to 4", unit: "currency-units" },
];
const atSix: Assertion = { id: "A1", description: "subtotal at quantity 6 equals unit price times 6", kind: "number_equals", unit: "currency-units", expected: { formula: "unitPrice * 6" }, actual: { observation: "subtotalAtSix" }, requirementId: "R35" };
const stateThen: Assertion = { id: "A2", description: "the basket was eligible at quantity 6", kind: "text_equals", expected: { literal: "Eligible" }, actual: { observation: "stateAtSix" }, requirementId: "R6" };
const atFour: Assertion = { id: "A3", description: "subtotal at quantity 4 equals unit price times 4", kind: "number_equals", unit: "currency-units", expected: { formula: "unitPrice * 4" }, actual: { observation: "subtotalAtFour" }, requirementId: "R35" };
const stateNow: Assertion = { id: "A4", description: "the basket is below the minimum at the end", kind: "text_equals", expected: { literal: "Below minimum" }, requirementId: "R6" };

test("an assertion about an earlier moment compares what was recorded then, not the page as it is now (shop S5)", async () => {
  const s = scenario([atSix, stateThen, atFour, stateNow], { id: "S5", observations: SHOP_OBSERVATIONS });
  const { value, result } = await withApp(basket(), s, async (run) => {
    await observe(run, "unitPrice", cell("Notebook", "Unit price"));
    await observe(run, "subtotalAtSix", byText("Subtotal:"));
    const state = await observe(run, "stateAtSix", byText("State:", { pattern: "State: (.+)" }));
    const tooEarly = await check(run, "A3");
    await run("navigate", { path: "/set?q=5", rationale: "lower to 5" });
    // The gate's false positive: the check made against the live page after the quantity changed.
    const live = await check(run, "A1", byText("Subtotal:"));
    await run("navigate", { path: "/set?q=4", rationale: "lower to 4" });
    await observe(run, "subtotalAtFour", byText("Subtotal:"));
    return {
      state, tooEarly, live,
      a1: await check(run, "A1"),
      a2: await check(run, "A2"),
      a3: await check(run, "A3"),
      a4: await check(run, "A4", byText("State:", { pattern: "State: (.+)" })),
    };
  });
  assert.match(value.state.output, /Recorded stateAtSix = "Eligible"/);
  assert.match(value.tooEarly.output, /Assertion A3 cannot be checked yet: observation "subtotalAtFour" has not been recorded \(its moment: after lowering the quantity to 4\)\. No result was recorded\./);
  assert.equal(value.live.ok, false);
  assert.match(value.live.output, /Assertion A1 is about the observation "subtotalAtSix" as it was recorded at its moment, not about the page as it is now\. Call check for it without a target\. No result was recorded\./);
  // Two state changes later, the first values are what is compared.
  assert.match(value.a1.output, /expected 72, actual 72 \(observation "subtotalAtSix", recorded at step 2\) -> match/);
  assert.match(value.a2.output, /expected Eligible, actual Eligible \(observation "stateAtSix", recorded at step 3\) -> match/);
  assert.match(value.a3.output, /expected 48, actual 48/);
  assert.match(value.a4.output, /expected Below minimum, actual Below minimum -> match/);
  assert.deepEqual(result.observations, { unitPrice: 12, subtotalAtSix: 72, subtotalAtFour: 48 });
  assert.deepEqual(result.textObservations, { stateAtSix: "Eligible" });

  // The record behind the comparison describes the moment of the reading.
  const evidence = result.assertionResults.find((r) => r.assertionId === "A1")!;
  assert.deepEqual(evidence.target, { source: "observation", name: "subtotalAtSix", from: "page", recordedAtStep: 2 });
  assert.equal(evidence.evidence!.target.locatedBy, 'observation "subtotalAtSix" recorded at step 2 (at quantity 6, before it is lowered) from text "Subtotal:"');
  assert.equal(evidence.evidence!.raw, "Subtotal: $72.00");
  assert.equal(evidence.evidence!.resource.page, "/");
  assert.deepEqual(evidence.evidence!.before.map((b) => [b.name, b.value, b.step]), [["subtotalAtSix", 72, 2], ["unitPrice", 12, 1]]);
});

test("a recorded value that is wrong still fails, and one that was contested is not compared", async () => {
  // A build that charges 11 a piece while showing a unit price of 12.
  const wrong: Handler = html(`<table><tr><th>Item</th><th>Unit price</th></tr><tr><td>Notebook</td><td>$12.00</td></tr></table><p>Subtotal: $66.00</p>`);
  const s = scenario([atSix], { id: "S5", observations: SHOP_OBSERVATIONS });
  const failed = await withApp(wrong, s, async (run) => {
    await observe(run, "unitPrice", cell("Notebook", "Unit price"));
    await observe(run, "subtotalAtSix", byText("Subtotal:"));
    return check(run, "A1");
  });
  assert.match(failed.value.output, /expected 72, actual 66 \(observation "subtotalAtSix", recorded at step 2\) -> MISMATCH/);
  assert.equal(failed.result.verdict, "failed");
  // Read from the page, it stands as one page reading; read from the API, as the application's own statement.
  assert.deepEqual([...standings([atSix], failed.result)], [["A1", "single"]]);
  const viaApi = { assertionResults: [{ ...failed.result.assertionResults[0]!, target: { source: "observation", name: "subtotalAtSix", from: "api" } }] };
  assert.deepEqual([...standings([atSix], viaApi)], [["A1", "state"]]);

  // Recorded, then attempted again: the assertion that names it cannot be checked.
  const contested = await withApp(basket(), s, async (run) => {
    await observe(run, "unitPrice", cell("Notebook", "Unit price"));
    await observe(run, "subtotalAtSix", byText("Subtotal:"));
    await observe(run, "subtotalAtSix", byText("Subtotal:"));
    return check(run, "A1");
  });
  assert.equal(contested.value.ok, false);
  assert.match(contested.value.output, /Assertion A1 cannot be checked: subtotalAtSix was needed at more than one moment/);
  assert.equal(contested.result.verdict, "unverified");

  // The diagnostics show the observation's own moment for the comparison.
  const run = {
    ticketKey: "T-1", pullRequest: { number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://localhost:1" },
    context: { sources: [] }, analysis: { requirements: [], ambiguities: [], risks: [] }, analysisNotes: [],
    plan: { scenarios: [{ scenario: s, status: "runnable", riskIds: [], ambiguityIds: [], blockedReason: "" }], notes: [], clarifications: [] },
    results: [failed.result], confirmations: {}, timings: [], startedAt: "2026-11-20T00:00:00Z",
  } as unknown as RunReport;
  assert.match(diagnosticLines(buildDiagnostics(run)).join("\n"), /target observation "subtotalAtSix" recorded at step 2 \(at quantity 6, before it is lowered\) from text "Subtotal:"; read "Subtotal: \$66\.00"/);
});

test("the plan decides which assertions are about an observation, and the validator holds it to that", () => {
  const analysis: Analysis = { featureSummary: "", requirements: [{ id: "R1", text: "r", kind: "documented", quote: "the subtotal is price times quantity", sourceId: "T2", trust: "authoritative", origin: "ticket", relation: "none" }], ambiguities: [], risks: [] };
  type Draft = PlanDraft["scenarios"][number];
  const a = (over: Partial<Draft["assertions"][number]>): Draft["assertions"][number] => ({ id: "A1", description: "d", kind: "number_equals", expectedNumber: null, expectedText: null, expectedFormula: "unitPrice * 6", unit: "currency-units", requirementId: "R1", alsoVerifies: [], ...over });
  const observations: Draft["observations"] = [
    { name: "unitPrice", what: "w", when: "at the start", unit: "currency-units" },
    { name: "subtotalAtSix", what: "w", when: "at quantity 6", unit: "currency-units" },
    { name: "cents", what: "w", when: "at quantity 6", unit: "currency-hundredths" },
    { name: "stateAtSix", what: "w", when: "at quantity 6", unit: "plain", type: "text" },
  ];
  const plan = (assertions: Draft["assertions"]) =>
    validatePlan({ scenarios: [{ id: "S1", title: "t", basis: "requirement", requirementIds: ["R1"], riskIds: [], intent: "i", setup: "", fixtures: [], observations, status: "runnable", blockedReason: "", ambiguityIds: [], assertions }] }, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 5, { declared: true });

  const good = plan([a({ actualObservation: "subtotalAtSix" }), a({ id: "A2", kind: "text_equals", expectedFormula: null, expectedText: "Eligible", unit: "plain", actualObservation: "stateAtSix" }), a({ id: "A3" })]);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.plan.scenarios[0]!.scenario.assertions.map((x) => x.actual), [{ observation: "subtotalAtSix" }, { observation: "stateAtSix" }, undefined]);
  assert.equal(good.plan.scenarios[0]!.scenario.observations!.find((o) => o.name === "stateAtSix")!.type, "text");

  const bad = plan([
    a({ id: "A1", actualObservation: "neverDeclared" }),
    a({ id: "A2", actualObservation: "stateAtSix" }),
    a({ id: "A3", actualObservation: "cents" }),
    a({ id: "A4", expectedFormula: "subtotalAtSix", actualObservation: "subtotalAtSix" }),
    a({ id: "A5", kind: "present", expectedFormula: null, unit: "plain", actualObservation: "subtotalAtSix" }),
    a({ id: "A6", expectedFormula: "stateAtSix * 2" }),
  ]);
  const said = bad.problems.join("\n");
  assert.match(said, /S1\/A1 is about observation "neverDeclared", which the scenario does not declare; it was removed\./);
  assert.match(said, /S1\/A2 compares a number with observation "stateAtSix", which holds text; it was removed\./);
  assert.match(said, /S1\/A3 expects a value in currency-units and is about observation "cents", recorded in currency-hundredths; it was removed\./);
  assert.match(said, /S1\/A4 compares observation "subtotalAtSix" with itself; it was removed\./);
  assert.match(said, /S1\/A5 is a presence check, which cannot be about a recorded observation; it was removed\./);
  assert.match(said, /S1\/A6 uses stateAtSix in its formula, which holds text and cannot be calculated with/);
});

// ---- selection --------------------------------------------------------------

test("under a limit of six, a plan like the gate's now runs the 2-day and the 3-day scenario", () => {
  const ids = ["R1", "R2", "R3", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20", "R21", "R22", "R23", "R24", "R25", "R26", "R4"];
  const analysis = {
    featureSummary: "",
    requirements: ids.map((id) => ({ id, text: id, kind: "documented" as const, quote: id, sourceId: "T2", trust: "authoritative" as const, origin: "ticket", relation: "none" as const })),
    ambiguities: [],
    risks: ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9"].map((id) => ({ id, description: id })),
  } as unknown as Analysis;
  type Draft = PlanDraft["scenarios"][number];
  const c = (id: string, title: string, compares: string[], focus: NonNullable<Draft["focus"]>, riskIds: string[] = []): Draft => ({
    id, title, basis: "requirement", requirementIds: compares, riskIds, intent: "i", setup: "", fixtures: [], observations: [], status: "runnable", blockedReason: "", ambiguityIds: [], focus,
    assertions: compares.map((requirementId, i) => ({ id: `A${i + 1}`, description: "d", kind: "present" as const, expectedNumber: null, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId, alsoVerifies: [] })),
  });
  // Twelve runnable candidates modelled on the gate's run A: its titles and the requirements its report credited to each.
  const pool: Draft[] = [
    c("S1", "Approved leave starting today+2 cannot be cancelled (just below the 3-day notice)", ["R12", "R13", "R14", "R15", "R2"], [{ requirementId: "R12", aspect: "boundary-below" }, { requirementId: "R13", aspect: "boundary-below" }], ["K1", "K3", "K6", "K8"]),
    c("S2", "Another employee cannot cancel", ["R17", "R18"], [{ requirementId: "R18", aspect: "ownership" }], ["K2"]),
    c("S3", "Cancel Approved with refund", ["R10", "R11", "R8"], [{ requirementId: "R8", aspect: "state-transition" }]),
    c("S4", "Cancel Pending", ["R1", "R3", "R5", "R6", "R7"], [], ["K7", "K9"]),
    c("S5", "API returns the request; second cancel refused", ["R24", "R25", "R26", "R8", "R9"], []),
    c("S6", "Manager cannot decide a Cancelled request", ["R20", "R21"], [], ["K4"]),
    c("S7", "Manager sees it under Decided", ["R22", "R23"], [], ["K5"]),
    c("S8", "Manager cannot cancel", ["R19"], [{ requirementId: "R19", aspect: "access-control" }]),
    c("S9", "Approved leave starting today+3 can be cancelled (exactly at the 3-day notice)", ["R12"], [{ requirementId: "R12", aspect: "boundary-at" }]),
    c("S10", "Pending cancelled on its first day", ["R16"], []),
    c("S11", "Rejected has no button", ["R4"], []),
    c("S12", "Approved leave starting today+4 can be cancelled (just above the 3-day notice)", ["R12"], [{ requirementId: "R12", aspect: "boundary-above" }]),
  ];
  const plan = validatePlan({ scenarios: pool }, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 6).plan;
  const ranked = plan.scenarios.filter((s) => s.selection?.rank !== undefined).sort((x, y) => x.selection!.rank! - y.selection!.rank!);
  // In the gate S9 was deferred: it added 2 where each scenario above it added 6 or more.
  assert.deepEqual(ranked.map((s) => [s.selection!.rank, s.scenario.id]), [[1, "S1"], [2, "S9"], [3, "S4"], [4, "S5"], [5, "S2"], [6, "S3"]]);
  assert.match(ranked[0]!.selection!.reasons[0]!, /taken first because it tests a stated threshold at or just below it/);
  assert.deepEqual(ranked[1]!.selection!.reasons, ["taken first because it tests a stated threshold at or just below it", "exactly at the threshold for R12"]);
  // Breadth is otherwise chosen as before, and everything left out is reported.
  assert.deepEqual(plan.scenarios.filter((s) => s.status === "deferred").map((s) => s.scenario.id), ["S6", "S7", "S8", "S10", "S11", "S12"]);
  assert.deepEqual(plan.selection!.boundaryGaps, [
    "R12: the scenario just above the threshold was planned and not run",
    // The planner tagged a second rule just below a threshold and wrote nothing at or above it: a gap in the plan, reported as one.
    "R13: no scenario was planned exactly at the threshold",
    "R13: no scenario was planned just above the threshold",
  ]);

  // More threshold positions than half the limit: the best-scoring are taken first, the rest compete on
  // coverage like any other scenario, and each one that does not run is listed.
  const crowded = [
    pool[0]!,
    pool[8]!,
    c("S13", "Second rule, just below", ["R20"], [{ requirementId: "R20", aspect: "boundary-below" }]),
    c("S14", "Second rule, exactly at", ["R20"], [{ requirementId: "R20", aspect: "boundary-at" }]),
    pool[3]!,
    pool[4]!,
  ];
  const four = validatePlan({ scenarios: crowded }, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 4).plan;
  const order = four.scenarios.filter((s) => s.selection?.rank !== undefined).sort((x, y) => x.selection!.rank! - y.selection!.rank!).map((s) => s.scenario.id);
  // Two of four slots are reserved: S1 (below two rules), then S13 (a first comparison and a position). Breadth takes the rest.
  assert.deepEqual(order, ["S1", "S13", "S4", "S5"]);
  assert.deepEqual(four.selection!.boundaryGaps, [
    "R12: the scenario exactly at the threshold was planned and not run",
    "R12: no scenario was planned just above the threshold",
    "R13: no scenario was planned exactly at the threshold",
    "R13: no scenario was planned just above the threshold",
    "R20: the scenario exactly at the threshold was planned and not run",
    "R20: no scenario was planned just above the threshold",
  ]);

  // No thresholds declared: nothing is reserved and the choice is the coverage choice alone.
  const none = validatePlan({ scenarios: pool.map((s) => ({ ...s, focus: (s.focus ?? []).filter((f) => !f.aspect.startsWith("boundary")) })) }, analysis, Manifest.parse({ baseUrl: "http://localhost:1" }), 6).plan;
  assert.ok(none.scenarios.every((s) => !(s.selection?.reasons ?? []).some((r) => r.startsWith("taken first"))));
  assert.deepEqual(none.selection!.boundaryGaps, []);
});

// ---- corrections ------------------------------------------------------------

test("a number inside a name is not the number, and the results table has a separator for every header", () => {
  const page = (value: string) => ({ source: "page" as const, by: "text" as const, value, count: false, read: "text" as const });
  // The gate refused "Discount (TAKE15):" for an expected 15.
  assert.equal(circular(page("Discount (TAKE15):"), 15, { kind: "number_equals" }), undefined);
  assert.equal(circular(page("SAVE10 applied"), 10, { kind: "number_equals" }), undefined);
  // A number that stands on its own is still the expected value.
  assert.ok(circular(page("$15.00"), 15, { kind: "number_equals" }));
  assert.ok(circular(page("15% off"), 15, { kind: "number_equals" }));
  assert.ok(circular(page("15 items"), 15, { kind: "number_equals" }));
  assert.ok(circular(page("Total: 1,500"), 1500, { kind: "number_equals" }));

  const run = {
    ticketKey: "T-1", pullRequest: { number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://localhost:1", deployedSha: "a".repeat(40) },
    context: { sources: [] }, analysis: { requirements: [], ambiguities: [], risks: [] }, analysisNotes: [], plan: { scenarios: [], notes: [], clarifications: [] },
    results: [], confirmations: {}, timings: [], startedAt: "2026-11-20T00:00:00Z", executionMode: "autonomous",
  } as unknown as RunReport;
  const body = render({ status: "completed", repo: "acme/tool", pr: 7, headSha: "a".repeat(40), run } as Parameters<typeof render>[0], "https://example.invalid/r").body.split("\n");
  const header = body.findIndex((line) => line.startsWith("| | Passed / verified"));
  const columns = (line: string) => line.split("|").length - 2;
  assert.equal(columns(body[header]!), 8);
  assert.equal(columns(body[header + 1]!), 8);
  assert.equal(columns(body[header + 2]!), 8);
  assert.equal(columns(body[header + 3]!), 8);
});
