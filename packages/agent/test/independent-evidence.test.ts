// KAN-16: a value the executor itself supplied is not evidence about the
// application. Each attack here once produced "passed" against an application
// that shows 60; each legitimate workflow beside it must keep passing. A real
// browser, a stand-in application on this machine, and no model.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runScenario } from "../src/execute/run.ts";
import { Manifest, type Assertion, type Scenario, type ScenarioResult, type Step } from "../src/schema.ts";
import { notQuoted, validatePlan } from "../src/validate.ts";

const QUOTE = "After a first paid order of 60.00 the loyalty balance is 160.";

/**
 * An honest application. Its loyalty balance is 60, whatever anyone types.
 * It repeats search words and unknown addresses, as applications do, and it
 * keeps a nickname and a quantity that can be edited and saved.
 */
async function app(): Promise<{ baseUrl: string; server: Server; state: { nickname: string; quantity: number } }> {
  const state = { nickname: "Ada", quantity: 1 };
  const page = (body: string) => `<html><body>${body}</body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://app");
    const html = (body: string, status = 200) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end(page(body));
    };
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const body = () =>
      new Promise<string>((resolve) => {
        let text = "";
        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => resolve(text));
      });
    if (url.pathname === "/account") {
      return html(
        `<h1>Your account</h1><p>Loyalty balance <span data-testid="loyalty-balance">60</span></p>
         <form action="/search"><label>Search orders <input name="q"></label><button>Search</button></form>
         <label>Preview <input id="live" oninput="document.querySelector('[data-testid=mirror]').textContent = this.value"></label>
         <p>You typed: <span data-testid="mirror"></span></p>
         <button onclick="fetch('/noop', { method: 'POST' })">Save draft</button>`,
      );
    }
    if (url.pathname === "/search") return html(`<p>Results for <span data-testid="query">${url.searchParams.get("q") ?? ""}</span>: none.</p>`);
    if (url.pathname === "/noop") return json({ ok: true });
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/account", "content-type": "text/plain" });
      return response.end(`Found. Redirecting to ${url.searchParams.get("to") ?? ""}`);
    }
    if (url.pathname === "/profile" && request.method === "GET") {
      return html(
        `<h1>Profile</h1><p>Nickname shown: <span data-testid="nickname">${state.nickname}</span></p>
         <form method="post" action="/profile"><label>Nickname <input name="nickname" value="${state.nickname}"></label><button>Save</button></form>
         <form method="post" action="/forget"><label>Scratch <input name="scratch"></label><button>Discard</button></form>`,
      );
    }
    if (url.pathname === "/profile" && request.method === "POST") {
      return void body().then((text) => {
        state.nickname = new URLSearchParams(text).get("nickname") ?? state.nickname;
        response.writeHead(303, { location: "/profile" });
        response.end();
      });
    }
    // Takes a form and keeps nothing of it.
    if (url.pathname === "/forget") {
      return void body().then(() => {
        response.writeHead(303, { location: "/profile" });
        response.end();
      });
    }
    if (url.pathname === "/api/cart" && request.method === "GET") return json({ quantity: state.quantity, total: state.quantity * 20 });
    if (url.pathname === "/api/cart" && request.method === "PUT") {
      return void body().then((text) => {
        state.quantity = Number((JSON.parse(text) as { quantity: number }).quantity);
        json({ saved: true, youSent: state.quantity });
      });
    }
    if (url.pathname === "/api/echo" && request.method === "POST") return void body().then((text) => json({ received: JSON.parse(text) as unknown }));
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found", path: url.pathname }, 404);
    return html("<h1>Not found</h1>", 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, state };
}

const provenance = { sourceId: "criteria", trust: "authoritative" as const, origin: "criteria snapshot", quote: QUOTE };
const assertion = (over: Partial<Assertion> = {}): Assertion => ({
  id: "A1",
  description: "Loyalty balance after the first paid order",
  kind: "number_equals",
  unit: "plain",
  expected: { literal: 160 },
  requirementId: "R1",
  provenance,
  ...over,
});
const step = (tool: string, input: Record<string, unknown>): Step => ({ tool, input, ok: true, summary: "recorded" });
const FINISH = step("finish", { outcome: "completed", reason: "All assertions checked." });
const textbox = (value: string) => ({ by: "role", role: "textbox", value });
const button = (value: string) => ({ by: "role", role: "button", value });
const testid = (value: string) => ({ source: "page", by: "testid", value });

async function replay(steps: Step[], assertions: Assertion[] = [assertion()], more: Partial<Scenario> = {}): Promise<{ result: ScenarioResult; state: { nickname: string; quantity: number } }> {
  const { baseUrl, server, state } = await app();
  const scenario: Scenario = { id: "S1", title: "Independent evidence", basis: "requirement", requirementIds: ["R1"], intent: "Read values.", fixtures: {}, assertions, ...more };
  try {
    const result = await runScenario({
      scenario,
      manifest: Manifest.parse({ baseUrl }),
      outDir: mkdtempSync(path.join(tmpdir(), "rp-evidence-")),
      mode: { kind: "replay", steps },
    });
    return { result, state };
  } finally {
    server.close();
  }
}

const refused = (result: ScenarioResult, why: RegExp): void => {
  assert.notEqual(result.verdict, "passed", result.reason);
  assert.deepEqual(result.assertionResults, [], "no comparison was recorded");
  assert.match(result.reason, why);
};

// ---- 1. a typed value is not evidence ---------------------------------------------

test("attack: typing the expected value into a field and reading that field back is not a pass", async () => {
  const { result } = await replay([
    step("navigate", { path: "/account" }),
    step("fill", { element: textbox("Search orders"), text: "160" }),
    step("check", { assertionId: "A1", target: { source: "page", by: "label", value: "Search orders" } }),
    FINISH,
  ]);
  refused(result, /a field the executor itself filled/);
});

test("attack: a page that mirrors what is typed, with nothing saved, is not a pass", async () => {
  const { result } = await replay([
    step("navigate", { path: "/account" }),
    step("fill", { element: textbox("Preview"), text: "160" }),
    step("check", { assertionId: "A1", target: testid("mirror") }),
    FINISH,
  ]);
  refused(result, /the application has accepted no change since/);
});

test("attack: a mirror stays an echo after the application accepted an unrelated change", async () => {
  const { result } = await replay([
    step("navigate", { path: "/account" }),
    step("fill", { element: textbox("Preview"), text: "160" }),
    step("click", { element: button("Save draft") }),
    step("check", { assertionId: "A1", target: testid("mirror") }),
    FINISH,
  ]);
  refused(result, /no later answer of the application has contained it/);
});

test("attack: a form the application takes and forgets does not make the typed value its own", async () => {
  const { result } = await replay(
    [
      step("navigate", { path: "/profile" }),
      step("fill", { element: textbox("Scratch"), text: "Grace" }),
      step("click", { element: button("Discard") }),
      step("fill", { element: textbox("Scratch"), text: "Grace" }),
      step("check", { assertionId: "A1", target: { source: "page", by: "label", value: "Scratch" } }),
      FINISH,
    ],
    [assertion({ kind: "text_equals", expected: { literal: "Grace" }, unit: undefined })],
  );
  refused(result, /a field the executor itself filled|no later answer of the application/);
});

test("attack: an observation of the executor's own typing is not recorded, so no formula can use it", async () => {
  const { result } = await replay(
    [
      step("navigate", { path: "/account" }),
      step("fill", { element: textbox("Preview"), text: "160" }),
      step("observe", { name: "typed", target: testid("mirror") }),
      step("check", { assertionId: "A1", target: testid("loyalty-balance") }),
      FINISH,
    ],
    [assertion({ expected: { formula: "typed" } })],
    { observations: [{ name: "typed", what: "what was typed", when: "after typing", unit: "plain" }] },
  );
  assert.notEqual(result.verdict, "passed");
  assert.deepEqual(result.observations, {});
  assert.match(result.reason, /Observation "typed" was not recorded/);
});

// ---- 2. a value in an address or a request is not evidence ------------------------

test("attack: a search page that repeats the address it was asked for is not a pass", async () => {
  const { result } = await replay([step("navigate", { path: "/search?q=160" }), step("check", { assertionId: "A1", target: testid("query") }), FINISH]);
  refused(result, /wrote into an address/);
});

test("attack: searching for the expected value through the form is not a pass either", async () => {
  const { result } = await replay([
    step("navigate", { path: "/account" }),
    step("fill", { element: textbox("Search orders"), text: "160" }),
    step("click", { element: button("Search") }),
    step("check", { assertionId: "A1", target: testid("query") }),
    FINISH,
  ]);
  refused(result, /the application has accepted no change since/);
});

test("attack: an error answer that repeats the address requested is not a pass", async () => {
  const { result } = await replay([
    step("api_request", { method: "GET", path: "/api/160" }),
    step("check", { assertionId: "A1", target: { source: "api", responseId: "R1", jsonPath: "path", pattern: "(\\d+)" } }),
    FINISH,
  ]);
  assert.notEqual(result.verdict, "passed", JSON.stringify(result.steps));
  assert.deepEqual(result.assertionResults, []);
});

test("attack: a redirect answer that repeats its own parameter is not a pass", async () => {
  const { result } = await replay([
    step("api_request", { method: "GET", path: "/redirect?to=160" }),
    step("check", { assertionId: "A1", target: { source: "api", responseId: "R1", jsonPath: "" } }),
    FINISH,
  ]);
  assert.notEqual(result.verdict, "passed", JSON.stringify(result.steps));
  assert.deepEqual(result.assertionResults, []);
});

test("attack: an answer that repeats the body it was sent is not a pass", async () => {
  const { result } = await replay([
    step("api_request", { method: "POST", path: "/api/echo", body: { balance: 160 } }),
    step("check", { assertionId: "A1", target: { source: "api", responseId: "R1", jsonPath: "received.balance" } }),
    FINISH,
  ]);
  refused(result, /in the very request this response answers/);
});

// ---- 4. legitimate workflows keep working -------------------------------------------

test("legitimate: a value the application shows by itself passes or fails as before", async () => {
  const shown = await replay([step("navigate", { path: "/account" }), step("check", { assertionId: "A1", target: testid("loyalty-balance") }), FINISH], [assertion({ expected: { literal: 60 } })]);
  assert.equal(shown.result.verdict, "passed", shown.result.reason);
  assert.equal(shown.result.assertionResults[0]!.evidence?.entered, undefined);
  const wrong = await replay([step("navigate", { path: "/account" }), step("check", { assertionId: "A1", target: testid("loyalty-balance") }), FINISH]);
  assert.equal(wrong.result.verdict, "failed");
  assert.equal(wrong.result.assertionResults[0]!.actual, 60);
});

test("legitimate: edit, save, and read what the application shows afterwards passes, and the record says the value was entered", async () => {
  const { result, state } = await replay(
    [
      step("navigate", { path: "/profile" }),
      step("fill", { element: textbox("Nickname"), text: "Grace" }),
      step("click", { element: button("Save") }),
      step("check", { assertionId: "A1", target: testid("nickname") }),
      FINISH,
    ],
    [assertion({ kind: "text_equals", expected: { literal: "Grace" }, unit: undefined })],
  );
  assert.equal(state.nickname, "Grace");
  assert.equal(result.verdict, "passed", result.reason);
  const entered = result.assertionResults[0]!.evidence?.entered;
  assert.equal(entered?.how, "typed");
  assert.equal(entered?.confirmedBy, "GET /profile");
});

test("legitimate: after saving, the saved field itself may be read on the page opened again", async () => {
  const { result } = await replay(
    [
      step("navigate", { path: "/profile" }),
      step("fill", { element: textbox("Nickname"), text: "Grace" }),
      step("click", { element: button("Save") }),
      step("check", { assertionId: "A1", target: { source: "page", by: "label", value: "Nickname" } }),
      FINISH,
    ],
    [assertion({ kind: "text_equals", expected: { literal: "Grace" }, unit: undefined })],
  );
  assert.equal(result.verdict, "passed", result.reason);
});

test("legitimate: a change sent in a request is verified by a later read, not by the answer to the change", async () => {
  const cart = assertion({ expected: { literal: 3 } });
  const echo = await replay(
    [
      step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } }),
      step("check", { assertionId: "A1", target: { source: "api", responseId: "R1", jsonPath: "youSent" } }),
      FINISH,
    ],
    [cart],
  );
  refused(echo.result, /in the very request this response answers/);
  const read = await replay(
    [
      step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } }),
      step("api_request", { method: "GET", path: "/api/cart" }),
      step("check", { assertionId: "A1", target: { source: "api", responseId: "R2", jsonPath: "quantity" } }),
      FINISH,
    ],
    [cart],
  );
  assert.equal(read.result.verdict, "passed", read.result.reason);
});

test("legitimate: a value the application calculated from what was entered is not an echo", async () => {
  const { result } = await replay(
    [
      step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } }),
      step("api_request", { method: "GET", path: "/api/cart" }),
      step("check", { assertionId: "A1", target: { source: "api", responseId: "R2", jsonPath: "total" } }),
      FINISH,
    ],
    [assertion({ expected: { literal: 60 } })],
  );
  assert.equal(result.verdict, "passed", result.reason);
  assert.equal(result.assertionResults[0]!.evidence?.entered, undefined);
});

test("a mismatch is still recorded as a failure when the executor typed something", async () => {
  const { result } = await replay([
    step("navigate", { path: "/account" }),
    step("fill", { element: textbox("Preview"), text: "160" }),
    step("check", { assertionId: "A1", target: testid("loyalty-balance") }),
    FINISH,
  ]);
  assert.equal(result.verdict, "failed");
});

// ---- a value compared with itself ---------------------------------------------------

test("attack: an expected value calculated from the same place just read is a value compared with itself", async () => {
  const { result } = await replay(
    [
      step("navigate", { path: "/account" }),
      step("observe", { name: "b", target: testid("loyalty-balance") }),
      step("check", { assertionId: "A1", target: testid("loyalty-balance") }),
      FINISH,
    ],
    [assertion({ kind: "number_at_least", expected: { formula: "b * 1 + 0" } })],
    { observations: [{ name: "b", what: "balance", when: "on the account page", unit: "plain" }] },
  );
  refused(result, /compares a value with itself/);
});

// ---- 3. the expected value must be stated by the approved text -------------------

test("an expected value is quoted only if the approved text states it", () => {
  assert.equal(notQuoted({ literal: 160 }, QUOTE, "plain"), undefined);
  assert.equal(notQuoted({ literal: 60 }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ literal: 999 }, QUOTE, "plain") ?? "", /the number 999/);
  // 16 is part of 160, not a number the text states.
  assert.match(notQuoted({ literal: 16 }, QUOTE, "plain") ?? "", /the number 16/);
  assert.equal(notQuoted({ literal: 16000 }, QUOTE, "currency-hundredths"), undefined);
  assert.equal(notQuoted({ literal: "loyalty balance is 160" }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ literal: "Everything is free" }, QUOTE, "plain") ?? "", /the text/);
  assert.equal(notQuoted({ formula: "before + 60" }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ formula: "before + 75" }, QUOTE, "plain") ?? "", /a calculation with 75/);
});

test("with the quoted rule, a plan's own expectation is removed although it cites an approved requirement", () => {
  const analysis = {
    featureSummary: "",
    requirements: [{ id: "R1", text: QUOTE, kind: "documented" as const, quote: QUOTE, sourceId: "criteria", trust: "authoritative" as const, origin: "criteria snapshot" }],
    ambiguities: [],
    risks: [],
    conflicts: [],
  };
  const drafted = (expectedNumber: number) => ({
    scenarios: [
      {
        id: "S1",
        title: "Balance",
        basis: "requirement" as const,
        requirementIds: ["R1"],
        riskIds: [],
        intent: "Read the balance.",
        setup: "",
        fixtures: [],
        observations: [],
        status: "runnable" as const,
        blockedReason: "",
        ambiguityIds: [],
        assertions: [{ id: "A1", description: "Balance", kind: "number_equals" as const, expectedNumber, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId: "R1", alsoVerifies: [] }],
      },
    ],
  });
  const manifest = Manifest.parse({ baseUrl: "http://localhost:1" });
  const kept = (expectedNumber: number, quoted: boolean) =>
    validatePlan(drafted(expectedNumber) as never, analysis as never, manifest, 5, { declared: true, quoted }).plan.scenarios.flatMap((s) => s.scenario.assertions.map((a) => a.id));
  assert.deepEqual(kept(160, true), ["A1"]);
  assert.deepEqual(kept(60, true), ["A1"], "60 is stated too: which stated value belongs to which element is not decided here");
  assert.deepEqual(kept(999, true), []);
  // The pull-request path does not set the rule, and keeps what it kept before.
  assert.deepEqual(kept(999, false), ["A1"]);
});
