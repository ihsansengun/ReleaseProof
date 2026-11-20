// The reliability gate of 20 November failed on three scenarios that were
// reported as failures of a correct application. Each time, a first attempt
// had ended without a verdict, the re-run on the escalation model recorded one
// mismatch through a wrong target or at the wrong moment, and that failure
// replaced the inconclusive result because it repeated when replayed. These
// tests rebuild the three cases. No model is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { escalatedRunSettles } from "../src/pipeline.ts";
import { buildDiagnostics, diagnosticLines } from "../src/report/diagnostics.ts";
import type { Assertion, RunReport, Scenario, ScenarioResult } from "../src/schema.ts";

const assertion = (id: string, requirementId: string, kind: Assertion["kind"] = "text_equals"): Assertion => ({ id, description: id, kind, expected: { literal: kind === "text_equals" ? "Cancelled" : 0 }, requirementId });
const result = (verdict: ScenarioResult["verdict"], reason: string, assertionResults: ScenarioResult["assertionResults"] = []): ScenarioResult => ({
  scenarioId: "S4", title: "Scenario S4", mode: "agent", verdict, reason, environment: { baseUrl: "http://localhost:1" },
  assertionResults, observations: {}, steps: [], evidence: { dir: "" }, startedAt: "2026-11-20T00:00:00Z", durationMs: 1,
});
const page = (value: string, pattern?: string) => ({ source: "page", by: "role", role: "cell", value, ...(pattern ? { pattern } : {}) });
const api = (jsonPath: string) => ({ source: "api", responseId: "R1", field: "body", jsonPath });
const mismatch = (assertionId: string, expected: number | string, actual: number | string, target: unknown) => ({ assertionId, expected, actual, pass: false, target });
const match = (assertionId: string, value: number | string, target: unknown) => ({ assertionId, expected: value, actual: value, pass: true, target });

test("an escalated failure through one wrong cell does not replace a blocked first attempt (time-off, status read from the Reason cell)", () => {
  const status = assertion("A4", "R6");
  // First attempt: every target naming the status cell was refused as circular; it ended blocked.
  const first = result("blocked", "Not checked: A4. The status cell could not be identified without naming its expected text.");
  // Escalated attempt: pointed at the neighbouring cell with a catch-all pattern and read "Trip".
  const second = result("failed", "A4: expected Cancelled, got Trip", [mismatch("A4", "Cancelled", "Trip", page("Trip", "(.*)"))]);

  // It repeats when replayed: the replay reads the same wrong cell again. That is not enough.
  assert.equal(escalatedRunSettles([status], first, second, "reproduced"), false);
  assert.equal(escalatedRunSettles([status], first, second, "replay diverged"), false);
});

test("nor does one that read the right place at the wrong moment replace an unverified first attempt (shop, subtotal after the quantity changed)", () => {
  const subtotal = assertion("A1", "R35", "number_equals");
  const others = [assertion("A3", "R6", "number_equals"), assertion("A4", "R6", "number_equals")];
  const first = result("unverified", "Not checked: A1. The value was recorded at quantity 6, and the page no longer shows it.", [match("A3", 60, page("Subtotal:")), match("A4", 15, page("Discount"))]);
  const second = result("failed", "A1: expected 72, got 60", [mismatch("A1", 72, 60, page("Subtotal:", "\\$([\\d.]+)")), match("A3", 60, page("Subtotal:")), match("A4", 15, page("Discount"))]);
  assert.equal(escalatedRunSettles([subtotal, ...others], first, second, "reproduced"), false);
  // Several single readings of unrelated requirements are still single readings.
  const scattered = result("failed", "r", [mismatch("A1", 72, 60, page("Subtotal:")), mismatch("A3", 60, 48, page("Total:"))]);
  assert.equal(escalatedRunSettles([subtotal, ...others], first, scattered, "reproduced"), false);
});

test("an escalated failure with evidence beyond one page reading still replaces the first result", () => {
  const status = assertion("A2", "R18");
  const code = assertion("A1", "R18", "number_equals");
  const balance = assertion("A3", "R18", "number_equals");
  const first = result("unverified", "Not checked: A1, A2, A3.");

  // The application's own response.
  const viaApi = result("failed", "A1: expected 403, got 200", [mismatch("A1", 403, 200, { source: "api", responseId: "R4", field: "status", jsonPath: "" })]);
  assert.equal(escalatedRunSettles([code, status, balance], first, viaApi, "reproduced"), true);
  // Two comparisons of the same requirement through different targets.
  const twoWays = result("failed", "r", [mismatch("A2", "Approved", "Cancelled", page("Cancelled")), mismatch("A3", 17, 20, page("Days remaining:"))]);
  assert.equal(escalatedRunSettles([code, status, balance], first, twoWays, "reproduced"), true);
  // The first attempt had failed the same assertion through another target: two attempts, two routes, one mismatch.
  const firstFailed = result("failed", "A2: expected Approved, got Cancelled", [mismatch("A2", "Approved", "Cancelled", page("Cancelled"))]);
  const again = result("failed", "A2: expected Approved, got Cancelled", [mismatch("A2", "Approved", "Cancelled", { source: "page", by: "testid", value: "status-3" })]);
  assert.equal(escalatedRunSettles([status], firstFailed, again, "reproduced"), true);
  // Through the same target it is the same reading twice.
  assert.equal(escalatedRunSettles([status], firstFailed, firstFailed, "reproduced"), false);

  // Evidence does not waive repetition: a failure that does not repeat settles nothing, as before.
  assert.equal(escalatedRunSettles([code, status, balance], first, viaApi, "replay diverged"), false);
  assert.equal(escalatedRunSettles([code, status, balance], first, viaApi, undefined), false);
});

test("an escalated pass replaces, and an escalated run without a verdict never does", () => {
  const status = assertion("A3", "R4");
  const first = result("failed", "A3: expected absent, got present", [mismatch("A3", "absent", "present", page("TAKE15"))]);
  // The gate's one good escalation: a single-reading failure, re-run, passed through another target.
  assert.equal(escalatedRunSettles([status], first, result("passed", "All 1 assertions matched.", [match("A3", "absent", page("applied"))]), undefined), true);
  assert.equal(escalatedRunSettles([status], first, result("unverified", "Not checked: A3."), undefined), false);
  assert.equal(escalatedRunSettles([status], first, result("blocked", "Not checked: A3. Stuck."), undefined), false);
});

test("the attempt that was not kept stays on record with its mismatch, for a person to judge", () => {
  const status = assertion("A4", "R6");
  const scenario: Scenario = { id: "S4", title: "Scenario S4", basis: "requirement", requirementIds: ["R6"], intent: "i", fixtures: {}, assertions: [status] };
  const first = result("blocked", "Not checked: A4. The status cell could not be identified.");
  const second = result("failed", "A4: expected Cancelled, got Trip", [mismatch("A4", "Cancelled", "Trip", page("Trip", "(.*)"))]);
  const run = {
    ticketKey: "T-1", pullRequest: { number: 7, headSha: "a".repeat(40), title: "t" }, environment: { baseUrl: "http://localhost:1" },
    context: { sources: [] }, analysis: { requirements: [], ambiguities: [], risks: [] }, analysisNotes: [],
    plan: { scenarios: [{ scenario, status: "runnable", riskIds: [], ambiguityIds: [], blockedReason: "" }], notes: [], clarifications: [] },
    results: [first], confirmations: {}, timings: [], startedAt: "2026-11-20T00:00:00Z",
    escalations: [{ scenarioId: "S4", why: "the executor could not get through it", before: "blocked", after: "failed", kept: "first run", other: second }],
  } as unknown as RunReport;
  const d = buildDiagnostics(run);
  assert.deepEqual(d.scenarios.map((s) => [s.verdict, s.attempt ?? "kept"]), [
    ["blocked", "kept"],
    ["failed", "escalated run, not kept (the executor could not get through it)"],
  ]);
  const log = diagnosticLines(d).join("\n");
  assert.match(log, /S4 blocked: Scenario S4/);
  assert.match(log, /S4 failed \[escalated run, not kept .*\]: Scenario S4\n.*why: A4: expected Cancelled, got Trip/);
  assert.match(log, /A4 mismatch.*expected Cancelled, observed Trip/);
});
