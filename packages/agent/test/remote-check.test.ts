// RPAI-33 stage 4: the engine carries out an approved check itself. A real
// browser, a stand-in application on this machine, no model. The negative
// suite of docs/design/TRUSTED-BINDING.md is here beside the code: every case
// in it must end refused or unverified, and none verified or failed.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { Binding } from "../src/remote/binding.ts";
import { carryOutCheck, checkProblems, expectedInUnit, fixtureKey, readStrictNumber, UNVERIFIED_REASONS, type CheckRecord } from "../src/remote/check.ts";

// ---- a stand-in application ----------------------------------------------------

type Ledger = { balance: number; count: number; requests: string[]; bodies: string[]; calls: number };
type Answer = { status?: number; headers?: Record<string, string>; body?: string } | "hang";
type Route = (ledger: Ledger, body: string) => Answer | Promise<Answer>;
type Routes = Record<string, Route>;

const html = (body: string): Answer => ({ headers: { "content-type": "text/html" }, body: `<html><body style="margin:0">${body}</body></html>` });
const json = (value: unknown, status = 200): Answer => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const account = (ledger: Ledger, extra = "") => html(`<p data-testid="balance">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>${extra}`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An account with a balance, a page to buy on, and a purchase that adds 100 to the balance. */
const BASE: Routes = {
  "GET /account": (ledger) => account(ledger),
  "GET /buy": () => html(`<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`),
  "POST /purchase": (ledger) => {
    ledger.balance += 100;
    ledger.count += 1;
    return json({ ok: true });
  },
};

async function app(routes: Routes = {}): Promise<{ baseUrl: string; server: Server; ledger: Ledger }> {
  const ledger: Ledger = { balance: 0, count: 0, requests: [], bodies: [], calls: 0 };
  const table = { ...BASE, ...routes };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const key = `${request.method} ${(request.url ?? "/").split("?")[0]}`;
        ledger.requests.push(`${request.method} ${request.url}`);
        const route = table[key];
        const answer = route ? await route(ledger, Buffer.concat(chunks).toString("utf8")) : ({ status: 404, body: "Not found" } satisfies Answer);
        if (answer === "hang") return;
        response.writeHead(answer.status ?? 200, answer.headers ?? { "content-type": "text/plain" });
        response.end(answer.body ?? "");
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, ledger };
}

// ---- bindings ------------------------------------------------------------------

const testid = (value: string) => ({ by: "testid" as const, value });
const button = (name: string) => ({ by: "role" as const, role: "button", name });
const reading = (pathname: string, id: string, unit: "plain" | "currency-units" | "currency-hundredths" = "plain", valueKind: "number" | "amount" = "number") => ({ path: pathname, locator: testid(id), valueKind, unit });
const see = (id: string, value: string, pathname = "/account") => ({ kind: "see" as const, reading: reading(pathname, id), expected: { from: "literal" as const, value } });
const BUY = [{ kind: "open" as const, path: "/buy" }, { kind: "act" as const, path: "/buy", locator: button("Buy"), expects: { write: "one" as const, method: "POST" as const, path: "/purchase" } }];

type Draft = Omit<Binding, "steps"> & { steps: unknown[] };
/** "After a purchase the balance is 100": the starting state, the balance before, the purchase, its witness, the balance after. */
function binding(change: Partial<Draft> = {}): Binding {
  const draft: Draft = {
    formatVersion: 1,
    id: "balance-after-purchase",
    snapshotId: "criteria-1",
    snapshotSha256: "a".repeat(64),
    quote: { start: 0, end: 40 },
    locale: "en-GB",
    timezone: "Europe/London",
    background: [],
    tolerated: [],
    settling: { within: 1, readings: 3 },
    setup: { kind: "fresh-browser" },
    steps: [see("count", "0"), see("balance", "0"), ...BUY, see("count", "1")],
    observation: reading("/account", "balance"),
    expected: { start: 0, end: 3, value: "100" },
    ...change,
  };
  return Binding.parse(draft);
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

let runs = 0;
async function check(routes: Routes, bound: Binding = binding(), options: { limitMs?: number; runId?: string } = {}): Promise<{ record: CheckRecord; ledger: Ledger; baseUrl: string }> {
  const { baseUrl, server, ledger } = await app(routes);
  try {
    const record = await carryOutCheck({ browser, baseUrl, runId: options.runId ?? `00000000-0000-4000-8000-${String(++runs).padStart(12, "0")}`, binding: bound, ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs }) });
    return { record, ledger, baseUrl };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** The whole point of the negative suite: such a check says nothing, in either direction. */
function unverified(record: CheckRecord, reason: (typeof UNVERIFIED_REASONS)[number]): void {
  assert.equal(record.outcome, "unverified", `ended ${record.outcome}${record.reason ? ` (${record.reason})` : ""}`);
  assert.equal(record.reason, reason);
}

// ---- numbers -------------------------------------------------------------------

test("a number is read by one strict grammar, and any other spelling is not a number", () => {
  assert.equal(readStrictNumber("100", "number", "plain"), "100");
  assert.equal(readStrictNumber("1,240", "number", "plain"), "1240");
  assert.equal(readStrictNumber("-12", "number", "plain"), "-12");
  assert.equal(readStrictNumber("24.99", "number", "currency-units"), "24.99");
  assert.equal(readStrictNumber("$1,024.99", "amount", "currency-units"), "1024.99");
  assert.equal(readStrictNumber("24.99 EUR", "amount", "currency-units"), "24.99");
  assert.equal(readStrictNumber("-\u00a35.00", "amount", "currency-units"), "-5.00");
  assert.equal(readStrictNumber("2499", "amount", "currency-hundredths"), "2499");
  for (const [text, kind, unit] of [
    ["1,24", "number", "plain"],
    ["24,99", "amount", "currency-units"],
    ["2499", "amount", "currency-units"],
    ["24.9", "amount", "currency-units"],
    ["24.990", "amount", "currency-units"],
    ["\u221212", "number", "plain"],
    ["100.0", "number", "plain"],
    ["24.99", "amount", "currency-hundredths"],
    ["$100", "number", "plain"],
    ["$ $100", "amount", "plain"],
    ["$100$", "amount", "plain"],
    ["007", "number", "plain"],
    ["1,0000", "number", "plain"],
    ["12,34,567", "number", "plain"],
    ["-0", "number", "plain"],
    ["-0.00", "amount", "currency-units"],
    ["+5", "number", "plain"],
    ["1e3", "number", "plain"],
    ["\uff11\uff10\uff10", "number", "plain"],
    ["100 items", "number", "plain"],
    ["", "number", "plain"],
    ["1 000", "number", "plain"],
    ["$-5.00", "amount", "currency-units"],
  ] as const) {
    assert.equal(readStrictNumber(text, kind, unit), undefined, JSON.stringify(text));
  }
  assert.equal(expectedInUnit("25", "currency-units"), "25.00");
  assert.equal(expectedInUnit("25.5", "currency-units"), "25.50");
  assert.equal(expectedInUnit("25.555", "currency-units"), undefined);
  assert.equal(expectedInUnit("25.5", "plain"), undefined);
  assert.equal(expectedInUnit("-0", "plain"), undefined);
  assert.equal(expectedInUnit("-0.0", "currency-units"), undefined);
});

// ---- rules about a check as a whole --------------------------------------------

test("a binding that breaks a rule of the journey is refused, and its check is not carried out", async () => {
  assert.deepEqual(checkProblems(binding()), []);
  const refusals: [Partial<Draft>, RegExp][] = [
    // A value that was already there: the observation is not seen, with another value, before the write.
    [{ steps: [see("count", "0"), ...BUY, see("count", "1")] }, /observation's reading is not seen/],
    [{ steps: [see("count", "0"), see("balance", "100"), ...BUY, see("count", "1")] }, /observation's reading is not seen/],
    // A write with no before-and-after witness.
    [{ steps: [see("balance", "0"), ...BUY] }, /write has no witness/],
    [{ steps: [see("count", "0"), see("balance", "0"), ...BUY] }, /write has no witness/],
    [{ steps: [see("count", "0"), see("balance", "0"), ...BUY, see("count", "0")] }, /write has no witness/],
    // The observation's own reading is not a witness.
    [{ steps: [see("balance", "0"), ...BUY, see("balance", "100")], expected: { start: 0, end: 3, value: "200" } }, /write has no witness/],
    // Two writes, one sight afterwards: neither write is witnessed by itself.
    [{ steps: [see("count", "0"), see("balance", "0"), ...BUY, ...BUY, see("count", "2")] }, /write has no witness/],
    // What follows what.
    [{ steps: [see("count", "0"), see("balance", "0"), BUY[1], see("count", "1")] }, /does not follow an open/],
    [{ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/other" }, BUY[1], see("count", "1")] }, /another path than the open/],
    [{ steps: [see("count", "0"), see("balance", "0"), ...BUY, BUY[1], see("count", "1")] }, /does not follow an open/],
    [{ steps: [{ kind: "open", path: "/buy" }, see("count", "0"), see("balance", "0"), BUY[1], see("count", "1")] }, /does not follow an open/],
    // A locator that contains the expected value.
    [{ observation: reading("/account", "balance-100") }, /observation's locator contains/],
    [{ steps: [see("count-0", "0"), see("balance", "0"), ...BUY, see("count-0", "1")] }, /condition's locator contains/],
    // A value its unit cannot spell.
    [{ expected: { start: 0, end: 3, value: "100.5" } }, /cannot be written in the unit of its observation/],
    [{ steps: [see("count", "0.5"), see("balance", "0"), ...BUY, see("count", "1")] }, /cannot be written in the unit of its reading/],
    // The rules of the binding itself still hold here.
    [{ setup: { kind: "fixture", method: "POST", path: "/fixture", body: "{}" } }, /fixture body has no/],
    [{ steps: [...BUY] }, /no condition/],
  ];
  for (const [change, expected] of refusals) {
    const bound = binding(change);
    assert.match(checkProblems(bound).join("\n"), expected);
    const { record, ledger } = await check({}, bound);
    unverified(record, "binding-refused");
    assert.ok((record.refused ?? []).length > 0);
    assert.deepEqual(ledger.requests, [], "a refused binding sends nothing to the application");
  }
  // A chain of writes, each with a sight between: witnessed.
  assert.deepEqual(checkProblems(binding({ steps: [see("count", "0"), see("balance", "0"), ...BUY, see("count", "1"), ...BUY, see("count", "2")], expected: { start: 0, end: 3, value: "200" } })), []);
});

// ---- carried out ---------------------------------------------------------------

describe("an approved check, carried out by the engine", { concurrency: 6 }, () => {
  // ---- the positive cases ----

  test("verifies: starting state seen, write witnessed, the expected value on every final reading", async () => {
    const { record, ledger } = await check({});
    assert.equal(record.outcome, "verified");
    assert.equal(record.reason, undefined);
    assert.equal(record.contradictionSeen, false);
    assert.equal(record.expected, "100");
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["100", "100", "100"]);
    assert.equal(record.stepsDone, 5);
    assert.equal(record.writesCounted, 1);
    assert.match(record.bindingSha256, /^[0-9a-f]{64}$/);
    assert.equal(ledger.requests.filter((line) => line.startsWith("POST")).length, 1, "the engine made the one approved write, once");
    // The last reading is not before the approved time has passed since the write.
    assert.ok(record.finalReadings[2]!.afterMs - record.finalReadings[0]!.afterMs >= 500);
  });

  test("verifies a value that arrives late but within the approved time, and stays", async () => {
    const { record } = await check(
      {
        "POST /purchase": (ledger) => {
          ledger.count += 1;
          setTimeout(() => (ledger.balance += 100), 3_000);
          return json({ ok: true });
        },
      },
      binding({ settling: { within: 6, readings: 5 } }),
    );
    assert.equal(record.outcome, "verified");
    assert.equal(record.finalReadings[0]!.value, "0");
    assert.equal(record.contradictionSeen, true);
    assert.deepEqual(record.finalReadings.slice(-2).map((entry) => entry.value), ["100", "100"]);
  });

  test("fails only on the same contradicting value on every reading across the approved time, with every precondition seen", async () => {
    const { record } = await check({
      "POST /purchase": (ledger) => {
        ledger.count += 1;
        ledger.balance += 50;
        return json({ ok: true });
      },
    });
    assert.equal(record.outcome, "failed");
    assert.equal(record.reason, undefined);
    assert.equal(record.contradictionSeen, true);
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["50", "50", "50"]);
    assert.ok(record.finalReadings[2]!.afterMs - record.finalReadings[0]!.afterMs >= 500);
  });

  test("a fixture, a fill and an act on one path: the engine's own key, a value of the answer, a sign-in before the starting state", async () => {
    const routes: Routes = {
      "POST /fixture": (ledger, body) => {
        ledger.bodies.push(body);
        ledger.balance = 0;
        ledger.count = 0;
        return json({ username: `user-${(JSON.parse(body) as { key: string }).key}` });
      },
      "GET /enter": () => html(`<input aria-label="Name"><button onclick="fetch('/session', { method: 'POST', body: document.querySelector('input').value })">Enter</button>`),
      "POST /session": (ledger, body) => {
        ledger.bodies.push(body);
        return json({ ok: true });
      },
    };
    const bound = binding({
      setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' },
      steps: [
        { kind: "open", path: "/enter" },
        { kind: "fill", path: "/enter", locator: { by: "role", role: "textbox", name: "Name" }, value: { from: "fixture", field: "username" } },
        { kind: "act", path: "/enter", locator: button("Enter"), expects: { write: "one", method: "POST", path: "/session" } },
        see("count", "0"),
        see("balance", "0"),
        ...BUY,
        see("count", "1"),
      ],
    });
    const runId = "11111111-1111-4111-8111-111111111111";
    const { record, ledger } = await check(routes, bound, { runId });
    assert.equal(record.outcome, "verified");
    assert.equal(record.writesCounted, 2);
    const key = fixtureKey(runId, bound);
    assert.match(key, /^rp-[0-9a-f]{24}$/);
    assert.deepEqual(ledger.bodies, [`{"key":"${key}"}`, `user-${key}`]);
    // Another run, or another binding, has another key.
    assert.notEqual(fixtureKey("22222222-2222-4222-8222-222222222222", bound), key);
    assert.notEqual(fixtureKey(runId, binding({ ...bound, id: "another" })), key);
    // The value taken from the fixture's answer is nowhere in the record.
    assert.ok(!JSON.stringify(record).includes(key));
  });

  test("a request to another host is blocked and not counted; an answer the binding tolerates is not an error", async () => {
    const page: Routes = { "GET /account": (ledger) => account(ledger, `<img src="http://other.invalid/pixel.png"><script>fetch("/absent")</script>`) };
    const { record } = await check(page, binding({ tolerated: [{ method: "GET", path: "/absent", status: 404 }] }));
    assert.equal(record.outcome, "verified");
    // The same page without the approver's tolerance: an error answer, and the check says nothing.
    unverified((await check(page)).record, "error-answer");
    // Tolerated for one status is not tolerated for another.
    unverified((await check(page, binding({ tolerated: [{ method: "GET", path: "/absent", status: 500 }] }))).record, "error-answer");
  });

  test("a write the binding lists as background is not counted; unlisted, it stops the check", async () => {
    const page: Routes = { "GET /account": (ledger) => account(ledger, `<script>fetch("/seen", { method: "POST" })</script>`), "POST /seen": () => json({}) };
    assert.equal((await check(page, binding({ background: [{ method: "POST", path: "/seen" }] }))).record.outcome, "verified");
    // A request of the application's own during a step that sends none.
    unverified((await check(page)).record, "uncounted-write");
  });

  test("what the page's own script says about itself changes nothing: the value is read where that script cannot reach", async () => {
    const lies = (shown: string) => `<script>
      Object.defineProperty(HTMLElement.prototype, "innerText", { get: () => "${shown}" });
      Object.defineProperty(Node.prototype, "textContent", { get: () => "${shown}" });
      window.getComputedStyle = () => ({ visibility: "visible", opacity: "1", display: "block" });
      Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 });
      Document.prototype.elementFromPoint = () => document.querySelector("[data-testid=balance]");
      Document.prototype.elementsFromPoint = () => [document.querySelector("[data-testid=balance]")];
    </script>`;
    // The page awards 50 and says 100: the engine reads 50.
    const { record } = await check({
      "GET /account": (ledger) => account(ledger, lies("100")),
      "POST /purchase": (ledger) => {
        ledger.count += 1;
        ledger.balance += 50;
        return json({});
      },
    });
    assert.notEqual(record.outcome, "verified");
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["50", "50", "50"]);
    // The page hides the value and says it is displayed: not displayed.
    const hidden = await check({ "GET /account": (ledger) => html(`<p data-testid="balance" style="opacity:0">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>${lies("100")}`) });
    unverified(hidden.record, "element-not-displayed");
  });

  // ---- address ----

  test("address: a redirect, an error answer, another spelling of the path, a page that rewrites its own address", async () => {
    unverified((await check({ "GET /account": () => ({ status: 302, headers: { location: "/elsewhere" } }), "GET /elsewhere": (ledger) => account(ledger) })).record, "address-not-bound");
    // A redirect onto the bound path, for a check bound to where it lands.
    const landed = binding({ steps: [see("count", "0", "/landed"), see("balance", "0"), ...BUY, see("count", "1", "/landed")] });
    unverified((await check({ "GET /landed": () => ({ status: 302, headers: { location: "/landed/" } }), "GET /landed/": (ledger) => account(ledger) }, landed)).record, "address-not-bound");
    unverified((await check({ "GET /account": () => ({ status: 500, body: "down" }) })).record, "error-answer");
    // A trailing slash and another letter case are other paths: this application does not serve them.
    unverified((await check({}, binding({ observation: reading("/account/", "balance"), steps: [see("count", "0"), { kind: "see", reading: reading("/account/", "balance"), expected: { from: "literal", value: "0" } }, ...BUY, see("count", "1")] }))).record, "error-answer");
    unverified((await check({}, binding({ steps: [see("count", "0", "/Account"), see("balance", "0"), ...BUY, see("count", "1", "/Account")] }))).record, "error-answer");
    for (const rewrite of [`history.replaceState(null, "", "/account?shown=1")`, `location.hash = "#top"`, `history.pushState(null, "", "/account")`, `history.replaceState(null, "", "/other")`]) {
      unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>${rewrite}</script>`) })).record, "address-not-bound");
    }
    // A path the browser spells another way than the binding does: one navigation, and not the bound address.
    const braces = binding({ steps: [see("count", "0", "/acc{ount}"), see("balance", "0"), ...BUY, see("count", "1", "/acc{ount}")] });
    unverified((await check({ "GET /acc%7Bount%7D": (ledger) => account(ledger) }, braces)).record, "address-not-bound");
    // A page that takes itself to another page of the application.
    unverified((await check({ "GET /account": () => html(`<script>location.replace("/real")</script>`), "GET /real": (ledger) => account(ledger) })).record, "address-not-bound");
  });

  // ---- element ----

  test("element: missing, twice with one hidden, without size, transparent, covered, off screen, in a frame", async () => {
    const cases: [string, (ledger: Ledger) => string, (typeof UNVERIFIED_REASONS)[number]][] = [
      ["missing", (ledger) => `<p data-testid="count">${ledger.count}</p>`, "element-missing"],
      ["twice, one hidden", (ledger) => `<p data-testid="balance">${ledger.balance}</p><p data-testid="balance" hidden>100</p><p data-testid="count">${ledger.count}</p>`, "element-not-single"],
      ["no size", (ledger) => `<p data-testid="balance" style="width:0;height:0;overflow:hidden;margin:0">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>`, "element-not-displayed"],
      ["hidden", (ledger) => `<p data-testid="balance" style="visibility:hidden">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>`, "element-not-displayed"],
      ["transparent ancestor", (ledger) => `<div style="opacity:0"><p data-testid="balance">${ledger.balance}</p></div><p data-testid="count">${ledger.count}</p>`, "element-not-displayed"],
      ["covered", (ledger) => `<p data-testid="balance">${ledger.balance}</p><div style="position:fixed;inset:0 0 auto 0;height:60px;background:white">100</div><p data-testid="count" style="margin-top:80px">${ledger.count}</p>`, "element-not-displayed"],
      // Covered by something that takes no clicks: a hit test asked of the document would not find it.
      ["covered, no clicks taken", (ledger) => `<p data-testid="balance">${ledger.balance}</p><div style="position:fixed;inset:0 0 auto 0;height:60px;background:white;pointer-events:none">100</div><p data-testid="count" style="margin-top:80px">${ledger.count}</p>`, "element-not-displayed"],
      ["off screen", (ledger) => `<p data-testid="balance" style="position:fixed;left:-5000px;top:0;width:100px">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>`, "element-not-displayed"],
      ["in a frame", (ledger) => `<iframe srcdoc="<p data-testid='balance'>${ledger.balance}</p>"></iframe><p data-testid="count">${ledger.count}</p>`, "element-missing"],
      ["a heading", (ledger) => `<h2 data-testid="balance">${ledger.balance}</h2><p data-testid="count">${ledger.count}</p>`, "element-not-a-value"],
      ["inside a label", (ledger) => `<label><span data-testid="balance">${ledger.balance}</span></label><p data-testid="count">${ledger.count}</p>`, "element-not-a-value"],
    ];
    for (const [name, body, reason] of cases) {
      const { record } = await check({ "GET /account": (ledger) => html(body(ledger)) });
      assert.equal(record.outcome, "unverified", name);
      assert.equal(record.reason, reason, name);
    }
    // By role, as by test id: a hidden second match is a second match.
    const status = { path: "/account", locator: { by: "role" as const, role: "status", name: "Balance" }, valueKind: "number" as const, unit: "plain" as const };
    const byRole = binding({ steps: [see("count", "0"), { kind: "see", reading: status, expected: { from: "literal", value: "0" } }, ...BUY, see("count", "1")], observation: status });
    const shown = (ledger: Ledger, extra: string) => html(`<p role="status" aria-label="Balance">${ledger.balance}</p>${extra}<p data-testid="count">${ledger.count}</p>`);
    assert.equal((await check({ "GET /account": (ledger) => shown(ledger, "") }, byRole)).record.outcome, "verified");
    unverified((await check({ "GET /account": (ledger) => shown(ledger, `<p role="status" aria-label="Balance" hidden>100</p>`) }, byRole)).record, "element-not-single");
    // Below the fold is not off screen: the engine scrolls to it.
    assert.equal((await check({ "GET /account": (ledger) => html(`<div style="height:3000px"></div><p data-testid="balance">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>`) })).record.outcome, "verified");
  });

  // ---- reading ----

  test("reading: a spelling outside the grammar is unverified, never a mismatch", async () => {
    for (const shown of ["1,00", "100.0", "\u2212100", "100 pts", "one hundred"]) {
      const { record } = await check({ "GET /account": (ledger) => html(`<p data-testid="balance">${ledger.balance === 100 ? shown : ledger.balance}</p><p data-testid="count">${ledger.count}</p>`) });
      assert.equal(record.outcome, "unverified", JSON.stringify(shown));
      assert.equal(record.reason, "reading-not-a-number", JSON.stringify(shown));
    }
    // Nothing shown at all has no size: not displayed.
    unverified((await check({ "GET /account": (ledger) => html(`<p data-testid="balance">${ledger.balance === 100 ? "" : ledger.balance}</p><p data-testid="count">${ledger.count}</p>`) })).record, "element-not-displayed");
    // "2499" where 24.99 is expected in units: not a number of that unit, not a contradiction.
    const priced = binding({ steps: [see("count", "0")], observation: reading("/account", "price", "currency-units", "amount"), expected: { start: 0, end: 5, value: "24.99" } });
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<p data-testid="price">2499</p>`) }, priced)).record, "reading-not-a-number");
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<p data-testid="price">24,99</p>`) }, priced)).record, "reading-not-a-number");
    assert.equal((await check({ "GET /account": (ledger) => account(ledger, `<p data-testid="price">$24.99</p>`) }, priced)).record.outcome, "verified");
    assert.equal((await check({ "GET /account": (ledger) => account(ledger, `<p data-testid="price">$25.99</p>`) }, priced)).record.outcome, "failed");
  });

  test("a value the check typed itself is never read: a reading is made on a page the engine has just opened", async () => {
    const typed = binding({
      steps: [see("count", "0"), { kind: "open", path: "/form" }, { kind: "fill", path: "/form", locator: { by: "role", role: "textbox", name: "Amount" }, value: { from: "literal", text: "100" } }, { kind: "see", reading: reading("/form", "echo"), expected: { from: "literal", value: "100" } }],
      observation: reading("/form", "echo"),
    });
    const { record } = await check({ "GET /form": () => html(`<input aria-label="Amount" oninput="document.querySelector('p').textContent = this.value"><p data-testid="echo">0</p>`) }, typed);
    unverified(record, "condition-not-met");
  });

  test("final readings that do not agree: a value that changes, one that differs once, one that arrives and leaves", async () => {
    const sequence = (values: number[]): Routes => {
      let reads = 0;
      return { "GET /account": (ledger) => html(`<p data-testid="balance">${ledger.count === 0 ? 0 : values[Math.min(reads++, values.length - 1)]}</p><p data-testid="count">${ledger.count}</p>`) };
    };
    // The witness `see` after the write is one read of the page; the final readings follow it.
    for (const values of [[0, 100, 50, 70], [0, 50, 100, 50], [0, 100, 100, 50], [0, 50, 50, 100]]) {
      const { record } = await check(sequence(values));
      unverified(record, "final-readings-disagree");
      assert.equal(record.contradictionSeen, true, "contradiction seen, preconditions not established");
    }
    // Wrong once and then right for good, at least twice: verified.
    assert.equal((await check(sequence([0, 50, 100, 100]))).record.outcome, "verified");
  });

  // ---- journey ----

  test("journey: a write where none is expected, none where one is, a second write, another write than the named one", async () => {
    const quiet = binding({ steps: [see("count", "0"), { kind: "open", path: "/buy" }, { kind: "act", path: "/buy", locator: button("Buy"), expects: { write: "none" } }, see("count", "1")], observation: reading("/account", "count"), expected: { start: 0, end: 1, value: "1" } });
    unverified((await check({}, quiet)).record, "write-not-as-expected");
    unverified((await check({ "GET /buy": () => html(`<button>Buy</button>`) })).record, "write-not-as-expected");
    unverified((await check({ "GET /buy": () => html(`<button onclick="fetch('/purchase', { method: 'POST' }); fetch('/purchase', { method: 'POST' })">Buy</button>`) })).record, "write-not-as-expected");
    unverified((await check({ "GET /buy": () => html(`<button onclick="fetch('/purchase', { method: 'PUT' })">Buy</button>`), "PUT /purchase": BASE["POST /purchase"]! })).record, "write-not-as-expected");
    unverified((await check({ "GET /buy": () => html(`<button onclick="fetch('/purchase?twice=1', { method: 'POST' })">Buy</button>`) })).record, "write-not-as-expected");
    // Refused by the application: an answer of 400 or above.
    unverified((await check({ "POST /purchase": () => json({ error: "no" }, 422) })).record, "error-answer");
    // A write that comes by itself after the act is over.
    unverified((await check({ "GET /account": (ledger) => account(ledger, ledger.count === 1 ? `<script>fetch("/purchase", { method: "POST" })</script>` : "") })).record, "uncounted-write");
  });

  test("journey: a step that cannot be done, a page that is no longer the opened one", async () => {
    const filled = (locator: { by: "role"; role: string; name: string } | { by: "testid"; value: string }) =>
      binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator, value: { from: "literal", text: "one" } }, BUY[1], see("count", "1")] });
    // Filling in something that is not a field.
    unverified((await check({}, filled(button("Buy")))).record, "step-not-done");
    unverified((await check({}, filled(testid("absent")))).record, "element-missing");
    // An act that expects no write and takes the page elsewhere: the next step is no longer on its page.
    const moved = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "act", path: "/buy", locator: { by: "role", role: "link", name: "More" }, expects: { write: "none" } }, BUY[1], see("count", "1")] });
    unverified((await check({ "GET /buy": () => html(`<a href="/more">More</a>`), "GET /more": () => html(`<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`) }, moved)).record, "address-not-bound");
  });

  test("a condition that is not met is a precondition unmet: unverified, never failed", async () => {
    // A starting state that is not the expected one.
    const used = await check({ "GET /account": (ledger) => html(`<p data-testid="balance">${ledger.balance}</p><p data-testid="count">${ledger.count + 7}</p>`) });
    unverified(used.record, "condition-not-met");
    assert.deepEqual(used.ledger.requests.filter((line) => line.startsWith("POST")), [], "the check stopped before its write");
    // A value that was already there: the balance is the expected one before the purchase.
    unverified((await check({ "GET /account": (ledger) => html(`<p data-testid="balance">100</p><p data-testid="count">${ledger.count}</p>`) })).record, "condition-not-met");
    // An act answered 200 with a body that says it failed: nothing changed, so nothing witnesses the write.
    const { record } = await check({ "POST /purchase": () => json({ ok: false, error: "declined" }) });
    unverified(record, "condition-not-met");
    assert.deepEqual(record.finalReadings, [], "no final reading is made once a precondition is unmet");
  });

  test("something wrong anywhere in the check: a failed data request, a page error, a page that never comes to rest", async () => {
    // A page whose own data request fails and shows a default.
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>fetch("/data").catch(() => {})</script>`), "GET /data": () => ({ status: 503, body: "" }) })).record, "error-answer");
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>setTimeout(() => { throw new Error("broken") }, 0)</script>`) })).record, "page-error");
    // Wrong on the last page of all is still wrong: the check verifies nothing.
    let pages = 0;
    unverified((await check({ "GET /account": (ledger) => account(ledger, ++pages === 6 ? `<script>setTimeout(() => { throw new Error("late") }, 0)</script>` : "") })).record, "page-error");
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>fetch("/held")</script>`), "GET /held": () => "hang" })).record, "page-not-at-rest");
  });

  test("the time limit ends a check as unverified", async () => {
    unverified((await check({}, binding(), { limitMs: 1 })).record, "time-ran-out");
    unverified((await check({}, binding(), { limitMs: 1_500 })).record, "time-ran-out");
  });

  // ---- fixtures ----

  test("fixtures: a call that fails, an answer that is not usable, a field that is missing, not plain or inherited", async () => {
    const withFixture = (field: string) =>
      binding({
        setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' },
        steps: [{ kind: "open", path: "/enter" }, { kind: "fill", path: "/enter", locator: { by: "role", role: "textbox", name: "Name" }, value: { from: "fixture", field } }, see("count", "0"), see("balance", "0"), ...BUY, see("count", "1")],
      });
    const enter: Routes = { "GET /enter": () => html(`<input aria-label="Name">`) };
    unverified((await check({ ...enter, "POST /fixture": () => json({ error: "no" }, 500) }, withFixture("username"))).record, "setup-failed");
    unverified((await check({ ...enter }, withFixture("username"))).record, "setup-failed");
    unverified((await check({ ...enter, "POST /fixture": () => ({ status: 302, headers: { location: "/enter" } }) }, withFixture("username"))).record, "setup-failed");
    unverified((await check({ ...enter, "POST /fixture": () => ({ body: "created" }) }, withFixture("username"))).record, "setup-failed");
    unverified((await check({ ...enter, "POST /fixture": () => json(["username"]) }, withFixture("username"))).record, "setup-failed");
    for (const [answer, field] of [[{ other: "x" }, "username"], [{ username: { name: "x" } }, "username"], [{ username: null }, "username"], [{ username: "" }, "username"], [{ username: "x".repeat(501) }, "username"], [{ username: "x" }, "toString"], [{ username: "x" }, "constructor"]] as const) {
      unverified((await check({ ...enter, "POST /fixture": () => json(answer) }, withFixture(field))).record, "fixture-value-unusable");
    }
    // The fixture call is the engine's own, made outside the browser: what it sets is not carried into the page.
    const cookie = await check({ ...enter, "POST /fixture": () => ({ headers: { "content-type": "application/json", "set-cookie": "who=fixture; Path=/" }, body: '{"username":"x"}' }), "GET /account": (ledger) => account(ledger, `<p data-testid="cookie">${ledger.calls}</p>`) }, withFixture("username"));
    assert.equal(cookie.record.outcome, "verified");
  });

  test("an application that ignores the engine's key, run twice: the second run's starting state is not met", async () => {
    const { baseUrl, server, ledger } = await app({ "POST /fixture": () => json({ username: "shared" }) });
    try {
      const bound = binding({ setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' } });
      const first = await carryOutCheck({ browser, baseUrl, runId: "33333333-3333-4333-8333-333333333333", binding: bound });
      assert.equal(first.outcome, "verified");
      const second = await carryOutCheck({ browser, baseUrl, runId: "44444444-4444-4444-8444-444444444444", binding: bound });
      unverified(second, "condition-not-met");
      assert.equal(ledger.count, 1, "the second run made no purchase");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("no credentials in a binding: a literal is not typed into a field that holds a secret by its kind", async () => {
    const secret = (field: string) =>
      check(
        { "GET /buy": () => html(`${field}<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`) },
        binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "literal", text: "hunter2" } }, BUY[1], see("count", "1")] }),
      );
    unverified((await secret(`<input type="password" data-testid="field">`)).record, "secret-field-literal");
    unverified((await secret(`<input autocomplete="one-time-code" data-testid="field">`)).record, "secret-field-literal");
    assert.equal((await secret(`<input data-testid="field">`)).record.outcome, "verified");
  });

  test("nothing stored is carried from one check into the next, and the browser is set as the binding says", async () => {
    const page: Routes = {
      "GET /account": (ledger) =>
        account(ledger, `<p data-testid="visits"></p><p data-testid="hour"></p><script>
          const visits = Number(localStorage.getItem("visits") ?? "0");
          document.querySelector("[data-testid=visits]").textContent = String(visits);
          document.querySelector("[data-testid=hour]").textContent = String(new Date(Date.UTC(2026, 0, 1, 12)).getHours()) + (navigator.language === "ja-JP" ? "" : "?");
        </script>`),
    };
    const fresh = binding({ steps: [see("visits", "0")], observation: reading("/account", "hour"), expected: { start: 0, end: 2, value: "21" }, locale: "ja-JP", timezone: "Asia/Tokyo" });
    assert.equal((await check(page, fresh)).record.outcome, "verified");
    // A time zone the browser does not know: the check cannot be set up.
    unverified((await check(page, binding({ ...fresh, timezone: "Nowhere/Never" }))).record, "setup-failed");
  });
});

// ---- the locks -----------------------------------------------------------------

test("the runner is used by no run, and no source writes a trusted result", async () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = await readFile(path.join(src, file), "utf8");
    if (file !== path.join("remote", "check.ts")) {
      assert.doesNotMatch(text, /remote\/check(\.ts)?["']|\.\/check(\.ts)?["']/, `${file} refers to the check runner`);
      assert.doesNotMatch(text, /carryOutCheck|checkProblems/, `${file} refers to the check runner`);
    }
    assert.doesNotMatch(text, /verdictsTrusted\s*[:=]\s*true/, `${file} writes a trusted result`);
  }
});
