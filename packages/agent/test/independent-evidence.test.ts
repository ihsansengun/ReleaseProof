// KAN-16: what the executor itself puts into the application is not evidence
// about the application. Each attack here once produced "passed" against an
// application that shows 60. A real browser, a stand-in application on this
// machine, and no model.
//
// Two rules are tested. In every run, a field the executor filled is not read
// back. In a run whose plan is not the engine's own (`untrustedPlan`, which a
// remote run sets), a value is read only from a page or an answer as the
// application served it. The pull-request path keeps its read-only flows.
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
  const safe = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://app");
    const html = (body: string, status = 200) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end(`<html><body>${body}</body></html>`);
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
         <label>Preview <input oninput="document.querySelector('[data-testid=mirror]').textContent = this.value"></label>
         <p>You typed: <span data-testid="mirror"></span></p>
         <label>Points to redeem <input type="number" value="0"></label>
         <label>Receipt <input type="file" onchange="document.querySelector('[data-testid=file]').textContent = this.files[0].name"></label>
         <p>Selected file: <span data-testid="file"></span></p>
         <button onclick="document.querySelector('[data-testid=details]').textContent = 'Tier: 60 points'">Show details</button>
         <p data-testid="details"></p>
         <button onclick="fetch('/noop', { method: 'POST' })">Save draft</button>`,
      );
    }
    if (url.pathname === "/search") return html(`<p>Results for <span data-testid="query">${safe(url.searchParams.get("q") ?? "")}</span>: none.</p>`);
    if (url.pathname === "/customers") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const found = ["Ada Lovelace", "Grace Hopper"].filter((name) => name.toLowerCase().includes(q));
      return html(`<h1>Customers</h1><ul>${found.map((name) => `<li data-testid="customer">${name}</li>`).join("")}</ul>`);
    }
    if (url.pathname === "/noop") return json({ ok: true });
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/account", "content-type": "text/plain" });
      return response.end(`Found. Redirecting to ${url.searchParams.get("to") ?? ""}`);
    }
    if (url.pathname === "/profile" && request.method === "GET") {
      return html(
        `<h1>Profile</h1><p>Nickname shown: <span data-testid="nickname">${safe(state.nickname)}</span></p>
         <form method="post" action="/profile"><label>Nickname <input name="nickname" value="${safe(state.nickname)}"></label><button>Save</button></form>
         <form method="post" action="/said"><label>Scratch <input name="scratch"></label><button>Send</button></form>`,
      );
    }
    if (url.pathname === "/profile" && request.method === "POST") {
      return void body().then((text) => {
        state.nickname = new URLSearchParams(text).get("nickname") ?? state.nickname;
        response.writeHead(303, { location: "/profile" });
        response.end();
      });
    }
    // Answers a form with a page that repeats it, and keeps nothing.
    if (url.pathname === "/said") return void body().then((text) => html(`<p>You sent <span data-testid="said">${safe(new URLSearchParams(text).get("scratch") ?? "")}</span>.</p>`));
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
const text = (literal: string, kind: "text_equals" | "text_contains" = "text_equals") => assertion({ kind, expected: { literal }, unit: undefined });
const step = (tool: string, input: Record<string, unknown>): Step => ({ tool, input, ok: true, summary: "recorded" });
const FINISH = step("finish", { outcome: "completed", reason: "All assertions checked." });
const textbox = (value: string) => ({ by: "role", role: "textbox", value });
const button = (value: string) => ({ by: "role", role: "button", value });
const testid = (value: string, more: Record<string, unknown> = {}) => ({ source: "page", by: "testid", value, ...more });
const label = (value: string) => ({ source: "page", by: "label", value });
const check = (target: Record<string, unknown>) => step("check", { assertionId: "A1", target });
const open = (p: string) => step("navigate", { path: p });
const balance = { name: "b", what: "balance", when: "on the account page", unit: "plain" as const };

type Mode = "untrusted" | "own";
async function replay(mode: Mode, steps: Step[], assertions: Assertion[] = [assertion()], more: Partial<Scenario> = {}): Promise<{ result: ScenarioResult; state: { nickname: string; quantity: number } }> {
  const { baseUrl, server, state } = await app();
  const scenario: Scenario = { id: "S1", title: "Independent evidence", basis: "requirement", requirementIds: ["R1"], intent: "Read values.", fixtures: {}, assertions, ...more };
  try {
    const result = await runScenario({
      scenario,
      manifest: Manifest.parse({ baseUrl }),
      outDir: mkdtempSync(path.join(tmpdir(), "rp-evidence-")),
      mode: { kind: "replay", steps },
      ...(mode === "untrusted" ? { untrustedPlan: true } : {}),
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

// ---- every run: a field the executor filled is not read back -------------------------

for (const typed of ["160", "x160", "160px", "_160"]) {
  test(`every run: typing ${JSON.stringify(typed)} into a field and reading that field back is not a pass`, async () => {
    for (const mode of ["own", "untrusted"] as const) {
      const { result } = await replay(mode, [open("/account"), step("fill", { element: textbox("Search orders"), text: typed }), check({ ...label("Search orders"), ...(typed === "160" ? {} : { pattern: "(\\d+)" }) }), FINISH]);
      refused(result, /a field the executor itself put a value into/);
    }
  });
}

test("every run: a number field moved with a key is the executor's own input too", async () => {
  for (const mode of ["own", "untrusted"] as const) {
    const spin = { by: "role", role: "spinbutton", value: "Points to redeem" };
    const { result } = await replay(mode, [open("/account"), step("press", { element: spin, key: "ArrowUp" }), check(label("Points to redeem")), FINISH], [assertion({ expected: { literal: 1 } })]);
    refused(result, /a field the executor itself put a value into/);
  }
});

test("every run: a file field holds the name of the file the executor gave it", async () => {
  for (const mode of ["own", "untrusted"] as const) {
    const { result } = await replay(mode, [open("/account"), step("upload", { element: { by: "label", value: "Receipt" }, files: [{ name: "160.txt", kind: "text" }] }), check({ ...label("Receipt"), pattern: "(\\d+)" }), FINISH]);
    assert.notEqual(result.verdict, "passed", JSON.stringify(result.steps));
    assert.deepEqual(result.assertionResults, []);
  }
});

test("every run: a mismatch is recorded as a failure, whatever the executor typed", async () => {
  for (const mode of ["own", "untrusted"] as const) {
    const { result } = await replay(mode, [open("/account"), step("fill", { element: textbox("Preview"), text: "160" }), check(testid("loyalty-balance")), FINISH]);
    assert.equal(result.verdict, "failed", mode);
    assert.equal(result.assertionResults[0]!.actual, 60);
  }
});

// ---- untrusted plan: a value is read only from a page as the application served it ---

const attack = (title: string, steps: Step[], why: RegExp, assertions?: Assertion[], more?: Partial<Scenario>) =>
  test(`attack: ${title}`, async () => {
    const { result } = await replay("untrusted", steps, assertions, more);
    refused(result, why);
  });

attack("a page that mirrors what is typed", [open("/account"), step("fill", { element: textbox("Preview"), text: "160" }), check(testid("mirror")), FINISH], /the executor has acted in this page/);
attack("a mirror of a value typed with a letter in front, read through a pattern", [open("/account"), step("fill", { element: textbox("Preview"), text: "x160" }), check(testid("mirror", { pattern: "(\\d+)" })), FINISH], /the executor has acted in this page/);
attack("a mirror of a longer number, cut down by a pattern", [open("/account"), step("fill", { element: textbox("Preview"), text: "9160" }), check(testid("mirror", { pattern: "9(\\d+)" })), FINISH], /the executor has acted in this page/);
attack(
  "a mirror, after the application accepted an unrelated change",
  [open("/account"), step("fill", { element: textbox("Preview"), text: "160" }), step("click", { element: button("Save draft") }), check(testid("mirror")), FINISH],
  /the executor has acted in this page/,
);
attack(
  "the name of an uploaded file, shown back by the page",
  [open("/account"), step("upload", { element: { by: "label", value: "Receipt" }, files: [{ name: "160.txt", kind: "text" }] }), check(testid("file", { pattern: "(\\d+)" })), FINISH],
  /the executor has acted in this page/,
);
attack("a search page that repeats the address it was asked for", [open("/search?q=160"), check(testid("query")), FINISH], /an address with a query or a fragment/);
attack("the same with a letter in front and a pattern", [open("/search?q=x160"), check(testid("query", { pattern: "(\\d+)" })), FINISH], /an address with a query or a fragment/);
attack(
  "searching for the value through the application's own form",
  [open("/account"), step("fill", { element: textbox("Search orders"), text: "x160" }), step("click", { element: button("Search") }), check(testid("query", { pattern: "(\\d+)" })), FINISH],
  /holds something the executor itself entered/,
);
attack(
  "a form answered with a page that repeats it",
  [open("/profile"), step("fill", { element: textbox("Scratch"), text: "160" }), step("click", { element: button("Send") }), check(testid("said")), FINISH],
  /answer to a POST request/,
);
attack("an error answer that repeats the address requested", [step("api_request", { method: "GET", path: "/api/x160" }), check({ source: "api", responseId: "R1", jsonPath: "path", pattern: "(\\d+)" }), FINISH], /status 404/);
attack("a redirect answer that repeats its own parameter", [step("api_request", { method: "GET", path: "/redirect?to=160" }), check({ source: "api", responseId: "R1", jsonPath: "" }), FINISH], /status 302/);
attack("an answer that repeats the body it was sent", [step("api_request", { method: "POST", path: "/api/echo", body: { balance: "x160" } }), check({ source: "api", responseId: "R1", jsonPath: "received.balance", pattern: "(\\d+)" }), FINISH], /answer to a POST request/);
attack(
  "the length of a list the executor sent",
  [step("api_request", { method: "POST", path: "/api/echo", body: { items: Array.from({ length: 160 }, () => null) } }), check({ source: "api", responseId: "R1", jsonPath: "received.items", count: true }), FINISH],
  /answer to a POST request/,
);
attack(
  "an observation of the executor's own typing, used as the expected value",
  [open("/account"), step("fill", { element: textbox("Preview"), text: "60" }), step("observe", { name: "b", target: testid("mirror") }), check(testid("loyalty-balance")), FINISH],
  /Observation "b" was not recorded/,
  [assertion({ expected: { formula: "b" } })],
  { observations: [balance] },
);

// ---- a value compared with itself -----------------------------------------------------

attack(
  "an expected value calculated from the same place, pointed at another way",
  [open("/account"), step("observe", { name: "b", target: testid("loyalty-balance") }), check({ source: "page", by: "text", value: "60", pattern: "(\\d+)", within: undefined }), FINISH],
  /compares a value with itself|located by the expected value/,
  [assertion({ kind: "number_at_least", expected: { formula: "b" } })],
  { observations: [balance] },
);
attack(
  "the same with a pattern on the comparison only",
  [open("/account"), step("observe", { name: "b", target: testid("loyalty-balance") }), check(testid("loyalty-balance", { pattern: "(\\d+)" })), FINISH],
  /compares a value with itself/,
  [assertion({ kind: "number_at_least", expected: { formula: "b * 1 + 0" } })],
  { observations: [balance] },
);
attack(
  "the same after opening the page again, with nothing changed",
  [open("/account"), step("observe", { name: "b", target: testid("loyalty-balance") }), open("/account"), check(testid("loyalty-balance")), FINISH],
  /compares a value with itself/,
  [assertion({ expected: { formula: "b" } })],
  { observations: [balance] },
);
attack(
  "two requests for the same value, compared with each other",
  [step("api_request", { method: "GET", path: "/api/cart" }), step("observe", { name: "b", target: { source: "api", responseId: "R1", jsonPath: "total" } }), step("api_request", { method: "GET", path: "/api/cart" }), check({ source: "api", responseId: "R2", jsonPath: "total" }), FINISH],
  /compares a value with itself/,
  [assertion({ expected: { formula: "b" } })],
  { observations: [balance] },
);

test("a run whose plan is the engine's own may compare a value before and after an action", async () => {
  const { result } = await replay(
    "own",
    [open("/account"), step("observe", { name: "b", target: testid("loyalty-balance") }), step("click", { element: button("Save draft") }), check(testid("loyalty-balance")), FINISH],
    [assertion({ expected: { formula: "b" } })],
    { observations: [balance] },
  );
  assert.equal(result.verdict, "passed", result.reason);
});

// ---- legitimate workflows, untrusted plan --------------------------------------------

test("legitimate: a value the application shows by itself passes, and a wrong one fails", async () => {
  const shown = await replay("untrusted", [open("/account"), check(testid("loyalty-balance")), FINISH], [assertion({ expected: { literal: 60 } })]);
  assert.equal(shown.result.verdict, "passed", shown.result.reason);
  const wrong = await replay("untrusted", [open("/account"), check(testid("loyalty-balance")), FINISH]);
  assert.equal(wrong.result.verdict, "failed");
});

test("legitimate: edit, save, and read what the application shows afterwards", async () => {
  const save = [open("/profile"), step("fill", { element: textbox("Nickname"), text: "Grace" }), step("click", { element: button("Save") })];
  const shown = await replay("untrusted", [...save, check(testid("nickname")), FINISH], [text("Grace")]);
  assert.equal(shown.state.nickname, "Grace");
  assert.equal(shown.result.verdict, "passed", shown.result.reason);
  // The saved field itself, in the page the application served after saving.
  const field = await replay("untrusted", [...save, check(label("Nickname")), FINISH], [text("Grace")]);
  assert.equal(field.result.verdict, "passed", field.result.reason);
});

test("legitimate: a change sent in a request is verified by reading it back, not by the answer to the change", async () => {
  const put = step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } });
  const echo = await replay("untrusted", [put, check({ source: "api", responseId: "R1", jsonPath: "youSent" }), FINISH], [assertion({ expected: { literal: 3 } })]);
  refused(echo.result, /answer to a PUT request/);
  const read = await replay("untrusted", [put, step("api_request", { method: "GET", path: "/api/cart" }), check({ source: "api", responseId: "R2", jsonPath: "total" }), FINISH], [assertion({ expected: { literal: 60 } })]);
  assert.equal(read.result.verdict, "passed", read.result.reason);
});

test("legitimate: how the application answered a request may be read, whatever was sent", async () => {
  const { result } = await replay("untrusted", [step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } }), check({ source: "api", responseId: "R1", field: "status" }), FINISH], [assertion({ expected: { literal: 200 } })]);
  assert.equal(result.verdict, "passed", result.reason);
});

test("a view the page builds only after a click is read after opening the page again, or not at all", async () => {
  const clicked = await replay("untrusted", [open("/account"), step("click", { element: button("Show details") }), check(testid("details", { pattern: "(\\d+)" })), FINISH], [assertion({ expected: { literal: 60 } })]);
  refused(clicked.result, /the executor has acted in this page/);
});

// ---- the pull-request path keeps its read-only flows -------------------------------

test("own plan: searching through a form and checking what was found still passes", async () => {
  const { result } = await replay("own", [open("/customers"), open("/customers?q=Ada"), check(testid("customer")), FINISH], [text("Ada Lovelace")]);
  assert.equal(result.verdict, "passed", result.reason);
});

test("own plan: a value the application shows passes although the same value was typed somewhere else", async () => {
  const { result } = await replay("own", [open("/account"), step("fill", { element: textbox("Preview"), text: "60" }), check(testid("loyalty-balance")), FINISH], [assertion({ expected: { literal: 60 } })]);
  assert.equal(result.verdict, "passed", result.reason);
});

test("own plan: a view built after a click, and the answer to a change, may be read", async () => {
  const view = await replay("own", [open("/account"), step("click", { element: button("Show details") }), check(testid("details", { pattern: "(\\d+)" })), FINISH], [assertion({ expected: { literal: 60 } })]);
  assert.equal(view.result.verdict, "passed", view.result.reason);
  const answer = await replay("own", [step("api_request", { method: "PUT", path: "/api/cart", body: { quantity: 3 } }), check({ source: "api", responseId: "R1", jsonPath: "youSent" }), FINISH], [assertion({ expected: { literal: 3 } })]);
  assert.equal(answer.result.verdict, "passed", answer.result.reason);
});

test("own plan: a field whose value the application changed after typing shows the application's answer", async () => {
  // The saved field in the page served after saving is not the field that was typed into.
  const { result } = await replay("own", [open("/profile"), step("fill", { element: textbox("Nickname"), text: "Grace" }), step("click", { element: button("Save") }), check(label("Nickname")), FINISH], [text("Grace")]);
  assert.equal(result.verdict, "passed", result.reason);
});

// ---- the expected value must be stated by the approved text ------------------------

test("an expected value is quoted only if the approved text states it", () => {
  assert.equal(notQuoted({ literal: 160 }, QUOTE, "plain"), undefined);
  assert.equal(notQuoted({ literal: 60 }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ literal: 999 }, QUOTE, "plain") ?? "", /the number 999/);
  // Part of a number, or a number with a unit stuck to it, is not a number the text states.
  assert.match(notQuoted({ literal: 16 }, QUOTE, "plain") ?? "", /the number 16/);
  assert.match(notQuoted({ literal: 16 }, "a width of 160px", "plain") ?? "", /the number 16/);
  assert.match(notQuoted({ literal: 160 }, "after 1600ms", "plain") ?? "", /the number 160/);
  assert.match(notQuoted({ literal: 123 }, "items 1,2,3", "plain") ?? "", /the number 123/);
  assert.equal(notQuoted({ literal: 1600 }, "a total of 1,600.00", "plain"), undefined);
  // Hundredths of an amount written with a decimal point, and of nothing else.
  assert.equal(notQuoted({ literal: 6000 }, QUOTE, "currency-hundredths"), undefined);
  assert.match(notQuoted({ literal: 300 }, "At most 3 attempts", "currency-hundredths") ?? "", /the number 300/);
  assert.equal(notQuoted({ literal: "loyalty balance is 160" }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ literal: "Everything is free" }, QUOTE, "plain") ?? "", /the text/);
  assert.match(notQuoted({ literal: "active" }, "the account is inactive", "plain") ?? "", /the text/);
  assert.match(notQuoted({ literal: "is" }, QUOTE, "plain") ?? "", /the text/);
  assert.equal(notQuoted({ formula: "before + 60" }, QUOTE, "plain"), undefined);
  assert.match(notQuoted({ formula: "before + 75" }, QUOTE, "plain") ?? "", /a calculation with 75/);
  assert.match(notQuoted({ formula: "160 - 60 - 60 / 60" }, QUOTE, "plain") ?? "", /uses no recorded value/);
});

test("with the quoted rule, a plan's own expectation and its own kind of comparison are removed", () => {
  const analysis = {
    featureSummary: "",
    requirements: [{ id: "R1", text: QUOTE, kind: "documented" as const, quote: QUOTE, sourceId: "criteria", trust: "authoritative" as const, origin: "criteria snapshot" }],
    ambiguities: [],
    risks: [],
    conflicts: [],
  };
  const drafted = (kind: string, expectedNumber: number | null) => ({
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
        assertions: [{ id: "A1", description: "Balance", kind, expectedNumber, expectedText: null, expectedFormula: null, unit: "plain" as const, requirementId: "R1", alsoVerifies: [] }],
      },
    ],
  });
  const manifest = Manifest.parse({ baseUrl: "http://localhost:1" });
  const kept = (kind: string, expectedNumber: number | null, quoted: boolean) =>
    validatePlan(drafted(kind, expectedNumber) as never, analysis as never, manifest, 5, { declared: true, quoted }).plan.scenarios.flatMap((s) => s.scenario.assertions.map((a) => a.id));
  assert.deepEqual(kept("number_equals", 160, true), ["A1"]);
  assert.deepEqual(kept("number_equals", 999, true), []);
  // "The balance is 160" is not "the balance is at most 160", which 60 would satisfy.
  assert.deepEqual(kept("number_at_most", 160, true), []);
  // Nor does it say that anything is absent.
  assert.deepEqual(kept("absent", null, true), []);
  // The pull-request path does not set the rule, and keeps what it kept before.
  assert.deepEqual(kept("number_equals", 999, false), ["A1"]);
  assert.deepEqual(kept("number_at_most", 160, false), ["A1"]);
});
