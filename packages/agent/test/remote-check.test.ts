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
import { carryOutCheck, checkProblems, criteriaProblems, expectedInUnit, fixtureKey, readStrictNumber, UNVERIFIED_REASONS, type CheckRecord } from "../src/remote/check.ts";
import { sha256Hex } from "../src/remote/request.ts";
import { notQuoted, quotedNumbers } from "../src/validate.ts";

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

/**
 * A criteria text for a binding of these tests, and the binding made to be for it: one line that states the
 * expected value first. The tests of the rules about the text itself write their own.
 */
function forText(bound: Binding): { binding: Binding; criteria: string } {
  const criteria = `${bound.expected.value} is the value shown when the journey is done.`;
  const made = Binding.parse({ ...bound, snapshotSha256: sha256Hex(criteria), quote: { start: 0, end: criteria.length }, expected: { start: 0, end: bound.expected.value.length, value: bound.expected.value } });
  return { binding: made, criteria };
}
/** Carries a check out as the tests of the journey mean it: with a criteria text that states its expected value. */
const carry = (options: Omit<Parameters<typeof carryOutCheck>[0], "criteria">) => carryOutCheck({ ...options, ...forText(options.binding) });

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
    const record = await carry({ browser, baseUrl, runId: options.runId ?? `00000000-0000-4000-8000-${String(++runs).padStart(12, "0")}`, binding: bound, ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs }) });
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
    // The observation's element is no witness, read as another kind of value either.
    [{ steps: [see("balance", "0"), { kind: "see", reading: reading("/account", "balance", "plain", "amount"), expected: { from: "literal", value: "0" } }, ...BUY, { kind: "see", reading: reading("/account", "balance", "plain", "amount"), expected: { from: "literal", value: "100" } }], expected: { start: 0, end: 3, value: "200" } }, /write has no witness/],
    [{ steps: [see("count", "0")], observation: reading("/account", "price-25", "currency-units", "amount"), expected: { start: 0, end: 5, value: "25.00" } }, /observation's locator contains/],
    [{ steps: [see("count", "0")], observation: reading("/account", "b5"), expected: { start: 0, end: 2, value: "-5" } }, /observation's locator contains/],
    // Writes that all come before anything is seen: whatever is read at the end may have been there all along.
    [{ steps: [...BUY, see("count", "1")] }, /writes all come before its first condition/],
    // The observation seen with another value, and then with the final one, before the write: it was there already.
    [{ steps: [see("count", "0"), see("balance", "0"), see("balance", "100"), ...BUY, see("count", "1")] }, /observation's reading is not seen/],
    // A locator that holds the expected value as its unit spells it.
    [{ steps: [see("count", "0")], observation: reading("/account", "price-25.50", "currency-units", "amount"), expected: { start: 0, end: 4, value: "25.5" } }, /observation's locator contains/],
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

// ---- rules that need the criteria text -----------------------------------------

test("the reader of quoted numbers says where each number stands, and reads what the validator's reader reads", () => {
  const texts = [
    "After a purchase of 24.99 the balance is 100.",
    "1. The balance is 100\n2) A purchase adds 1,250 to it\n  3. Nothing else changes",
    "KAN-160 says 160px is 3/4 of #160, from 10:30 to 100\u2013160, and 2026-01-05.",
    "A balance of \u22125 is shown as 5.00, never as 5.0.1 or 1,24.",
    "Total:\u00a0100\u00a0items \u2026 7",
    "",
  ];
  for (const text of texts) {
    const numbers = quotedNumbers(text);
    // Each number is the text at its place, but for a dash that is read as a minus.
    for (const number of numbers) assert.equal(text.slice(number.start, number.end).replace(/[\u2010-\u2015\u2212]/g, "-"), number.text, text);
    // And they are the validator's numbers: each is stated, and nothing else in the text is.
    for (const number of numbers) assert.equal(notQuoted({ literal: Number(number.text.replaceAll(",", "")) }, text, "plain"), undefined, `${number.text} in ${text}`);
    const stated = new Set(numbers.map((number) => Number(number.text.replaceAll(",", ""))));
    for (const candidate of [1, 2, 3, 4, 5, 7, 10, 30, 100, 160, 1250, 24.99, 2026, -5, 5.0, 24]) {
      assert.equal(notQuoted({ literal: candidate }, text, "plain") === undefined, stated.has(candidate), `${candidate} in ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(quotedNumbers("1. The balance is 100\n2) A purchase adds 1,250 to it"), [
    { start: 18, end: 21, text: "100" },
    { start: 41, end: 46, text: "1,250" },
  ]);
});

test("a binding is for its criteria text: whole lines, the number written at its place, equality only", async () => {
  const criteria = "# Balance\n\nAfter one purchase the balance is 100.\nA new account starts with a balance of 0.\nThe balance is at least 50 after a refund.\nThe total is 1,250 and never 1250.5.\nLe solde est de 100 apr\u00e8s un achat.\n";
  const line = (text: string) => ({ start: criteria.indexOf(text), end: criteria.indexOf(text) + text.length });
  // Where a number stands in a quote: its last place, so that "0" is the nought at the end and not one of "100".
  const within = (span: { start: number; end: number }, number: string, value = number) => {
    const at = criteria.slice(span.start, span.end).lastIndexOf(number);
    return { start: at, end: at + number.length, value };
  };
  const purchase = line("After one purchase the balance is 100.");
  const starts = line("A new account starts with a balance of 0.");
  const both = { start: purchase.start, end: starts.end };
  const bound = (change: Partial<Draft> = {}) => binding({ snapshotSha256: sha256Hex(criteria), quote: purchase, expected: within(purchase, "100"), ...change });

  assert.deepEqual(criteriaProblems(bound(), criteria), []);
  // Two lines, a condition from the one and the final value from the other.
  const fromQuote = bound({ quote: both, expected: within(both, "100"), steps: [see("count", "0"), { kind: "see", reading: reading("/account", "balance"), expected: { from: "quote", ...within(both, "0") } }, ...BUY, see("count", "1")] });
  assert.deepEqual(criteriaProblems(fromQuote, criteria), []);
  // A number written with a group separator is that number.
  const total = line("The total is 1,250 and never 1250.5.");
  assert.match(criteriaProblems(bound({ quote: total, expected: within(total, "1,250", "1250") }), criteria).join("\n"), /words a negation/);

  const refusals: [Partial<Draft>, string, RegExp][] = [
    [{}, `${criteria} `, /not the revision/],
    [{ snapshotSha256: "b".repeat(64) }, criteria, /not the revision/],
    [{ quote: { start: purchase.start, end: criteria.length + 5 } }, criteria, /outside the criteria text/],
    // Offsets off a line boundary: a line begun late, ended early, or with its line break.
    [{ quote: { start: purchase.start + 6, end: purchase.end }, expected: { start: 28, end: 31, value: "100" } }, criteria, /not whole lines/],
    [{ quote: { start: purchase.start, end: purchase.end - 1 } }, criteria, /not whole lines/],
    [{ quote: { start: purchase.start, end: purchase.end + 1 } }, criteria, /not whole lines/],
    // A span that is not one whole number: inside a longer one, more than one, inside a word.
    [{ expected: { ...within(purchase, "100"), end: within(purchase, "100").end - 1, value: "10" } }, criteria, /not at one whole number/],
    [{ expected: { start: within(purchase, "100").start + 1, end: within(purchase, "100").start + 2, value: "0" } }, criteria, /not at one whole number/],
    [{ expected: { start: within(purchase, "one").start, end: within(purchase, "one").end, value: "1" } }, criteria, /not at one whole number/],
    // A value that is not the number at the offsets.
    [{ expected: within(purchase, "100", "200") }, criteria, /not the number written/],
    [{ expected: within(purchase, "100", "100.0") }, criteria, /not the number written/],
    [{ quote: both, expected: within(both, "100"), steps: [see("count", "0"), { kind: "see", reading: reading("/account", "balance"), expected: { from: "quote", ...within(both, "0", "5") } }, ...BUY, see("count", "1")] }, criteria, /condition's expected value is not the number written/],
    // A bound, a negation, another language.
    [{ quote: line("The balance is at least 50 after a refund."), expected: within(line("The balance is at least 50 after a refund."), "50") }, criteria, /words a bound/],
    [{ quote: total, expected: within(total, "1,250", "1250") }, criteria, /words a negation/],
    [{ quote: line("Le solde est de 100 apr\u00e8s un achat."), expected: within(line("Le solde est de 100 apr\u00e8s un achat."), "100") }, criteria, /outside the English alphabet/],
  ];
  for (const [change, text, expected] of refusals) assert.match(criteriaProblems(bound(change), text).join("\n"), expected, JSON.stringify(change));

  // One text, one line (or more) quoted whole, the last number in it bound: what does the engine say?
  const said = (text: string, quoted: string, number: string, value = number) => {
    const quote = { start: text.indexOf(quoted), end: text.indexOf(quoted) + quoted.length };
    const at = quoted.lastIndexOf(number);
    return criteriaProblems(binding({ snapshotSha256: sha256Hex(text), quote, expected: { start: at, end: at + number.length, value } }), text).join("\n");
  };
  const oneLine = (sentence: string, number = "100", value = number) => said(`${sentence}\n`, sentence, number, value);
  assert.equal(oneLine("After a purchase the balance is 100."), "");
  assert.equal(oneLine("The total is 1,250 after the second purchase.", "1,250", "1250"), "");
  assert.match(oneLine("The total is 1,250 after the second purchase.", "1,250", "1,250".replace(",", "0")), /not the number written/);
  // A span that ends where a number ends and begins inside it.
  assert.match(said("The balance is 100.\n", "The balance is 100.", "00", "0"), /not at one whole number/);

  // A bound, however it is written out: over a line break, with other space, in emphasis, in capitals.
  for (const sentence of [
    "After a purchase the balance is at\nleast 100.",
    "After a purchase the balance is at  least 100.",
    "After a purchase the balance is at\tleast 100.",
    "After a purchase the balance is at\u00a0least 100.",
    "After a purchase the balance is _at least_ 100.",
    "After a purchase the balance is **at least** 100.",
    "After a purchase the balance is AT LEAST 100.",
    "After a purchase the balance is up\r\nto 100.",
    "After a purchase the balance is at most 100.",
    "After a purchase the balance is 100 or\nmore.",
    "After a purchase the balance is more than 100.",
    "After a purchase the balance is less than 100.",
    "After a purchase the balance is over 100.",
    "After a purchase the balance is under 100.",
    "After a purchase the balance is between 50 and 100.",
    "After a purchase the balance goes from 50 to 100.",
    "After a purchase the balance is about 100.",
    "After a purchase the balance is approximately 100.",
    "After a purchase the balance is >= 100.",
    "After a purchase the balance is \u2265 100.",
    "After a purchase the balance is < 100.",
    "The balance has a max of 100.",
    "The balance is 100+ after a purchase.",
    "The balance does exceed 100.",
    "The balance stays within 100.",
  ]) {
    assert.match(oneLine(sentence), /words a bound/, JSON.stringify(sentence));
  }
  // A negation, with every kind of apostrophe and in emphasis.
  for (const sentence of [
    "After a purchase the balance isn\u2019t 100.",
    "After a purchase the balance isn't 100.",
    "After a purchase the balance won't be 100.",
    "After a purchase the balance doesn\u02bct reach 100.",
    "After a purchase the balance is _not_ 100.",
    "After a purchase the balance is __never__ 100.",
    "After a purchase the balance is NOT 100.",
    "Neither balance is 100.",
    "Nothing but 100 is shown.",
    "The balance is 100 unless a refund was made.",
    "The balance is non-zero, namely 100.",
  ]) {
    assert.match(oneLine(sentence), /words a negation/, JSON.stringify(sentence));
  }
  // Part of a sentence that runs over several lines: the words left out may be the bound.
  const wrapped = "# Refunds\n\nAfter a purchase the balance is 100 and\nit is never more than 150.\n\n- The balance after two is 200\n  or more.\n- A refund gives 100\n";
  assert.match(said(wrapped, "After a purchase the balance is 100 and", "100"), /ends in the middle of a sentence/);
  assert.match(said(wrapped, "it is never more than 150.", "150"), /begins in the middle of a sentence/);
  assert.match(said(wrapped, "- The balance after two is 200", "200"), /ends in the middle of a sentence/);
  // An item of a list, with another item after it, is whole.
  assert.equal(said("- The balance is 100\n- A refund gives 50\n", "- The balance is 100", "100"), "");
  assert.equal(said(wrapped, "- A refund gives 100", "100"), "");

  // Line ends. A carriage return ends a line only before a line feed.
  const windows = "The balance is 100.\r\nA refund gives 50.\r\n";
  assert.equal(said(windows, "The balance is 100.", "100"), "");
  assert.match(said(windows, "The balance is 100.\r", "100"), /not whole lines/);
  assert.match(said("The balance is 100\r or more.\n", "The balance is 100", "100"), /not whole lines/);
  // A quote of nothing but space.
  assert.match(said("One.\n   \nTwo is 2.\n", "   ", " ", "2"), /holds no text/);

  // A sign the text does not state plainly.
  for (const [sentence, number, value] of [
    ["The balance is -$5.00 after.", "5.00", "5.00"],
    ["The balance is -\u00a35 after.", "5", "5"],
    ["The balance is (5.00) after.", "5.00", "5.00"],
    ["Balance:-5 after.", "5", "5"],
    ["There are \u21925 items.", "\u21925", "-5"],
    ["The balance is \u20265 after.", "\u20265", "-5"],
    ["The balance is 100 - 5 after.", "5", "5"],
  ] as const) {
    assert.match(oneLine(sentence, number, value), /sign that the text does not state plainly/, sentence);
  }
  assert.equal(oneLine("The balance is -5 after.", "-5"), "");
  assert.equal(oneLine("The balance is \u22125 after.", "\u22125", "-5"), "");
  assert.equal(oneLine("The balance is $5.00 after.", "5.00"), "");

  // What the second review found. A sign in the forms accounts are written in.
  for (const [sentence, number] of [
    ["The balance is ($5.00) now.", "5.00"],
    ["The balance is ( 5.00 ) now.", "5.00"],
    ["The balance is (5.00 USD) now.", "5.00"],
    ["The balance is (USD 5.00) now.", "5.00"],
    ["The balance is -USD 5.00 now.", "5.00"],
    ["The balance is - R$ 5.00 now.", "5.00"],
    ["The balance is -\u20aa5.00 now.", "5.00"],
    ["The balance is 5.00- now.", "5.00"],
    ["The balance is 5.00 CR now.", "5.00"],
  ] as const) {
    assert.match(oneLine(sentence, number), /sign that the text does not state plainly/, sentence);
  }
  for (const sentence of ["The balance is minus 5 now.", "The balance is negative 5 now.", "The account is overdrawn at 5."]) assert.match(oneLine(sentence, "5"), /words a negation/, sentence);
  // A dash that marks an item of a list is not a sign.
  assert.equal(said("Rewards:\n\n- 100 is the balance of a new member.\n", "- 100 is the balance of a new member.", "100"), "");

  // But a minus at the start of a line is one: with a currency sign after it, or after a line that runs on into it.
  assert.match(oneLine("-$5 is the balance after one purchase.", "5"), /sign that the text does not state plainly/);
  assert.match(oneLine("-USD 5.00 is the balance after one purchase.", "5.00"), /sign that the text does not state plainly/);
  assert.match(said("The balance after a refund is\n- 100 as it was.\n", "The balance after a refund is\n- 100 as it was.", "100"), /sign that the text does not state plainly/);
  assert.equal(said("The balance is shown.\n- 100 is what it shows.\n", "The balance is shown.\n- 100 is what it shows.", "100"), "");
  assert.equal(said("Rewards:\n\n- [ ] 100 is the balance of a new member.\n", "- [ ] 100 is the balance of a new member.", "100"), "");

  // What is above the quote is read only as far as this: the nearest heading; the lines that end with a colon in
  // the block directly above, with no empty line between; the rows above a row of a table.
  assert.equal(said("# Maximum limits\n\n## Basic plan\n\nThe balance is 100.\n", "The balance is 100.", "100"), "");
  assert.equal(said("Balance after one purchase (maximum):\n\n- Basic: 100\n", "- Basic: 100", "100"), "");
  assert.equal(said("| Plan | Max |\n|---|---|\n| Basic | 100 |\n\nThe balance is 100.\n", "The balance is 100.", "100"), "");
  assert.match(oneLine("The balance is &#8805; 100."), /markup that stands for a character/);
  assert.match(oneLine("The balance is \ue000 100."), /characters that are not seen/);
  assert.match(oneLine("The balance is\u2028100."), /characters that are not seen/);

  // Words listed before, slightly varied; and wordings that were not listed.
  for (const sentence of [
    "After a purchase the balance is at the most 100.",
    "After a purchase the balance is at the very least 100.",
    "After a purchase the balance is at\u2011least 100.",
    "After a purchase the balance tops out at 100.",
    "After a purchase the balance is as much as 100.",
    "After a purchase the balance is 100 or so.",
    "After a purchase the balance is 100 to 200.",
    "After a purchase the balance is 100 \u2013 200.",
    "After a purchase the balance is 100 or 200.",
    "The balance goes from 1.50 to 100.",
    "After a purchase the balance is 100 +/- 5.",
    "After a purchase the balance is longer than 100.",
    "The threshold is 100.",
  ]) {
    assert.match(oneLine(sentence), /words a bound/, JSON.stringify(sentence));
  }
  for (const sentence of ["After a purchase the balance isnt 100.", "After a purchase the balance isn\u2032t 100.", "The balance is anything but 100.", "The balance is 100 instead of 50.", "The balance is nonzero, 100."]) {
    assert.match(oneLine(sentence), /words a negation/, JSON.stringify(sentence));
  }
  // A change, a rate or a share is not what a page shows as one number; nor is what holds only sometimes.
  for (const sentence of ["A purchase increases the balance by 100.", "A purchase adds 100.", "The member gets 100 per purchase.", "The member gets another 100.", "The discount is 100%.", "The balance is usually 100.", "If premium, the balance is 100.", "The balance may be 100."]) {
    assert.match(oneLine(sentence), /words a change, a rate or a condition/, JSON.stringify(sentence));
  }
  assert.match(oneLine("The balance is &ge; 100."), /markup that stands for a character/);
  assert.match(oneLine("The balance is at&nbsp;least 100."), /markup that stands for a character/);

  // What is said above the quote counts: its heading, the line that introduces its list, the header of its table.
  const context = /above its quote words something other than an equality/;
  assert.match(said("Balance after one purchase (maximum):\n- Basic: 100\n- Premium: 500\n", "- Basic: 100", "100"), context);
  assert.match(said("| Plan | Max |\n|---|---|\n| Basic | 100 |\n", "| Basic | 100 |", "100"), context);
  assert.match(said("## Minimum balances\n\nAfter a purchase the balance is 100.\n", "After a purchase the balance is 100.", "100"), context);
  assert.match(said("The balance must never be:\n- Basic: 100\n", "- Basic: 100", "100"), context);
  assert.equal(said("## Balances\n\nBalance after one purchase:\n- Basic: 100\n- Premium: 500\n", "- Basic: 100", "100"), "");
  assert.equal(said("| Plan | Balance |\n|---|---|\n| Basic | 100 |\n", "| Basic | 100 |", "100"), "");
  // A full stop after an abbreviation, a colon and a semicolon do not end a sentence.
  assert.match(said("After a purchase the balance is max.\n100 for a basic account.\n", "100 for a basic account.", "100"), /begins in the middle of a sentence/);
  assert.match(said("The balance is 100;\nmore for a premium account.\n", "The balance is 100;", "100"), /ends in the middle of a sentence/);
  assert.match(said("Note the following:\nthe balance is 100.\n", "the balance is 100.", "100"), /begins in the middle of a sentence/);
  // What does end one: a question mark, an exclamation mark, a full stop inside quotes or emphasis; and a heading.
  for (const prior of ["Is it shown?", "It is shown!", "He said \"shown.\"", "It is **shown.**", "# Balance"]) assert.equal(said(`${prior}\nThe balance is 100.\n`, "The balance is 100.", "100"), "", prior);
  // An item of a list is whole even after a line that does not end a sentence.
  assert.equal(said("Balances\n- Basic: 100\n", "- Basic: 100", "100"), "");
  assert.match(said("Balances\nBasic: 100\n", "Basic: 100", "100"), /begins in the middle of a sentence/);

  // Characters that are not seen, in any plane; a blank that is not space.
  assert.match(oneLine("After a purchase the balance is n\u{e0061}ot 100."), /characters that are not seen/);
  assert.match(oneLine("After a purchase the balance is at\u2800least 100."), /characters that are not seen/);
  // A picture with its selector is not a letter of another alphabet; a mark that does not compose is.
  assert.equal(oneLine("The balance is 100 \u2714\ufe0f."), "");
  assert.match(oneLine("The balance is 100 x\u0336."), /outside the English alphabet/);

  // Characters that are not seen, a mark on a letter that is its own character, text that is not well formed.
  assert.match(oneLine("After a purchase the balance is n\u200bot 100."), /characters that are not seen/);
  assert.match(oneLine("The balance is \u00ad5 after.", "\u00ad5", "-5"), /characters that are not seen/);
  assert.match(oneLine("\ufeffThe balance is 100."), /characters that are not seen/);
  assert.match(oneLine("Le solde est de 100 apre\u0300s un achat."), /outside the English alphabet/);
  assert.match(criteriaProblems(binding({}), "The balance is 100\ud800.\n").join("\n"), /not well-formed/);

  // A refused binding is not carried out: nothing is asked of the application.
  const { baseUrl, server, ledger } = await app({});
  try {
    const record = await carryOutCheck({ browser, baseUrl, runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", binding: bound({ expected: within(purchase, "100", "200") }), criteria });
    unverified(record, "binding-refused");
    assert.match((record.refused ?? []).join("\n"), /not the number written/);
    // With no criteria text at all, nothing is carried out either.
    unverified(await carryOutCheck({ browser, baseUrl, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", binding: bound() } as unknown as Parameters<typeof carryOutCheck>[0]), "binding-refused");
    assert.deepEqual(ledger.requests, []);
    // The binding that is for its text is carried out, and verifies against the stand-in application.
    assert.equal((await carryOutCheck({ browser, baseUrl, runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", binding: bound(), criteria })).outcome, "verified");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- carried out ---------------------------------------------------------------

// The limit is for a run that hangs: it then fails, where it would otherwise never end.
describe("an approved check, carried out by the engine", { concurrency: 6, timeout: 1_500_000 }, () => {
  // ---- the positive cases ----

  test("verifies: starting state seen, write witnessed, the expected value on every final reading", async () => {
    const { record, ledger } = await check({});
    assert.equal(record.outcome, "verified");
    assert.equal(record.reason, undefined);
    assert.equal(record.contradictionSeen, false);
    assert.equal(record.expected, "100");
    // Three readings, and one more held on its page for the approved time: read at its start and at its end.
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["100", "100", "100", "100", "100"]);
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
    // Three readings over the approved time, and one more held on its page for the whole of it: read at its start and its end.
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["50", "50", "50", "50", "50"]);
    assert.ok(record.finalReadings[2]!.afterMs - record.finalReadings[0]!.afterMs >= 500);
    assert.ok(record.finalReadings[4]!.afterMs - record.finalReadings[3]!.afterMs >= 900);
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
    const key = fixtureKey(runId, forText(bound).binding);
    assert.match(key, /^rp-[0-9a-f]{24}$/);
    assert.deepEqual(ledger.bodies, [`{"key":"${key}"}`, `user-${key}`]);
    // Another run, or another binding, has another key.
    assert.notEqual(fixtureKey("22222222-2222-4222-8222-222222222222", bound), key);
    assert.notEqual(fixtureKey(runId, forText(binding({ ...bound, id: "another" })).binding), key);
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
    // A background request that is answered with an error counts like any other.
    unverified((await check({ ...page, "POST /seen": () => json({}, 500) }, binding({ background: [{ method: "POST", path: "/seen" }] }))).record, "error-answer");
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
    assert.equal(record.outcome, "failed");
    assert.deepEqual(record.finalReadings.map((entry) => entry.value), ["50", "50", "50", "50", "50"]);
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
    // Away and back again: the address is the bound one, and the answer was a redirect all the same.
    let hops = 0;
    unverified((await check({ "GET /account": (ledger) => (hops++ % 2 === 0 ? { status: 302, headers: { location: "/hop" } } : account(ledger)), "GET /hop": () => ({ status: 302, headers: { location: "/account" } }) })).record, "address-not-bound");
    unverified((await check({ "GET /account": () => ({ status: 500, body: "down" }) })).record, "error-answer");
    // A trailing slash and another letter case are other paths: this application does not serve them.
    unverified((await check({}, binding({ observation: reading("/account/", "balance"), steps: [see("count", "0"), { kind: "see", reading: reading("/account/", "balance"), expected: { from: "literal", value: "0" } }, ...BUY, see("count", "1")] }))).record, "error-answer");
    unverified((await check({}, binding({ steps: [see("count", "0", "/Account"), see("balance", "0"), ...BUY, see("count", "1", "/Account")] }))).record, "error-answer");
    // A page may change its address without loading a document only to the very address it is bound to.
    for (const rewrite of [
      `history.replaceState(null, "", "/account?shown=1")`,
      `history.pushState(null, "", "/account?")`,
      `location.hash = "#top"`,
      `history.replaceState(null, "", "/account#")`,
      `history.replaceState(null, "", "/account/")`,
      `history.replaceState(null, "", "/Account")`,
      `history.replaceState(null, "", "/other")`,
      `history.pushState(null, "", "/other"); history.replaceState(null, "", "/account")`,
      `history.pushState(null, "", "/other"); history.back()`,
      // There and back again, by a query or a fragment only: it was elsewhere.
      `history.replaceState(null, "", "/account?shown=1"); history.replaceState(null, "", "/account")`,
      `history.replaceState(null, "", "/account#top"); history.replaceState(null, "", "/account")`,
    ]) {
      unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>${rewrite}</script>`) })).record, "address-not-bound");
    }
    // A path the browser spells another way than the binding does: one navigation, and not the bound address.
    const braces = binding({ steps: [see("count", "0", "/acc{ount}"), see("balance", "0"), ...BUY, see("count", "1", "/acc{ount}")] });
    unverified((await check({ "GET /acc%7Bount%7D": (ledger) => account(ledger) }, braces)).record, "address-not-bound");
    // To that very address it may: frameworks do it as they start, and it takes the page nowhere.
    for (const harmless of [`history.replaceState(history.state, "", "/account")`, `history.replaceState({ started: true }, "", location.href)`, `history.pushState(null, "", "/account")`, `history.replaceState(null, "", location.pathname); history.replaceState(null, "", location.pathname)`]) {
      const { record } = await check({ "GET /account": (ledger) => account(ledger, `<script>${harmless}</script>`) });
      assert.equal(record.outcome, "verified", harmless);
    }
    // A page that loads itself again is another document than the one the engine opened, at the same address or not.
    const again = `<script>if (!sessionStorage.getItem("again")) { sessionStorage.setItem("again", "1"); location.reload(); }</script>`;
    unverified((await check({ "GET /account": (ledger) => account(ledger, again) })).record, "address-not-bound");
    unverified((await check({ "GET /account": (ledger) => account(ledger, again.replace("location.reload()", `location.assign("/account")`)) })).record, "address-not-bound");
    // The same holds of the page a step works in, between its opening and the step.
    const worked = (script: string) =>
      check({ "GET /buy": () => html(`<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button><script>${script}</script>`) });
    assert.equal((await worked(`history.replaceState(null, "", "/buy")`)).record.outcome, "verified");
    unverified((await worked(`history.replaceState(null, "", "/buy?step=2")`)).record, "address-not-bound");
    unverified((await worked(`setTimeout(() => history.replaceState(null, "", "/buy#late"), 50)`)).record, "address-not-bound");
    // And between two steps in one page: elsewhere and back again as the check types is seen at the next step.
    const typedInto = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "literal", text: "blue" } }, BUY[1], see("count", "1")] });
    const onInput = (script: string): Routes => ({ "GET /buy": () => html(`<input data-testid="field" oninput='${script}'><button onclick="fetch(&quot;/purchase&quot;, { method: &quot;POST&quot; })">Buy</button>`) });
    assert.equal((await check(onInput(`history.replaceState(null, "", "/buy")`), typedInto)).record.outcome, "verified");
    unverified((await check(onInput(`history.pushState(null, "", "/other"); history.replaceState(null, "", "/buy")`), typedInto)).record, "address-not-bound");
    // What the review found: a page that turns into another, or goes elsewhere, in the moment between the engine's
    // look at it and its act. The first page's button does nothing; only where the page went can the write be sent.
    for (const after of [350, 500, 650]) {
      const turned = await check({ "GET /buy": () => html(`<button>Buy</button><script>setTimeout(() => location.replace("/buy2"), ${after})</script>`), "GET /buy2": () => html(`<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`) });
      assert.equal(turned.record.outcome, "unverified", `another document after ${after} ms`);
      const moved = await check({ "GET /buy": () => html(`<button onclick="if (location.pathname === '/other') fetch('/purchase', { method: 'POST' })">Buy</button><script>setTimeout(() => history.pushState(null, "", "/other"), ${after})</script>`) });
      unverified(moved.record, "address-not-bound");
    }
    // Nor does the engine type into a page that has turned into another: what it types may be a value nobody else
    // is to have. The second page would send on whatever is typed into it; nothing is.
    const typedElsewhere = binding({
      setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' },
      steps: [{ kind: "open", path: "/enter" }, { kind: "fill", path: "/enter", locator: { by: "role", role: "textbox", name: "Name" }, value: { from: "fixture", field: "username" } }, see("count", "0"), see("balance", "0"), ...BUY, see("count", "1")],
    });
    for (const after of [300, 350, 400, 450, 500, 550, 600, 650, 700]) {
      const { record, ledger } = await check(
        {
          "POST /fixture": () => json({ username: "not-for-others" }),
          "GET /enter": () => html(`<input aria-label="Name"><script>setTimeout(() => location.replace("/enter2"), ${after})</script>`),
          "GET /enter2": () => html(`<input aria-label="Name" oninput="fetch('/taken?' + this.value)">`),
          "GET /taken": () => json({}),
        },
        typedElsewhere,
      );
      // Whenever the page turns, before the engine types, while it looks or after it has typed: nothing is ever
      // typed into the second page. (If it turns only afterwards, the typing was done in the page that was opened.)
      assert.deepEqual(ledger.requests.filter((line) => line.includes("/taken")), [], `typed into another page after ${after} ms`);
      assert.notEqual(record.outcome, "failed");
    }
    // An act that expects no write and loads its own page again: the next step is not in the page that was opened.
    const reloading = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "act", path: "/buy", locator: button("Again"), expects: { write: "none" } }, BUY[1], see("count", "1")] });
    unverified((await check({ "GET /buy": () => html(`<button onclick="location.reload()">Again</button><button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`) }, reloading)).record, "address-not-bound");
    // A document opened anew by script: the browser tells of nothing but that, and that is enough.
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>setTimeout(() => { document.open(); document.write('<p data-testid="balance">${ledger.balance}</p><p data-testid="count">${ledger.count}</p>'); document.close(); }, 50)</script>`) })).record, "address-not-bound");
    // A going back and forth between two entries of the same address is not a call of the history interface.
    unverified((await check({ "GET /account": (ledger) => account(ledger, `<script>history.pushState(null, "", "/account"); history.back();</script>`) })).record, "address-not-bound");
    // What a frame inside the page does to itself is not the page's doing.
    const framed = (inner: string) => check({ "GET /account": (ledger) => account(ledger, `<iframe src="/inner" style="width:10px;height:10px;border:0"></iframe>`), "GET /inner": () => html(`<p>inner</p><script>${inner}</script>`), "GET /inner2": () => html(`<p>inner two</p>`) });
    assert.equal((await framed(`history.pushState(null, "", "/inner?x=1")`)).record.outcome, "verified");
    assert.equal((await framed(`if (!location.search) location.replace("/inner2")`)).record.outcome, "verified");
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
      ["inside a button", (ledger) => `<button><span data-testid="balance">${ledger.balance}</span></button><p data-testid="count">${ledger.count}</p>`, "element-not-a-value"],
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
    // The page shows what was typed. Typing a value the check expects is refused outright (below); here the check
    // types another, and the page it then reads is a new one, which shows nothing of it.
    const typed = binding({
      steps: [see("count", "0"), { kind: "open", path: "/form" }, { kind: "fill", path: "/form", locator: { by: "role", role: "textbox", name: "Amount" }, value: { from: "literal", text: "7" } }, { kind: "see", reading: reading("/form", "echo"), expected: { from: "literal", value: "5" } }],
      observation: reading("/form", "echo"),
    });
    const form: Routes = { "GET /form": () => html(`<input aria-label="Amount" oninput="document.querySelector('p').textContent = this.value"><p data-testid="echo">0</p>`) };
    const { record } = await check(form, typed);
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
    // Right on every reading, and on the page that is held wrong at first and right at the end: not verified.
    let loads = 0;
    const heldWrongFirst: Routes = {
      "GET /account": (ledger) =>
        ++loads === 7
          ? html(`<p data-testid="balance">50</p><p data-testid="count">${ledger.count}</p><script>setTimeout(() => { document.querySelector("[data-testid=balance]").textContent = "100" }, 1500)</script>`)
          : account(ledger),
    };
    const held = await check(heldWrongFirst, binding({ settling: { within: 3, readings: 3 } }));
    assert.equal(held.record.outcome, "unverified");
    assert.equal(loads, 7, "the seventh page of the account was the held one");
    assert.deepEqual(held.record.finalReadings.slice(0, 3).map((entry) => entry.value), ["100", "100", "100"]);
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

  test("a request that fails in the last moments of a check is not passed over", async () => {
    // The page that is held sends a request, some time after it loads, that the server cuts off. Whenever that
    // falls, if the server was asked, the check gives no verdict.
    const cut = (after: number): Routes => ({
      "GET /account": (ledger) => html(`<p data-testid="balance">100</p><p data-testid="count">${ledger.count}</p><script>setTimeout(() => fetch("/cut").catch(() => {}), ${after})</script>`),
    });
    // The moments are close together because the stretch that matters is short: after the last time the engine
    // waits for rest, and before it gives its verdict.
    const moments = Array.from({ length: 36 }, (_unused, index) => 2000 + index * 20);
    const runs: { after: number; asked: boolean; outcome: string }[] = [];
    for (let start = 0; start < moments.length; start += 4) runs.push(...(await Promise.all(
      moments.slice(start, start + 4).map(async (after) => {
        const { baseUrl, server, ledger } = await app(cut(after));
        server.prependListener("request", (request) => {
          if (request.url === "/cut") {
            ledger.requests.push("GET /cut");
            request.socket.destroy();
          }
        });
        try {
          const record = await carry({ browser, baseUrl, runId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(after).padStart(12, "0")}`, binding: binding({ steps: [see("count", "0")] }) });
          return { after, asked: ledger.requests.includes("GET /cut"), outcome: record.outcome };
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      }),
    )));
    for (const run of runs) if (run.asked) assert.equal(run.outcome, "unverified", `cut off ${run.after} ms after the page loaded`);
    assert.ok(runs.some((run) => run.asked), "the server was asked in at least one run");
  });

  // ---- an action reaches the document the engine looked at, or nothing ----

  /** A check whose typing is the last thing done in its page: nothing later looks at that page again. */
  const typesLast = (field = "username") =>
    binding({
      setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' },
      steps: [{ kind: "open", path: "/enter" }, { kind: "fill", path: "/enter", locator: { by: "role", role: "textbox", name: "Name" }, value: { from: "fixture", field } }, see("count", "0"), see("balance", "0"), ...BUY, see("count", "1")],
    });
  /** A check with an act that sends nothing as the last thing done in its page. */
  const pressesLast = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/prep" }, { kind: "act", path: "/prep", locator: button("Prep"), expects: { write: "none" } }, ...BUY, see("count", "1")] });
  const secondPage = `<input aria-label="Name" autofocus oninput="fetch('/taken?typed=' + this.value)"><button onclick="fetch('/taken?pressed')">Prep</button>`;
  const fixture: Routes = { "POST /fixture": () => json({ username: "not-for-others" }), "GET /taken": () => json({}) };
  const taken = (ledger: Ledger) => ledger.requests.filter((line) => line.includes("/taken"));

  test("a page that turns into another as the engine looks for the element: nothing is typed into it or pressed in it", async () => {
    // The element is below the fold; the engine scrolls to it, the page hears the scrolling and turns into a second
    // document with the same field and button. That one would send on whatever is typed or pressed. Nothing is.
    const onScroll = (first: string): string => `<div style="height:3000px"></div>${first}<script>addEventListener("scroll", () => location.replace(location.pathname + "2"), { once: true })</script>`;
    const typed = await check({ ...fixture, "GET /enter": () => html(onScroll(`<input aria-label="Name">`)), "GET /enter2": () => html(`<div style="height:3000px"></div>${secondPage}`) }, typesLast());
    assert.equal(typed.record.outcome, "unverified");
    assert.deepEqual(taken(typed.ledger), [], "a value of the fixture was typed into another document");
    const pressed = await check({ ...fixture, "GET /prep": () => html(onScroll(`<button>Prep</button>`)), "GET /prep2": () => html(`<div style="height:3000px"></div>${secondPage}`) }, pressesLast);
    assert.equal(pressed.record.outcome, "unverified");
    assert.deepEqual(taken(pressed.ledger), [], "the engine pressed a button in another document");
  });

  test("a page that goes to another address as the engine acts on it gets no verdict", async () => {
    // In answer to the engine's own act, before it is done: on focus, before the text goes in, on the press.
    for (const on of ["onfocus", "onbeforeinput", "oninput"]) {
      const { record } = await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name" ${on}="history.pushState(null, '', '/other')">`) }, typesLast());
      unverified(record, "address-not-bound");
    }
    for (const on of ["onpointerdown", "onmousedown", "onmouseup", "onclick"]) {
      const { record } = await check({ "GET /prep": () => html(`<button ${on}="history.pushState(null, '', '/other')">Prep</button>`) }, pressesLast);
      unverified(record, "address-not-bound");
    }
    // An act that sends nothing and follows a link: the page is no longer the one that was opened.
    unverified((await check({ "GET /prep": () => html(`<a href="/more" role="button">Prep</a>`), "GET /more": () => html(`<p>More</p>`) }, pressesLast)).record, "address-not-bound");
    // The same acts on a page that stays where it is: carried out, and the check verifies.
    assert.equal((await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name" onfocus="this.dataset.seen = 1" oninput="this.dataset.typed = this.value">`) }, typesLast())).record.outcome, "verified");
    assert.equal((await check({ "GET /prep": () => html(`<button onmousedown="this.dataset.down = 1" onclick="this.textContent = 'Prep'">Prep</button>`) }, pressesLast)).record.outcome, "verified");
  });

  test("a page that turns into another at any moment around the engine's act: never typed into, never pressed", async () => {
    // By the clock, in small steps across the time the engine takes to look and act. Whenever the page turns, the
    // second document gets nothing; and a check in which it turned before the act gives no verdict.
    const moments = Array.from({ length: 24 }, (_unused, index) => 500 + index * 15);
    for (let start = 0; start < moments.length; start += 6) {
      await Promise.all(
        moments.slice(start, start + 6).map(async (after) => {
          const turn = `<script>setTimeout(() => location.replace(location.pathname + "2"), ${after})</script>`;
          const typed = await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name">${turn}`), "GET /enter2": () => html(secondPage) }, typesLast());
          assert.deepEqual(taken(typed.ledger), [], `typed into another document, turning after ${after} ms`);
          const pressed = await check({ ...fixture, "GET /prep": () => html(`<button>Prep</button>${turn}`), "GET /prep2": () => html(secondPage) }, pressesLast);
          assert.deepEqual(taken(pressed.ledger), [], `pressed in another document, turning after ${after} ms`);
        }),
      );
    }
  });

  test("the node the engine acts on is the one it looked at, wherever the page's script would have the act go", async () => {
    // A frame of the page holds a field of the same name and takes the focus as the engine's field gets it. Typed
    // by the keyboard, the value would go where the focus is. It goes into the field that was looked at.
    const inner = (what: string): Routes => ({ "GET /inner": () => html(what), "GET /taken": () => json({}) });
    const stolen = await check(
      { ...fixture, ...inner(`<input aria-label="Name" oninput="fetch('/taken?typed=' + this.value)">`), "GET /enter": () => html(`<input aria-label="Name" onfocus="frames[0].document.querySelector('input').focus()"><iframe src="/inner" style="width:200px;height:40px;border:0"></iframe>`) },
      typesLast(),
    );
    assert.deepEqual(taken(stolen.ledger), [], "the value was typed where the focus had been taken");
    assert.equal(stolen.record.outcome, "verified");

    // The page takes the very node out of its document as the engine acts on it: into a frame's document, on
    // focus or before the text goes in; into another window's. Nothing is typed into it there, and no verdict.
    for (const on of ["onfocus", "onbeforeinput"]) {
      const moved = await check(
        { ...fixture, ...inner(`<p>inner</p><script>document.addEventListener("beforeinput", (event) => fetch("/taken?about=" + event.data)); document.addEventListener("input", (event) => fetch("/taken?typed=" + event.target.value)); document.addEventListener("change", (event) => fetch("/taken?changed=" + event.target.value))</script>`), "GET /enter": () => html(`<iframe src="/inner" style="width:200px;height:40px;border:0"></iframe><input aria-label="Name" ${on}="frames[0].document.body.appendChild(this)">`) },
        typesLast(),
      );
      unverified(moved.record, "address-not-bound");
      assert.deepEqual(taken(moved.ledger), [], `typed into a frame's document, moved ${on}`);
    }
    // Moved as the text arrives: what was typed is taken back before the other document is told of anything.
    const late = await check(
      { ...fixture, ...inner(`<p>inner</p><script>document.addEventListener("change", (event) => fetch("/taken?changed=" + event.target.value))</script>`), "GET /enter": () => html(`<iframe src="/inner" style="width:200px;height:40px;border:0"></iframe><input aria-label="Name" oninput="frames[0].document.body.appendChild(this)">`) },
      typesLast(),
    );
    unverified(late.record, "address-not-bound");
    assert.deepEqual(taken(late.ledger), []);
    // The same of a press: the button is taken into the frame's document as it is pressed, and is not clicked there.
    const pressedElsewhere = await check(
      { ...inner(`<p>inner</p><script>document.addEventListener("click", () => fetch("/taken?pressed"))</script>`), "GET /prep": () => html(`<iframe src="/inner" style="width:200px;height:40px;border:0"></iframe><button onpointerdown="frames[0].document.body.appendChild(this)">Prep</button>`) },
      pressesLast,
    );
    unverified(pressedElsewhere.record, "address-not-bound");
    assert.deepEqual(taken(pressedElsewhere.ledger), [], "the engine clicked in a frame's document");

    // A document put in the page's place through a script address, as the engine acts: on focus, and on the press.
    const swap = `location.href = 'javascript:&quot;<input aria-label=Name><button>Prep</button>&quot;'`;
    unverified((await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name" onfocus="${swap}">`) }, typesLast())).record, "address-not-bound");
    unverified((await check({ "GET /prep": () => html(`<button onclick="${swap}">Prep</button>`) }, pressesLast)).record, "address-not-bound");
  });

  test("an element that cannot be acted on yet is not waited for while the page turns into another", async () => {
    // The original failure, with no clock to hit: the element is there and disabled, so an act that waits for it
    // to be usable waits; the page turns into a second one whose element is usable; and the waiting act lands
    // there. The engine acts on the node it looked at, at once, or not at all.
    const turns = (first: string): Routes => ({ ...fixture, "GET /enter": () => html(`${first}<script>addEventListener("load", () => setTimeout(() => location.replace("/second"), 2500))</script>`), "GET /prep": () => html(`${first}<script>addEventListener("load", () => setTimeout(() => location.replace("/second"), 2500))</script>`), "GET /second": () => html(secondPage) });
    const typed = await check(turns(`<input aria-label="Name" disabled>`), typesLast());
    assert.equal(typed.record.outcome, "unverified");
    assert.deepEqual(taken(typed.ledger), [], "a fixture's value was typed into the page it turned into");
    const pressed = await check(turns(`<button disabled>Prep</button>`), pressesLast);
    assert.equal(pressed.record.outcome, "unverified");
    assert.deepEqual(taken(pressed.ledger), [], "the engine pressed in the page it turned into");
    // Typing opens no other page.
    unverified((await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name" onfocus="window.open('/more')">`), "GET /more": () => html(`<p>More</p>`) }, typesLast())).record, "address-not-bound");
  });

  test("the engine does not do what a person could not", async () => {
    // A button a person cannot press: disabled by what it stands in, or taking no clicks.
    unverified((await check({ "GET /prep": () => html(`<fieldset disabled><button>Prep</button></fieldset>`) }, pressesLast)).record, "step-not-done");
    unverified((await check({ "GET /prep": () => html(`<button style="pointer-events:none">Prep</button>`) }, pressesLast)).record, "step-not-done");
    unverified((await check({ "GET /prep": () => html(`<button onpointerdown="this.disabled = true">Prep</button>`) }, pressesLast)).record, "step-not-done");
    // A field that takes fewer letters than the text has.
    unverified((await check({ ...fixture, "GET /enter": () => html(`<input aria-label="Name" maxlength="3">`) }, typesLast())).record, "step-not-done");
    // A field that turns into one that holds a secret as it is typed into: a literal is not typed into it.
    const literal = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "literal", text: "hunter2" } }, BUY[1], see("count", "1")] });
    const turning = await check({ "GET /buy": () => html(`<input data-testid="field" onfocus="this.type = 'password'" oninput="fetch('/taken?typed=' + this.value)"><button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`), "GET /taken": () => json({}) }, literal);
    unverified(turning.record, "secret-field-literal");
    assert.deepEqual(taken(turning.ledger), []);
    // An act that sends nothing and opens another window: the page has not stayed by itself.
    unverified((await check({ "GET /prep": () => html(`<a href="/more" target="_blank" role="button">Prep</a>`), "GET /more": () => html(`<p>More</p>`) }, pressesLast)).record, "address-not-bound");
  });

  test("a write is the page's own by what the browser says of it, not by when it was heard of", async () => {
    const buys = (onclick: string, extra = ""): Routes => ({ "GET /buy": () => html(`<button onclick="${onclick}">Buy</button>${extra}`) });
    const post = `fetch('/purchase', { method: 'POST' })`;
    // An ordinary page that sends and then moves on in one handler: the write was sent from the bound address.
    assert.equal((await check(buys(`${post}; history.pushState(null, '', '/thanks')`))).record.outcome, "verified");
    assert.equal((await check(buys(`navigator.sendBeacon('/purchase', 'x')`))).record.outcome, "verified");
    // A form that is sent: the request is the navigation itself, from the page that was opened.
    assert.equal((await check({ "GET /buy": () => html(`<form method="post" action="/purchase"><button>Buy</button></form>`), "POST /purchase": (ledger) => ((ledger.balance += 100), (ledger.count += 1), { status: 303, headers: { location: "/account" } }) })).record.outcome, "verified");
    // Moved first and sent from the other address; sent by the page it turned into; sent from a frame; from a worker.
    const notThePages: [string, Routes][] = [
      ["moved, then sent", buys(`history.pushState(null, '', '/other'); ${post}`)],
      ["sent by the page it turned into", { ...buys(`location.replace('/buy2')`), "GET /buy2": () => html(`<script>${post}</script>`) }],
      ["sent from a frame", { ...buys(`frames[0].postMessage('send', '*')`, `<iframe src="/inner" style="width:10px;height:10px;border:0"></iframe>`), "GET /inner": () => html(`<script>addEventListener("message", () => ${post})</script>`) }],
      ["sent from a worker", { ...buys(`new Worker('/worker.js')`), "GET /worker.js": () => ({ headers: { "content-type": "text/javascript" }, body: `fetch("/purchase", { method: "POST" })` }) }],
    ];
    notThePages.push(
      // A form is sent into the page by a frame of it, or after the page has been elsewhere, there and back included.
      ["a form sent into the page by a frame", { ...buys(`frames[0].postMessage('send', '*')`, `<iframe src="/inner" style="width:10px;height:10px;border:0"></iframe>`), "GET /inner": () => html(`<form method="post" action="/purchase" target="_top"></form><script>addEventListener("message", () => document.forms[0].submit())</script>`), "POST /purchase": (ledger) => ((ledger.balance += 100), (ledger.count += 1), { status: 303, headers: { location: "/account" } }) }],
      ["moved, then a form sent", { ...buys(`history.pushState(null, '', '/other'); document.forms[0].submit()`, `<form method="post" action="/purchase"></form>`), "POST /purchase": (ledger) => ((ledger.balance += 100), (ledger.count += 1), { status: 303, headers: { location: "/account" } }) }],
      ["moved and back, then sent", buys(`history.pushState(null, '', '/other'); history.replaceState(null, '', '/buy'); ${post}`)],
      ["its document opened anew, then sent", buys(`document.open(); document.write('<p>new</p>'); document.close(); ${post}`)],
    );
    // A frame or a window made as the engine presses, which sends a form into the page; left there, or taken away
    // again at once. It was not there when the act began, and has been there all the same.
    const sends = (ledger: Ledger) => ((ledger.balance += 100), (ledger.count += 1), { status: 303, headers: { location: "/account" } });
    const madeFrame = `const f = document.createElement('iframe'); document.body.appendChild(f); const d = f.contentDocument; d.body.innerHTML = '<form method=post action=/purchase target=_top></form>'; d.forms[0].submit()`;
    notThePages.push(
      ["a form sent by a frame made in the press", { ...buys(madeFrame), "POST /purchase": sends }],
      ["a form sent by a frame made in the press and taken away", { ...buys(`${madeFrame}; f.remove()`), "POST /purchase": sends }],
      ["a form sent by a window made in the press", { ...buys(`window.name = 'main'; const w = window.open('about:blank'); w.document.body.innerHTML = '<form method=post action=/purchase target=main></form>'; w.document.forms[0].submit(); w.close()`), "POST /purchase": sends }],
    );
    for (const [name, routes] of notThePages) {
      const { record } = await check(routes);
      assert.equal(record.outcome, "unverified", name);
      // Not attributed; or, where the page's own act took its element away with the document, not the bound page.
      assert.ok(record.reason === "write-not-attributed" || (name === "its document opened anew, then sent" && record.reason === "address-not-bound"), `${name}: ${record.reason}`);
    }
    // A document put in the page's place through a script address, which the browser tells of in no other way.
    const swapped = await check(buys(`location.href = 'javascript:&quot;<script>${post.replaceAll("'", "\\'")}<\\/script>&quot;'`));
    assert.equal(swapped.record.outcome, "unverified");
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
    const carried = binding({ ...withFixture("username"), steps: [see("cookies", "0"), see("count", "0"), see("balance", "0"), ...BUY, see("count", "1")] });
    const cookiePage: Routes = { "POST /fixture": () => ({ headers: { "content-type": "application/json", "set-cookie": "who=fixture; Path=/" }, body: '{"username":"x"}' }), "GET /account": (ledger) => account(ledger, `<p data-testid="cookies"></p><script>document.querySelector("[data-testid=cookies]").textContent = document.cookie.includes("who=") ? "1" : "0"</script>`) };
    assert.equal((await check(cookiePage, carried)).record.outcome, "verified");
  });

  test("an application that ignores the engine's key, run twice: the second run's starting state is not met", async () => {
    const { baseUrl, server, ledger } = await app({ "POST /fixture": () => json({ username: "shared" }) });
    try {
      const bound = binding({ setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' } });
      const first = await carry({ browser, baseUrl, runId: "33333333-3333-4333-8333-333333333333", binding: bound });
      assert.equal(first.outcome, "verified");
      const second = await carry({ browser, baseUrl, runId: "44444444-4444-4444-8444-444444444444", binding: bound });
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
    // The page counts its own visits in the browser's storage, and shows how many came before this one.
    const page: Routes = {
      "GET /account": (ledger) =>
        account(ledger, `<p data-testid="visits"></p><p data-testid="hour"></p><script>
          const visits = Number(localStorage.getItem("visits") ?? "0");
          localStorage.setItem("visits", String(visits + 1));
          document.querySelector("[data-testid=visits]").textContent = String(visits);
          document.querySelector("[data-testid=hour]").textContent = String(new Date(Date.UTC(2026, 0, 1, 12)).getHours()) + (navigator.language === "ja-JP" ? "" : "?");
        </script>`),
    };
    const fresh = binding({ steps: [see("visits", "0")], observation: reading("/account", "hour"), expected: { start: 0, end: 2, value: "21" }, locale: "ja-JP", timezone: "Asia/Tokyo" });
    const { baseUrl, server } = await app(page);
    try {
      // Twice against one application: the second check begins with nothing stored, as the first did.
      for (const runId of ["77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"]) {
        assert.equal((await carry({ browser, baseUrl, runId, binding: fresh })).outcome, "verified");
      }
      // Within one check, what the application stores stays: the second page of a check is its second visit.
      unverified(await carry({ browser, baseUrl, runId: "99999999-9999-4999-8999-999999999999", binding: binding({ ...fresh, steps: [see("visits", "0"), see("visits", "0")] }) }), "condition-not-met");
      // In another time zone the hour is another.
      assert.equal((await carry({ browser, baseUrl, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", binding: binding({ ...fresh, timezone: "Europe/London" }) })).outcome, "failed");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // A time zone the browser does not know: the check cannot be set up.
    unverified((await check(page, binding({ ...fresh, timezone: "Nowhere/Never" }))).record, "setup-failed");
  });

  // ---- what the first security review found ----

  /** "The balance is 100", with nothing written: a starting state, and the observation. */
  const plainCheck = (change: Partial<Draft> = {}) => binding({ steps: [see("count", "0")], ...change });
  const shows = (body: string): Routes => ({ "GET /account": (ledger) => html(`${body}<p data-testid="count" style="margin-top:200px">${ledger.count}</p>`) });

  test("a value that is in the element and is not what a person sees is not displayed", async () => {
    const cases: [string, string][] = [
      ["a panel over the digits, short of the centre of the box", `<p data-testid="balance">100</p><div style="position:fixed;left:0;top:0;width:300px;height:60px;background:white">555</div>`],
      ["a cover that ends just before the centre", `<p data-testid="balance" style="margin:0">100</p><div style="position:fixed;left:0;top:0;width:630px;height:40px;background:white"></div>`],
      ["an ancestor that clips the text away", `<div style="overflow:hidden;height:30px"><p data-testid="balance" style="margin:0;height:30px;padding-left:1300px;white-space:nowrap">100</p></div>`],
      ["all but transparent", `<p data-testid="balance" style="opacity:0.004">100</p>`],
      ["transparent by a filter", `<p data-testid="balance" style="filter:opacity(0)">100</p>`],
      ["transparent by a mask", `<p data-testid="balance" style="-webkit-mask-image:linear-gradient(transparent,transparent);mask-image:linear-gradient(transparent,transparent)">100</p>`],
      ["clipped to nothing", `<p data-testid="balance" style="clip-path:inset(50%)">100</p>`],
      ["text without colour", `<p data-testid="balance" style="color:transparent">100</p>`],
      ["text without size", `<p data-testid="balance" style="font-size:0;height:20px">100</p>`],
      ["text too small to read", `<p data-testid="balance" style="font-size:3px;height:20px">100</p>`],
      ["text moved off the screen", `<p data-testid="balance" style="text-indent:-9999px">100</p>`],
      ["scaled to nothing", `<p data-testid="balance" style="transform:scale(0.01)">100</p>`],
      ["digits that are there and not seen", `<p data-testid="balance">1<span style="opacity:0">00</span></p>`],
      ["digits without colour", `<p data-testid="balance">1<span style="color:rgba(0,0,0,0)">00</span></p>`],
      ["digits read in the other direction", `<p data-testid="balance" style="direction:rtl;unicode-bidi:bidi-override">001</p>`],
      ["text a style sheet adds", `<style>[data-testid=balance]::before { content: "9" }</style><p data-testid="balance">100</p>`],
      ["a slot inside something transparent", `<div id="host"><p data-testid="balance">100</p></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<div style="opacity:0"><slot></slot></div>'</script>`],
      // A frame laid over the element, holding a node at the same place in its own document.
      ["a frame over it", `<p data-testid="balance" style="margin:0;height:40px">100</p><iframe style="position:fixed;left:0;top:0;width:1280px;height:40px;border:0;background:white" srcdoc="<html><head></head><body style='margin:0'><p style='margin:0;height:40px'>555</p></body></html>"></iframe>`],
    ];
    const more: [string, string][] = [
      // What the second review found.
      ["direction overridden on an ancestor", `<p data-testid="balance" style="direction:rtl;unicode-bidi:bidi-override"><span>100</span></p>`],
      ["direction overridden by an element", `<bdo dir="rtl"><span data-testid="balance">100</span></bdo>`],
      ["direction overridden by a character", `<div>&#x202e;<span data-testid="balance">100</span></div>`],
      ["digits drawn in another sequence, right to left", `<p dir="rtl" data-testid="balance"><span style="display:inline-block">1</span><span style="display:inline-block">00</span></p>`],
      ["digits drawn in another sequence, moved", `<p data-testid="balance" style="font:20px monospace"><span style="position:relative;left:2ch">1</span><span style="position:relative;left:-1ch">00</span></p>`],
      ["a tree of its own that adds a digit", `<p data-testid="balance">100</p><script>document.querySelector("[data-testid=balance]").attachShadow({ mode: "open" }).innerHTML = "<span>9</span><slot></slot>"</script>`],
      ["a closed tree of its own that adds a digit", `<p data-testid="balance">100</p><script>document.querySelector("[data-testid=balance]").attachShadow({ mode: "closed" }).innerHTML = "<slot></slot><span>5</span>"</script>`],
      ["a field inside it", `<p data-testid="balance">1<input value="55" size="2">00</p>`],
      ["a marker before it", `<ol><li data-testid="balance">100</li></ol>`],
      ["a colour the engine cannot read", `<p data-testid="balance" style="color:color(srgb 0 0 0 / 0)">100</p>`],
      ["a colour the engine cannot read, another", `<p data-testid="balance" style="color:oklch(0 0 0 / 0)">100</p>`],
      ["a first letter without colour", `<style>[data-testid=balance]::first-letter { color: transparent }</style><p data-testid="balance">100</p>`],
      ["a first line without colour", `<style>.card::first-line { color: transparent }</style><div class="card"><span data-testid="balance">100</span></div>`],
      ["squeezed sideways", `<p data-testid="balance" style="font-size:30px;transform:scaleX(0.06);transform-origin:left">100</p>`],
      ["digits on top of each other", `<p data-testid="balance" style="letter-spacing:-0.58em">100</p>`],
      ["blended away", `<p data-testid="balance" style="mix-blend-mode:difference;color:black">100</p>`],
      // What the third review found.
      ["something of its own painted over its digits", `<p data-testid="balance" style="position:relative;margin:0">100<span style="position:absolute;left:0;top:0;width:2ch;height:100%;background:white"></span></p>`],
      ["a cover of its own, as while loading", `<p data-testid="balance" style="position:relative;margin:0">100<span style="position:absolute;inset:0;background:#ddd"></span></p>`],
      ["a second copy drawn as a shadow", `<p data-testid="balance" style="text-shadow:3ch 0 0 #000">100</p>`],
      ["a second copy drawn as a reflection", `<p data-testid="balance" style="display:inline-block;-webkit-box-reflect:right">100</p>`],
      ["set large and scaled to nothing", `<p data-testid="balance" style="font-size:20px;transform:scale(0.3);transform-origin:left top">100</p>`],
      ["a strip over part of a digit", `<p data-testid="balance" style="margin:0;font:40px monospace">100</p><div style="position:fixed;left:26px;top:0;width:8px;height:50px;background:white"></div>`],
      ["a small thing over one digit", `<p data-testid="balance" style="margin:0;font:40px monospace">100</p><div style="position:fixed;left:24px;top:0;width:24px;height:50px;background:white;font:40px monospace">9</div>`],
    ];
    for (const [name, body] of [...cases, ...more]) {
      const { record } = await check(shows(body), plainCheck());
      assert.equal(record.outcome, "unverified", `${name}: ended ${record.outcome}`);
      assert.equal(record.reason, "element-not-displayed", name);
    }
    // And the plain case, and digits in parts that are all seen: verified.
    assert.equal((await check(shows(`<p data-testid="balance">100</p>`), plainCheck())).record.outcome, "verified");
    assert.equal((await check(shows(`<p data-testid="balance"><b>1</b><i>00</i></p>`), plainCheck())).record.outcome, "verified");
    // Ordinary pages: a cell of a table, a card, a number that wraps, a sign beside it.
    for (const body of [
      `<table><tr><th>Balance</th><td data-testid="balance">100</td></tr></table>`,
      `<div style="display:flex;gap:8px;padding:12px;border-radius:8px;box-shadow:0 1px 4px #0003"><span>Balance</span><strong data-testid="balance" style="font-size:11px">100</strong></div>`,
      `<div style="margin-top:20px;transform:translateX(20px) scale(1.1);transform-origin:left"><output data-testid="balance">100</output></div>`,
      `<header style="position:sticky;top:0;height:50px;background:#eee">Site</header><p data-testid="balance" style="text-align:right">100</p>`,
    ]) {
      assert.equal((await check(shows(body), plainCheck())).record.outcome, "verified", body);
    }
  });

  test("a value the page draws only after a while is not a failure: the last reading is held for the approved time", async () => {
    // A placeholder first, the value a second and a half later. Read at once, every page shows the placeholder.
    const late: Routes = { "GET /account": (ledger) => html(`<p data-testid="balance">0</p><p data-testid="count">${ledger.count}</p><script>setTimeout(() => { document.querySelector("[data-testid=balance]").textContent = "${ledger.balance}" }, 1500)</script>`) };
    const { record } = await check(late, binding({ settling: { within: 3, readings: 3 } }));
    // Which reading meets the moment the value is drawn depends on the machine: none of them makes a failure.
    assert.equal(record.outcome, "unverified");
    assert.ok(record.reason === "final-readings-disagree" || record.reason === "page-not-at-rest", record.reason);
    // A value that changes while it is being read is not at rest.
    const flicker = shows(`<p data-testid="balance">100</p><script>let n = 100; setInterval(() => { document.querySelector("[data-testid=balance]").textContent = String(n++) }, 100)</script>`);
    unverified((await check(flicker, plainCheck())).record, "page-not-at-rest");
  });

  test("an answer of the application that sends the browser to another host stops the check", async () => {
    // The engine cannot block where an answer sends the browser: it sees it, and the check says nothing.
    const other = await app({ "GET /balance": () => ({ status: 503, body: "" }) });
    try {
      const sent: Routes = { "GET /account": (ledger) => html(`<p data-testid="balance">0</p><p data-testid="count">${ledger.count}</p><script>fetch("/data").then(() => {}).catch(() => {})</script>`), "GET /data": () => ({ status: 302, headers: { location: `${other.baseUrl}/balance` } }) };
      // The check stops. Its reason is the redirect, unless the browser tells of the failed request without ever
      // saying where it had been sent on, as it sometimes does: then it is a failed request, which it also is.
      const { record } = await check(sent);
      assert.equal(record.outcome, "unverified");
      assert.ok(record.reason === "redirect-to-other-host" || record.reason === "request-failed", record.reason);
      // An answer that sends the bound page itself elsewhere is seen as the answer it is.
      unverified((await check({ "GET /account": () => ({ status: 302, headers: { location: `${other.baseUrl}/balance` } }) })).record, "redirect-to-other-host");
    } finally {
      other.server.closeAllConnections();
      await new Promise((resolve) => other.server.close(resolve));
    }
  });

  test("a contradiction on a page the engine kept from another host is not a failure", async () => {
    const elsewhere: Routes = { "GET /account": (ledger) => html(`<p data-testid="balance">0</p><p data-testid="count">${ledger.count}</p><script>fetch("http://data.other.invalid/balance").then(() => {}).catch(() => {})</script>`) };
    const { record } = await check(elsewhere);
    unverified(record, "other-host-blocked");
    assert.equal(record.contradictionSeen, true);
    unverified((await check({ "GET /account": (ledger) => html(`<p data-testid="balance">0</p><p data-testid="count">${ledger.count}</p><script src="http://cdn.other.invalid/render.js"></script>`) })).record, "other-host-blocked");
  });

  test("a page sends nothing as the engine leaves it, and a page that meant to do something then gets no verdict", async () => {
    // Such a request is shown to nobody by the browser. The engine switches the page's script off before it closes
    // the page, so none is sent. But then the page did not do what it meant to: the check ends without a verdict.
    const leaving = (script: string, frame = false): Routes => ({ "GET /account": (ledger) => account(ledger, frame ? `<iframe srcdoc="<script>${script.replaceAll('"', "&quot;")}</script>"></iframe>` : `<script>${script}</script>`), "POST /hit": () => json({}) });
    for (const script of [
      `addEventListener("pagehide", () => navigator.sendBeacon("/hit", "x"))`,
      `document.addEventListener("visibilitychange", () => navigator.sendBeacon("/hit", "x"))`,
      `addEventListener("pagehide", () => fetch("/hit", { method: "POST", keepalive: true }))`,
      `addEventListener("unload", () => navigator.sendBeacon("/hit", "x"))`,
      `window.onpagehide = () => { navigator.sendBeacon("/hit", "x") }`,
    ]) {
      for (const frame of [false, true]) {
        const { record, ledger } = await check(leaving(script, frame));
        unverified(record, "leave-script-suppressed");
        assert.deepEqual(ledger.requests.filter((line) => line.startsWith("POST /hit")), [], script);
      }
    }
    // A purchase the page only commits on being left would never be made: no failure is reported for it.
    const commitOnLeave = await check({ "GET /buy": () => html(`<button onclick="fetch('/purchase', { method: 'POST' })">Buy</button><script>addEventListener("pagehide", () => navigator.sendBeacon("/commit"))</script>`), "POST /purchase": (ledger) => ((ledger.count += 1), json({})), "POST /commit": (ledger) => ((ledger.balance += 100), json({})) });
    unverified(commitOnLeave.record, "leave-script-suppressed");
    assert.equal(commitOnLeave.record.contradictionSeen, true);
    // A request put by for the browser to send when the page is gone: there is no such thing to be had.
    const deferred = await check({ "GET /account": (ledger) => account(ledger, `<script>if (window.fetchLater) fetchLater("/hit", { method: "POST", activateAfter: 600000 })</script>`), "POST /hit": () => json({}) });
    assert.equal(deferred.record.outcome, "verified");
    assert.deepEqual(deferred.ledger.requests.filter((line) => line.startsWith("POST /hit")), []);
    // A page with a sandboxed frame gets no verdict. Today that is for a reason of the engine's own (with service
    // workers blocked, the browser library's script fails in such a frame, and that counts as an error of the
    // page), so this does not reach the rule for a frame that cannot be asked: no test does yet.
    assert.equal((await check({ "GET /account": (ledger) => account(ledger, `<iframe sandbox="allow-scripts" srcdoc="<script>addEventListener('pagehide', () => {})</script>"></iframe>`) })).record.outcome, "unverified");
    // A page the application opened itself is closed by the engine like its own, and asked the same.
    const opener = await check({ "GET /buy": () => html(`<button onclick="window.open('/receipt'); fetch('/purchase', { method: 'POST' })">Buy</button>`), "GET /receipt": () => html(`<p>Thank you</p><script>addEventListener("pagehide", () => navigator.sendBeacon("/hit", "x"))</script>`), "POST /hit": () => json({}) });
    unverified(opener.record, "leave-script-suppressed");
    assert.deepEqual(opener.ledger.requests.filter((line) => line.startsWith("POST /hit")), []);
    // Listeners for other things are nobody's business.
    assert.equal((await check({ "GET /account": (ledger) => account(ledger, `<script>addEventListener("click", () => {}); addEventListener("pageshow", () => {}); addEventListener("beforeunload", () => {})</script>`) })).record.outcome, "verified");
    const shared = await check(leaving(`new SharedWorker(URL.createObjectURL(new Blob(['fetch("' + location.origin + '/hit", { method: "POST" })'], { type: "text/javascript" })))`));
    assert.equal(shared.record.outcome, "unverified");
    assert.deepEqual(shared.ledger.requests.filter((line) => line.startsWith("POST /hit")), [], "no request the engine could not see was sent");
  });

  test("a check does not type a value it expects to read, in any obvious spelling", async () => {
    const typing = (text: string, change: Partial<Draft> = {}) =>
      binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "literal", text } }, BUY[1], see("count", "1")], ...change });
    for (const text of ["100", "1", "amount 100", "1,00", "100.00", "-100", "1.00", "0100", "100px", "x100", "+100"]) assert.match(checkProblems(typing(text)).join("\n"), /types a value that the check expects to read/, text);
    // Digits of another script are refused as such.
    for (const text of ["\uff11\uff10\uff10", "\u0661\u0660\u0660"]) assert.match(checkProblems(typing(text)).join("\n"), /digits that are not the plain ones/, text);
    // Typed in two steps and put together by the application.
    const inTwo = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("a"), value: { from: "literal", text: "10" } }, { kind: "fill", path: "/buy", locator: testid("b"), value: { from: "literal", text: "0" } }, BUY[1], see("count", "1")] });
    assert.match(checkProblems(inTwo).join("\n"), /types a value that the check expects to read/);
    // A value that only a later condition expects, and the final value could not be a spelling of.
    const laterOnly = binding({ steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "literal", text: "7" } }, BUY[1], see("count", "7")], expected: { start: 0, end: 3, value: "250" } });
    assert.match(checkProblems(laterOnly).join("\n"), /types a value that the check expects to read/);
    // A starting state that was read before the value was typed is not read after it: nought may be typed.
    assert.deepEqual(checkProblems(typing("0")), []);
    // 24.99 expected: typed as hundredths, or with a sign, it is the same amount.
    const priced = { observation: reading("/account", "price", "currency-units", "amount"), expected: { start: 0, end: 5, value: "24.99" } } as const;
    for (const text of ["24.99", "2499", "$24.99", "24"]) assert.match(checkProblems(typing(text, priced)).join("\n"), /types a value that the check expects to read/, text);
    for (const text of ["7", "blue", "1000", "2024-12-25", "10"]) assert.deepEqual(checkProblems(typing(text)), [], text);
    unverified((await check({}, typing("100"))).record, "binding-refused");
    // A value from a fixture's answer is only known when the check runs: the same rule, then.
    const fromFixture = binding({
      setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' },
      steps: [see("count", "0"), see("balance", "0"), { kind: "open", path: "/buy" }, { kind: "fill", path: "/buy", locator: testid("field"), value: { from: "fixture", field: "amount" } }, BUY[1], see("count", "1")],
    });
    const buyPage = (): Answer => html(`<input data-testid="field"><button onclick="fetch('/purchase', { method: 'POST' })">Buy</button>`);
    unverified((await check({ "GET /buy": buyPage, "POST /fixture": () => json({ amount: 100 }) }, fromFixture)).record, "typed-value-is-expected");
    assert.equal((await check({ "GET /buy": buyPage, "POST /fixture": () => json({ amount: "seven" }) }, fromFixture)).record.outcome, "verified");
  });

  test("the settling time is the binding's: readings run to its end, counted from the last write, and conditions wait only after a write", async () => {
    // A journey far shorter than the approved time: the last reading still waits for all of it. Twelve seconds,
    // so that readings made one after the other, with no waiting, would be done long before.
    const slow = binding({ settling: { within: 12, readings: 3 } });
    const { record } = await check({}, slow);
    assert.equal(record.outcome, "verified");
    const [first, middle, last] = record.finalReadings;
    assert.ok(record.lastWriteAfterMs !== undefined);
    assert.ok(last!.afterMs - record.lastWriteAfterMs! >= 12_000, `the last reading came ${last!.afterMs - record.lastWriteAfterMs!} ms after the write`);
    assert.ok(first!.afterMs - record.lastWriteAfterMs! < 5_000, "the first reading is made at once");
    const midway = (first!.afterMs + last!.afterMs) / 2;
    assert.ok(Math.abs(middle!.afterMs - midway) < 1_500, `the middle reading came ${middle!.afterMs - midway} ms from midway`);
    // With no write, the time is counted from the first step.
    const still = await check({ "GET /account": (ledger) => html(`<p data-testid="balance">100</p><p data-testid="count">${ledger.count}</p>`) }, binding({ steps: [see("count", "0")], settling: { within: 4, readings: 3 } }));
    assert.equal(still.record.outcome, "verified");
    assert.equal(still.record.lastWriteAfterMs, undefined);
    assert.ok(still.record.finalReadings[2]!.afterMs >= 4_000);
    // A wrong value that turns right at four fifths of the approved time is not a failure.
    const turning = await check(
      {
        "POST /purchase": (ledger) => {
          ledger.count += 1;
          ledger.balance += 50;
          setTimeout(() => (ledger.balance += 50), 3_200);
          return json({});
        },
      },
      binding({ settling: { within: 4, readings: 3 } }),
    );
    assert.notEqual(turning.record.outcome, "failed");
    // A witness that shows late, within the approved time: waited for. Later than that: a condition unmet.
    const lateWitness = (ms: number): Routes => ({
      "POST /purchase": (ledger) => {
        ledger.balance += 100;
        setTimeout(() => (ledger.count += 1), ms);
        return json({});
      },
    });
    assert.equal((await check(lateWitness(1_500), binding({ settling: { within: 4, readings: 3 } }))).record.outcome, "verified");
    unverified((await check(lateWitness(4_000), binding({ settling: { within: 1, readings: 3 } }))).record, "condition-not-met");
    // A starting state that is wrong at first and right a moment later: before any write there is nothing to wait for.
    let loads = 0;
    const settlingStart = await check({ "GET /account": (ledger) => html(`<p data-testid="balance">${ledger.balance}</p><p data-testid="count">${loads++ === 0 ? 9 : ledger.count}</p>`) }, binding({ settling: { within: 5, readings: 3 } }));
    unverified(settlingStart.record, "condition-not-met");
    assert.equal(loads, 1, "the condition was read once");
  });

  test("a page that keeps the browser busy does not keep the check: it is given up at its limit, and nothing is left open", async () => {
    const started = Date.now();
    const busy = shows(`<p data-testid="balance">100</p><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 350))</script>`);
    const { record } = await check(busy, plainCheck(), { limitMs: 4_000 });
    unverified(record, "time-ran-out");
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  });

  test("a fixture answer that never ends is not kept, and a check that cannot be set up asks nothing of the application", async () => {
    const { baseUrl, server, ledger } = await app({});
    server.removeAllListeners("request");
    let sent = 0;
    server.on("request", (request, response) => {
      ledger.requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      const more = () => {
        while (!response.destroyed && response.write(" ".repeat(65_536))) sent += 65_536;
        if (!response.destroyed) sent += 65_536;
      };
      response.on("drain", more);
      more();
    });
    try {
      const withFixture = binding({ setup: { kind: "fixture", method: "POST", path: "/fixture", body: '{"key":"{{key}}"}' } });
      const started = Date.now();
      unverified(await carry({ browser, baseUrl, runId: "55555555-5555-4555-8555-555555555555", binding: withFixture }), "setup-failed");
      assert.ok(Date.now() - started < 5_000, "the answer was given up as soon as it was too long");
      assert.ok(sent < 20_000_000, `${sent} bytes were taken`);
      // A time zone that is not one: refused before the fixture is called.
      ledger.requests.length = 0;
      unverified(await carry({ browser, baseUrl, runId: "66666666-6666-4666-8666-666666666666", binding: binding({ ...withFixture, timezone: "Nowhere/Never" }) }), "setup-failed");
      assert.deepEqual(ledger.requests, []);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---- the locks -----------------------------------------------------------------

test("no check leaves a browser context open", () => {
  assert.equal(browser.contexts().length, 0);
});

test("the runner is used by no run, and no source writes a trusted result", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const src = path.join(root, "packages", "agent", "src");
  const runner = path.join(src, "remote", "check.ts");
  // What the runner hands out, by name. A new name is a new way in: it is added here, on purpose, or not at all.
  const exported = [...(await readFile(runner, "utf8")).matchAll(/^export\s+(?:async\s+)?[a-z]+\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!).sort();
  assert.equal(exported.length, [...(await readFile(runner, "utf8")).matchAll(/^export\b/gm)].length, "every export of the runner is one this test can name");
  assert.deepEqual(exported, ["CHECK_LIMITS", "CheckOptions", "CheckRecord", "FinalReading", "UNVERIFIED_REASONS", "UnverifiedReason", "carryOutCheck", "checkProblems", "criteriaProblems", "defaultLimitMs", "expectedInUnit", "fixtureKey", "readStrictNumber"]);
  assert.doesNotMatch(await readFile(runner, "utf8"), /^export \{|^export \*|^export default/m, "the runner hands nothing out under another name");
  const refers = new RegExp(`/check(\\.[cm]?[jt]s)?["'\`]|\\b(?:${exported.join("|")})\\b`);
  // Every place code lives, not only the engine's own source: nothing anywhere calls the runner but its tests.
  const files: string[] = [];
  for (const file of await readdir(root, { recursive: true })) {
    const parts = file.split(path.sep);
    if (/\.(?:[cm]?[jt]sx?)$/.test(file) && !parts.includes("node_modules") && !parts.some((part) => part.startsWith("."))) files.push(path.join(root, file));
  }
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (file !== runner && !file.endsWith("remote-check.test.ts")) assert.doesNotMatch(text, refers, `${path.relative(root, file)} refers to the check runner`);
    if (file.startsWith(src)) assert.doesNotMatch(text, /verdictsTrusted\s*[:=]\s*true/, `${path.relative(root, file)} writes a trusted result`);
  }
});
