// In the independent evaluation of 20 November a scenario created a project
// with categories, saved a new task, and the application answered with an
// internal error, twice. That was the defect the build had been chosen for.
// The scenario was filed as "blocked", like one whose button could not be
// found. These tests rebuild that form and the cases that must stay as they
// were: a control that is not there, an expected refusal, an error that does
// not repeat, an error the test caused itself. No model is used.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "../src/ci/report.ts";
import { replaySteps } from "../src/execute/replay.ts";
import { closeSession, openSession } from "../src/execute/run.ts";
import { runTool } from "../src/execute/tools.ts";
import { erroredVerdict } from "../src/execute/verdict.ts";
import { needsEscalation } from "../src/pipeline.ts";
import { buildDiagnostics, diagnosticLines } from "../src/report/diagnostics.ts";
import { assess, headline } from "../src/report/readiness.ts";
import { Manifest, type Assertion, type RunReport, type Scenario, type ScenarioResult, type Step } from "../src/schema.ts";

type Run = (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const page = (body: string) => `<!doctype html><html><head><title>Board</title></head><body>${body}</body></html>`;
const FORM = (category: boolean, error = "") => page(`<h1>New task</h1>${error}
<form method="post" action="/tasks">
  <label>Password <input name="password" type="password"></label>
  <label>Title <input name="title"></label>
  ${category ? '<label>Category <select name="category"><option>Bug</option></select></label>' : ""}
  <button>Save</button>
</form>`);

/** A board whose form cannot be saved once the project has a category. */
function board(options: { category: boolean; status?: number; failures?: number }): { handler: Handler; saved: string[] } {
  const saved: string[] = [];
  let failures = options.failures ?? Infinity;
  const handler: Handler = (request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "POST" && request.url === "/tasks") {
      let body = "";
      request.on("data", (c) => (body += c));
      request.on("end", () => {
        if (options.category && failures-- > 0) {
          const text = "Internal Error: SQL Error[HY000]: SQLSTATE[HY000]: General error: 1 table tasks has no column named screenshot";
          response.statusCode = options.status ?? 500;
          // Some applications answer 500; others draw the error into a page and answer 200.
          response.end(options.status === 200 ? FORM(true, `<p class="alert">${text}</p>`) : text);
          return;
        }
        saved.push(body);
        response.end(page("<h1>Board</h1><p>Task created successfully.</p>"));
      });
      return;
    }
    if (request.url === "/forbidden") {
      response.statusCode = 403;
      response.end(page("<h1>Access Forbidden</h1>"));
      return;
    }
    if (request.url === "/api/broken") {
      response.statusCode = 500;
      response.end("boom");
      return;
    }
    response.end(FORM(options.category));
  };
  return { handler, saved };
}

const created: Assertion = { id: "A1", description: "the confirmation after saving", kind: "text_contains", expected: { literal: "Task created successfully." }, requirementId: "R19" };
const scenario: Scenario = { id: "S7", title: "Project with categories: chosen fields kept", basis: "requirement", requirementIds: ["R19"], intent: "i", fixtures: { admin: "administrator" }, assertions: [created] };
const accounts = { accounts: { administrator: { description: "the administrator", username: "admin", password: "correct-horse-battery" } } };

/** One attempt: a fresh application and browser, driven by `work` or by replaying recorded steps. */
async function attempt(app: { handler: Handler }, work: ((run: Run) => Promise<void>) | Step[]): Promise<ScenarioResult> {
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl, ...accounts }), outDir: mkdtempSync(path.join(tmpdir(), "rp-err-")) });
  try {
    await open.session.page.goto(baseUrl);
    if (Array.isArray(work)) await replaySteps(open.session, work);
    else await work((tool, input) => runTool(open.session, tool, { ...input, rationale: "r" }));
    open.session.outcome ??= { kind: "stopped", reason: "The executor stopped without calling finish." };
    return await closeSession(open, { mode: Array.isArray(work) ? "replay" : "agent" });
  } finally {
    server.close();
  }
}

const button = (value: string) => ({ by: "role", role: "button", value });
const label = (value: string) => ({ by: "label", value });
const save = async (run: Run, finish: Record<string, unknown>) => {
  await run("fill", { element: label("Password"), text: "{{secret:admin.password}}" });
  await run("fill", { element: label("Title"), text: "Cat with file" });
  const saved = await run("click", { element: button("Save") });
  await run("finish", finish);
  return saved;
};

test("an error the application answers a valid action with stops the scenario as an application error, not as blocked", async () => {
  let output = "";
  const first = await attempt(board({ category: true }), async (run) => {
    output = (await save(run, { outcome: "blocked", reason: "Saving the form fails with an internal error.", cause: "application-error" })).output;
  });
  // The executor is told at once, so it does not go looking for another button.
  assert.match(output, /^NOTE: the application answered POST \/tasks with HTTP 500: "Internal Error: SQL Error\[HY000\]: SQLSTATE\[HY000\]: General error: 1 table tasks has no column named screenshot"\. That is an error of the application, not of your step\./);

  // The first attempt alone decides nothing: it is blocked, with what the application said on record.
  assert.equal(first.verdict, "blocked");
  assert.equal(first.blockedCause, "application-error");
  assert.deepEqual(first.applicationErrors, [
    {
      step: 3,
      source: "response",
      actor: { alias: "admin", step: 1 },
      action: { step: 3, tool: "click", what: 'role button "Save"' },
      request: { method: "POST", path: "/tasks", status: 500 },
      text: "Internal Error: SQL Error[HY000]: SQLSTATE[HY000]: General error: 1 table tasks has no column named screenshot",
    },
  ]);
  // No secret reaches the record.
  assert.doesNotMatch(JSON.stringify(first), /correct-horse-battery/);

  // The same steps without a model meet the same error: now it is a finding.
  const replay = await attempt(board({ category: true }), first.steps);
  const settled = erroredVerdict(first, replay)!;
  assert.equal(settled.verdict, "errored");
  assert.match(settled.reason, /^Application error after click role button "Save" \(step 3\): POST \/tasks answered HTTP 500: "Internal Error: SQL Error.*"\. The same steps met it again without a model\. Not checked: A1\./);
  // A stronger model would meet the same error; it is not asked.
  assert.equal(needsEscalation({ ...first, ...settled }, "reproduced", [created]), undefined);
});

test("an error drawn into the page with status 200 counts when the executor points at it and code reads it", async () => {
  const alert = { source: "page", by: "role", role: "paragraph", value: "", count: false, read: "text", within: { by: "role", role: "main", value: "" } };
  const shown = { source: "page", by: "text", value: "Internal Error", count: false, read: "text" };
  let refusals: { ok: boolean; output: string }[] = [];
  const first = await attempt(board({ category: true, status: 200 }), async (run) => {
    await run("fill", { element: label("Title"), text: "Cat with file" });
    await run("click", { element: button("Save") });
    refusals = [
      // Saying so is not enough: there was no error answer, and nothing is pointed at.
      await run("finish", { outcome: "blocked", reason: "It failed.", cause: "application-error" }),
      // Pointing at something that is not there is not evidence either.
      await run("finish", { outcome: "blocked", reason: "It failed.", cause: "application-error", error: alert }),
    ];
    await run("finish", { outcome: "blocked", reason: "The form shows an internal error after Save.", cause: "application-error", error: shown });
  });
  assert.match(refusals[0]!.output, /No error answer of the application was recorded in this scenario/);
  assert.equal(refusals[1]!.ok, false);
  assert.equal(first.verdict, "blocked");
  assert.equal(first.applicationErrors!.length, 1);
  const error = first.applicationErrors![0]!;
  assert.deepEqual([error.source, error.page, error.locatedBy, error.action?.what], ["page", "/tasks", 'text "Internal Error"', 'role button "Save"']);
  assert.match(error.text, /^Internal Error: SQL Error\[HY000\]/);

  const replay = await attempt(board({ category: true, status: 200 }), first.steps);
  assert.equal(erroredVerdict(first, replay)!.verdict, "errored");
});

test("an error that does not repeat, or that did not stop the scenario, changes no verdict", async () => {
  // Seen once: the second time the form saves.
  const once = await attempt(board({ category: true, failures: 1 }), async (run) => {
    await save(run, { outcome: "blocked", reason: "Internal error on save.", cause: "application-error" });
  });
  assert.equal(once.applicationErrors!.length, 1);
  const replayed = await attempt(board({ category: true, failures: 0 }), once.steps);
  assert.equal(erroredVerdict(once, replayed), undefined);
  assert.equal(once.verdict, "blocked");

  // An error on the way, after which the comparisons were still made: the mismatch or the pass stands.
  const passed = { verdict: "passed" as const, reason: "All 1 assertions matched.", applicationErrors: once.applicationErrors };
  const failed = { verdict: "failed" as const, reason: "A1: expected x, got y", applicationErrors: once.applicationErrors };
  assert.equal(erroredVerdict(passed, once), undefined);
  assert.equal(erroredVerdict(failed, once), undefined);
});

test("what is not the application's error stays what it was", async () => {
  const outputs: Record<string, { ok: boolean; output: string }> = {};
  const result = await attempt(board({ category: false }), async (run) => {
    // A refusal the scenario may be about is an answer, not an error.
    outputs.forbidden = await run("navigate", { path: "/forbidden" });
    // An error to a request the executor wrote itself may be the test's own doing. It is on record as that response.
    outputs.own = await run("api_request", { method: "GET", path: "/api/broken" });
    await run("navigate", { path: "/" });
    // A control that is not there is a gap of the test.
    outputs.missing = await run("click", { element: button("Publish") });
    outputs.claim = await run("finish", { outcome: "blocked", reason: "x", cause: "application-error" });
    await run("finish", { outcome: "blocked", reason: "There is no Publish button.", cause: "cannot-operate" });
  });
  assert.doesNotMatch(outputs.forbidden!.output, /NOTE: the application answered/);
  assert.match(outputs.own!.output, /"status":500/);
  assert.doesNotMatch(outputs.own!.output, /NOTE: the application answered/);
  assert.equal(outputs.missing!.ok, false);
  assert.equal(outputs.claim!.ok, false);
  assert.equal(result.applicationErrors, undefined);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.blockedCause, "cannot-operate");
  assert.equal(erroredVerdict(result, result), undefined);
  // It is still offered to the stronger model, as before.
  assert.equal(needsEscalation(result, undefined, [created]), "the executor could not get through it");

  // A run that ends on a limit is unverified, with or without this change.
  const limit = await attempt(board({ category: false }), async (run) => {
    await run("fill", { element: label("Title"), text: "x" });
  });
  assert.equal(limit.verdict, "unverified");
  assert.equal(erroredVerdict(limit, limit), undefined);
});

test("the report says the application stopped the scenario, and the requirement is not left as merely unverified", async () => {
  const first = await attempt(board({ category: true }), async (run) => {
    await save(run, { outcome: "blocked", reason: "Saving the form fails with an internal error.", cause: "application-error" });
  });
  const replay = await attempt(board({ category: true }), first.steps);
  const result = { ...first, ...erroredVerdict(first, replay)! };
  const run = {
    ticketKey: "T-1", driver: "test", executionMode: "autonomous", pullRequest: { number: 3, headSha: "a".repeat(40), title: "t" },
    environment: { baseUrl: "http://localhost:1", deployedSha: "a".repeat(40) }, context: { sources: [] },
    analysis: { requirements: [{ id: "R19", text: "A task keeps its category", kind: "documented", quote: "keeps the category", origin: "ticket" }], ambiguities: [], risks: [] },
    analysisNotes: [],
    plan: { scenarios: [{ scenario, status: "runnable", riskIds: [], ambiguityIds: [], blockedReason: "" }], notes: [], clarifications: [] },
    results: [result], confirmations: { S7: "reproduced" }, timings: [], startedAt: "2026-11-20T00:00:00Z",
  } as unknown as RunReport;

  const a = assess(run);
  assert.equal(a.readiness, "not ready");
  assert.deepEqual([a.execution.errored, a.execution.blocked, a.execution.failed], [1, 0, 0]);
  assert.equal(a.requirements[0]!.status, "errored");
  assert.equal(headline(a), "Not ready: 0 failed, 0 passed · 1 stopped by an application error · 0 of 1 requirements verified");
  assert.ok(a.reasons.includes("1 scenario was stopped by an error of the application that repeats"));

  const body = render({ status: "completed", repo: "acme/tool", pr: 3, headSha: "a".repeat(40), run } as Parameters<typeof render>[0], "https://example.invalid/r");
  assert.equal(body.conclusion, "failure");
  assert.match(body.body, /### Application errors/);
  assert.match(body.body, /\| S7 Project with categories: chosen fields kept \| \*\*application error, repeats\*\* \| admin \| step 3: click role button "Save" \| POST \/tasks → HTTP 500: Internal Error: SQL Error/);
  assert.doesNotMatch(body.body, /### Not verified/);

  const log = diagnosticLines(buildDiagnostics(run)).join("\n");
  assert.match(log, /S7 errored: Project with categories/);
  assert.match(log, /application error at step 3, signed in as admin, after click role button "Save": POST \/tasks answered HTTP 500: Internal Error: SQL Error/);
});
