// RPAI-33, stage 3: the signed statement that approves a set of bindings for one run, and the exact hash of a
// set. These tests are about that check alone. Nothing here is used by a run, and a test below holds it so.
// Keys are made here for the tests; no model and no browser is involved.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { authoriseRemoteRun, scopeSha256, signedStatement, type Approval, type AuthorisedRun, type TrustedKeys } from "../src/remote/authority.ts";
import { authoriseBindings, bindingProblems, bindingSha256, bindingsSha256, signedBindingStatement, Binding, type BindingApproval } from "../src/remote/binding.ts";
import { admitRemoteRun, RemoteRequestRefused, sha256Hex } from "../src/remote/request.ts";

const NOW = new Date("2026-11-22T12:00:00Z");
const TEXT_A = "# Rules\n\nAfter a first paid purchase of 24.99 the balance shows 124.\n";
const TEXT_B = "# Limits\n\nA basket holds at most 20 lines, and a full basket shows 20.\n";
const RUN = "a0000000-0000-4000-8000-000000000401";
const WORKSPACE = "a0000000-0000-4000-8000-00000000000a";
const PROJECT = "a0000000-0000-4000-8000-000000000101";
const OTHER = "b0000000-0000-4000-8000-000000000401";
const KEY_ID = "control-plane-2026-11";

const controlPlane = generateKeyPairSync("ed25519");
const someoneElse = generateKeyPairSync("ed25519");
const trusted: TrustedKeys = new Map([[KEY_ID, controlPlane.publicKey]]);

const snapshotOf = (id: string, content: string) => ({ id, content, sha256: sha256Hex(content), approvedBy: "owner-a@releaseproof.test", approvedAt: "2026-11-20T09:30:00Z" });
const SNAP_A = snapshotOf("rules-r3", TEXT_A);
const SNAP_B = snapshotOf("limits-r1", TEXT_B);

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestVersion: 1,
    runId: RUN,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    target: { baseUrl: "https://app.releaseproof.test/", allowedHosts: ["app.releaseproof.test"] },
    criteria: [SNAP_A, SNAP_B],
    limits: { maxUsd: 1, maxScenarios: 5, maxMinutes: 10 },
    ...overrides,
  };
}

/** A criteria approval, as the control plane issues one today. */
function criteriaApproval(raw: ReturnType<typeof request>, snapshot: typeof SNAP_A, overrides: Partial<Approval> = {}): Approval {
  const statement = {
    approvalVersion: 1 as const,
    keyId: KEY_ID,
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    runId: raw.runId,
    targetOrigin: new URL(raw.target.baseUrl).origin,
    scopeSha256: scopeSha256(raw as never),
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    approvedBy: snapshot.approvedBy,
    approvedAt: snapshot.approvedAt,
    issuedAt: "2026-11-22T11:00:00Z",
    expiresAt: "2026-11-22T13:00:00Z",
    ...overrides,
  };
  return { ...statement, signature: sign(null, Buffer.from(signedStatement(statement), "utf8"), controlPlane.privateKey).toString("base64url") };
}

/** A run whose criteria approvals have verified: what bindings are checked against. */
function authorisedRun(raw = request()): AuthorisedRun {
  return authoriseRemoteRun(admitRemoteRun(raw, NOW), raw.criteria.map((snapshot) => criteriaApproval(raw, snapshot as typeof SNAP_A)), trusted, NOW);
}

const QUOTE_A = "After a first paid purchase of 24.99 the balance shows 124.";
const quoteStart = TEXT_A.indexOf(QUOTE_A);

function binding(overrides: Record<string, unknown> = {}): Binding {
  const reading = { path: "/account", locator: { by: "testid", value: "balance" }, valueKind: "number", unit: "plain" };
  return Binding.parse({
    formatVersion: 1,
    id: "balance-after-first-purchase",
    snapshotId: SNAP_A.id,
    snapshotSha256: SNAP_A.sha256,
    quote: { start: quoteStart, end: quoteStart + QUOTE_A.length },
    locale: "en-GB",
    timezone: "Europe/London",
    background: [{ method: "POST", path: "/api/heartbeat" }],
    tolerated: [{ method: "GET", path: "/favicon.ico", status: 404 }],
    settling: { within: 10, readings: 3 },
    setup: { kind: "fixture", method: "POST", path: "/api/test/accounts", body: '{"key":"{{key}}"}' },
    steps: [
      { kind: "open", path: "/sign-in" },
      { kind: "fill", path: "/sign-in", locator: { by: "role", role: "textbox", name: "Email" }, value: { from: "fixture", field: "email" } },
      { kind: "act", path: "/sign-in", locator: { by: "role", role: "button", name: "Sign in" }, expects: { write: "one", method: "POST", path: "/sign-in" } },
      { kind: "see", reading, expected: { from: "literal", value: "0" } },
      { kind: "open", path: "/buy" },
      { kind: "act", path: "/buy", locator: { by: "role", role: "button", name: "Pay" }, expects: { write: "one", method: "POST", path: "/api/pay" } },
      { kind: "see", reading: { ...reading, path: "/history", locator: { by: "testid", value: "total" }, valueKind: "amount", unit: "currency-units" }, expected: { from: "quote", start: QUOTE_A.indexOf("24.99"), end: QUOTE_A.indexOf("24.99") + 5, value: "24.99" } },
    ],
    observation: reading,
    expected: { start: QUOTE_A.indexOf("124"), end: QUOTE_A.indexOf("124") + 3, value: "124" },
    ...overrides,
  });
}

/** A second binding of the same set, and one of the other snapshot's. */
const second = () => binding({ id: "balance-again" });
const QUOTE_B = "A basket holds at most 20 lines, and a full basket shows 20.";
const ofB = (overrides: Record<string, unknown> = {}) =>
  binding({ id: "basket-count", snapshotId: SNAP_B.id, snapshotSha256: SNAP_B.sha256, quote: { start: TEXT_B.indexOf(QUOTE_B), end: TEXT_B.indexOf(QUOTE_B) + QUOTE_B.length }, expected: { start: QUOTE_B.lastIndexOf("20"), end: QUOTE_B.lastIndexOf("20") + 2, value: "20" }, steps: [{ kind: "see", reading: { path: "/basket", locator: { by: "testid", value: "lines" }, valueKind: "number", unit: "plain" }, expected: { from: "literal", value: "0" } }], setup: { kind: "fresh-browser" }, ...overrides });

/** What the control plane would issue for a set. `key` lets a test sign with the wrong key. */
function statementFor(bindings: Binding[], snapshot: typeof SNAP_A, overrides: Partial<BindingApproval> = {}, key: KeyObject = controlPlane.privateKey, raw = request()): BindingApproval {
  const statement = {
    bindingApprovalVersion: 1 as const,
    keyId: KEY_ID,
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    runId: raw.runId,
    targetOrigin: new URL(raw.target.baseUrl).origin,
    scopeSha256: scopeSha256(raw as never),
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    bindingFormatVersion: 1 as const,
    bindingCount: bindings.length,
    bindingsSha256: bindingsSha256(bindings),
    approvedBy: "owner-a@releaseproof.test",
    approvedAt: "2026-11-21T10:00:00Z",
    issuedAt: "2026-11-22T11:00:00Z",
    expiresAt: "2026-11-22T13:00:00Z",
    ...overrides,
  };
  return { ...statement, signature: sign(null, Buffer.from(signedBindingStatement(statement), "utf8"), key).toString("base64url") };
}

/** The reasons a refusal gives, or a failure of the test if nothing was refused. */
function refused(evidence: unknown, run: AuthorisedRun = authorisedRun(), now = NOW, keys = trusted): string {
  try {
    authoriseBindings(run, evidence, keys, now);
  } catch (error) {
    assert.ok(error instanceof RemoteRequestRefused, String(error));
    return error.reasons.join(" | ");
  }
  assert.fail("the binding evidence was accepted");
}

// ---- what is accepted ----------------------------------------------------------

test("a run handed no binding evidence has no signed set, and is what it is today", () => {
  assert.deepEqual(authoriseBindings(authorisedRun(), undefined, trusted, NOW), []);
});

test("a statement signed by the control plane for this run, this revision and exactly these bindings gives a signed set", () => {
  const set = [binding(), second()];
  const sets = authoriseBindings(authorisedRun(), { statements: [statementFor(set, SNAP_A)], bindings: set }, trusted, NOW);
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.snapshotId, SNAP_A.id);
  assert.equal(sets[0]!.snapshotSha256, SNAP_A.sha256);
  assert.equal(sets[0]!.bindingsSha256, bindingsSha256(set));
  assert.deepEqual(sets[0]!.bindings.map((one) => one.id), ["balance-after-first-purchase", "balance-again"].sort());
  assert.deepEqual(sets[0]!.authority, { keyId: KEY_ID, approvedBy: "owner-a@releaseproof.test", approvedAt: "2026-11-21T10:00:00Z", issuedAt: "2026-11-22T11:00:00Z", expiresAt: "2026-11-22T13:00:00Z" });
});

test("one statement per snapshot: two snapshots, two sets, and the sequence things arrive in does not matter", () => {
  const a = [binding(), second()];
  const b = [ofB()];
  const one = authoriseBindings(authorisedRun(), { statements: [statementFor(a, SNAP_A), statementFor(b, SNAP_B)], bindings: [...a, ...b] }, trusted, NOW);
  const other = authoriseBindings(authorisedRun(), { statements: [statementFor(b, SNAP_B), statementFor(a, SNAP_A)], bindings: [b[0]!, a[1]!, a[0]!] }, trusted, NOW);
  assert.deepEqual(one, other);
  assert.deepEqual(one.map((set) => [set.snapshotId, set.bindings.length]), [["limits-r1", 1], ["rules-r3", 2]]);
});

test("a statement may cover one snapshot of a run and not the other", () => {
  const a = [binding()];
  assert.equal(authoriseBindings(authorisedRun(), { statements: [statementFor(a, SNAP_A)], bindings: a }, trusted, NOW).length, 1);
});

// ---- the hash ------------------------------------------------------------------

test("the hash of a set is fixed: the same bindings give the same hash on any machine, in any sequence", () => {
  const set = [binding(), second()];
  assert.equal(bindingsSha256(set), bindingsSha256([...set].reverse()));
  // A vector. If this changes, the format has changed and BINDING_FORMAT_VERSION must change with it.
  const fixed = binding({ snapshotSha256: "0".repeat(64), quote: { start: 9, end: 68 } });
  assert.equal(bindingSha256(fixed), "946bd8d060e39dadfcbc9659571effe3b880cd6ddcf75657a278f22f430c4abb");
  assert.equal(bindingsSha256([fixed]), "17d982bca3403b577173b9fd29fbb13a5f0e8d5ed56d9b74b4f5dd915034937b");
  assert.throws(() => bindingsSha256([binding(), binding()]), /same id/);
});

test("every field of a binding is in the hash: changing any one changes it", () => {
  const base = binding();
  const reading = base.observation;
  const changes: Record<string, unknown>[] = [
    { id: "another-name" },
    { snapshotId: "rules-r4" },
    { snapshotSha256: "1".repeat(64) },
    { quote: { start: base.quote.start, end: base.quote.end - 1 } },
    { locale: "en-US" },
    { timezone: "Europe/Paris" },
    { background: [] },
    { background: [{ method: "PUT", path: "/api/heartbeat" }] },
    { tolerated: [] },
    { tolerated: [{ method: "GET", path: "/favicon.ico", status: 410 }] },
    { settling: { within: 11, readings: 3 } },
    { settling: { within: 10, readings: 4 } },
    { setup: { kind: "fixture", method: "POST", path: "/api/test/accounts", body: '{"key":"{{key}}","plan":"paid"}' } },
    { steps: base.steps.slice(0, -1) },
    { steps: [...base.steps.slice(1), base.steps[0]] },
    { steps: base.steps.map((step) => (step.kind === "fill" ? { ...step, value: { from: "fixture", field: "name" } } : step)) },
    { steps: base.steps.map((step) => (step.kind === "act" && step.path === "/buy" ? { ...step, expects: { write: "one", method: "PUT", path: "/api/pay" } } : step)) },
    { steps: base.steps.map((step) => (step.kind === "see" && step.expected.from === "literal" ? { ...step, expected: { from: "literal", value: "1" } } : step)) },
    { observation: { ...reading, path: "/accounts" } },
    { observation: { ...reading, locator: { by: "testid", value: "balance2" } } },
    { observation: { ...reading, locator: { by: "role", role: "status", name: "balance" } } },
    { observation: { ...reading, valueKind: "amount" } },
    { observation: { ...reading, unit: "currency-units" } },
    { expected: { ...base.expected, value: "125" } },
    { expected: { ...base.expected, start: base.expected.start - 1 } },
  ];
  const seen = new Set([bindingSha256(base)]);
  for (const change of changes) {
    const hash = bindingSha256(binding(change));
    assert.ok(!seen.has(hash), `no change of hash for ${JSON.stringify(change).slice(0, 80)}`);
    seen.add(hash);
  }
});

// ---- signatures ----------------------------------------------------------------

test("a statement is refused when its signature is not the control plane's", () => {
  const set = [binding()];
  assert.match(refused({ statements: [statementFor(set, SNAP_A, {}, someoneElse.privateKey)], bindings: set }), /signature that does not verify/);
  assert.match(refused({ statements: [statementFor(set, SNAP_A, { keyId: "unknown-key" })], bindings: set }), /names a key that is not trusted/);
  const genuine = statementFor(set, SNAP_A);
  const flipped = genuine.signature.slice(0, -2) + (genuine.signature.at(-2) === "A" ? "B" : "A") + genuine.signature.at(-1);
  assert.match(refused({ statements: [{ ...genuine, signature: flipped }], bindings: set }), /signature that does not verify/);
  // The same signature spelled another way (spare bits set) is not accepted either.
  const spare = genuine.signature.slice(0, -1) + String.fromCharCode(genuine.signature.charCodeAt(85) + 1);
  assert.match(refused({ statements: [{ ...genuine, signature: spare }], bindings: set }), /not in canonical base64url/);
});

test("changing any signed field after signing is refused", () => {
  const set = [binding()];
  const genuine = statementFor(set, SNAP_A);
  const altered: Partial<BindingApproval>[] = [
    { approvedBy: "someone-else@releaseproof.test" },
    { approvedAt: "2026-11-21T10:00:01Z" },
    { issuedAt: "2026-11-22T11:00:01Z" },
    { expiresAt: "2026-11-22T13:00:01Z" },
    { bindingCount: 2 },
    { bindingsSha256: "2".repeat(64) },
    { snapshotSha256: "3".repeat(64) },
    { scopeSha256: "4".repeat(64) },
    { runId: OTHER },
    { workspaceId: OTHER },
    { projectId: OTHER },
    { targetOrigin: "https://other.releaseproof.test" },
    { snapshotId: "limits-r1" },
  ];
  for (const change of altered) {
    assert.match(refused({ statements: [{ ...genuine, ...change }], bindings: set }), /does not verify/, JSON.stringify(change));
  }
});

test("no trusted key, or a key that is not Ed25519, and nothing can be checked", () => {
  const set = [binding()];
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, authorisedRun(), NOW, new Map()), /no trusted approval key/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, authorisedRun(), NOW, new Map([[KEY_ID, rsa.publicKey]])), /not an Ed25519 public key/);
});

// ---- the two kinds of statement cannot stand in for each other -----------------

test("a criteria approval presented as a binding statement is refused, and a binding statement presented as a criteria approval refuses the run", () => {
  const raw = request();
  const set = [binding()];
  assert.match(refused({ statements: [criteriaApproval(raw, SNAP_A)], bindings: set }), /binding statement 1 is malformed/);
  const admitted = admitRemoteRun(raw, NOW);
  assert.throws(
    () => authoriseRemoteRun(admitted, [criteriaApproval(raw, SNAP_A), criteriaApproval(raw, SNAP_B), statementFor(set, SNAP_A)], trusted, NOW),
    (error: unknown) => error instanceof RemoteRequestRefused && /approval 3 is malformed/.test(error.reasons.join(" ")),
  );
});

test("a signature made over a criteria approval's bytes does not verify as a binding statement, with the same key", () => {
  const raw = request();
  const set = [binding()];
  const genuine = statementFor(set, SNAP_A);
  // The same fields a criteria approval signs, in its layout and under its first line, signed by the control plane.
  const { signature: borrowed } = criteriaApproval(raw, SNAP_A, { approvedBy: genuine.approvedBy, approvedAt: genuine.approvedAt, issuedAt: genuine.issuedAt, expiresAt: genuine.expiresAt });
  assert.match(refused({ statements: [{ ...genuine, signature: borrowed }], bindings: set }), /does not verify/);
  assert.ok(signedBindingStatement(genuine).startsWith("releaseproof-binding-approval-v1\n"));
  assert.ok(signedStatement(criteriaApproval(raw, SNAP_A)).startsWith("releaseproof-criteria-approval-v1\n"));
});

test("a field of a statement cannot hold a line break, so no field can run into the next", () => {
  const set = [binding()];
  const genuine = statementFor(set, SNAP_A);
  assert.match(refused({ statements: [{ ...genuine, approvedBy: "owner\n2026-11-21T10:00:00Z" }], bindings: set }), /malformed/);
  assert.match(refused({ statements: [{ ...genuine, snapshotId: "rules-r3\nx" }], bindings: set }), /malformed/);
  assert.match(refused({ statements: [{ ...genuine, approvedBy: "" }], bindings: set }), /malformed/);
});

// ---- scope and replay ----------------------------------------------------------

test("a genuine statement for another run, workspace, project, target or scope is refused", () => {
  const set = [binding()];
  const cases: [Partial<BindingApproval>, RegExp][] = [
    [{ runId: OTHER }, /for another run/],
    [{ workspaceId: OTHER }, /for another workspace/],
    [{ projectId: OTHER }, /for another project/],
    [{ targetOrigin: "https://other.releaseproof.test" }, /for another target/],
    [{ scopeSha256: "5".repeat(64) }, /different target address, set of allowed hosts, limits or set of criteria/],
  ];
  for (const [change, reason] of cases) assert.match(refused({ statements: [statementFor(set, SNAP_A, change)], bindings: set }), reason);
});

test("replay: a statement issued for one run is refused for another run of the same project and criteria, and for the same run with other limits", () => {
  const set = [binding()];
  const issued = statementFor(set, SNAP_A);
  // Another run: everything the same but its id.
  const later = request({ runId: OTHER });
  assert.match(refused({ statements: [issued], bindings: set }, authorisedRun(later)), /for another run/);
  // The same run id with wider limits: the scope it was issued for is not this one.
  const wider = request({ limits: { maxUsd: 5, maxScenarios: 5, maxMinutes: 10 } });
  assert.match(refused({ statements: [issued], bindings: set }, authorisedRun(wider)), /different target address, set of allowed hosts, limits or set of criteria/);
  // And with other criteria beside it.
  const fewer = request({ criteria: [SNAP_A] });
  assert.match(refused({ statements: [issued], bindings: set }, authorisedRun(fewer)), /different target address, set of allowed hosts, limits or set of criteria/);
});

test("a statement is refused when expired, dated in the future, valid for too long, or issued before the approval it states", () => {
  const set = [binding()];
  const cases: [Partial<BindingApproval>, RegExp][] = [
    [{ expiresAt: "2026-11-22T12:00:00Z" }, /has expired/],
    [{ issuedAt: "2026-11-21T09:00:00Z", expiresAt: "2026-11-22T11:59:59Z", approvedAt: "2026-11-21T08:00:00Z" }, /has expired/],
    [{ issuedAt: "2026-11-22T12:05:01Z", expiresAt: "2026-11-22T13:00:00Z" }, /dated in the future/],
    [{ issuedAt: "2026-11-21T12:30:00Z", expiresAt: "2026-11-22T12:30:01Z" }, /valid for more than 24 hours/],
    [{ approvedAt: "2026-11-22T11:00:01Z" }, /issued before the approval it states/],
    [{ issuedAt: "2026-11-22T12:02:00Z", expiresAt: "2026-11-22T12:01:00Z" }, /expires before it was issued/],
  ];
  for (const [change, reason] of cases) assert.match(refused({ statements: [statementFor(set, SNAP_A, change)], bindings: set }), reason, JSON.stringify(change));
  // The same statement, an hour and a day later.
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, authorisedRun(), new Date("2026-11-22T13:00:00Z")), /has expired/);
});

// ---- snapshots and sets --------------------------------------------------------

test("a statement for a snapshot the run does not carry, or for another revision of its text, is refused", () => {
  const set = [binding()];
  assert.match(refused({ statements: [statementFor(set, { ...SNAP_A, id: "rules-r9" })], bindings: set }), /a criteria snapshot this run does not carry/);
  const other = [binding({ snapshotSha256: sha256Hex(`${TEXT_A}changed`) })];
  assert.match(refused({ statements: [statementFor(other, { ...SNAP_A, sha256: sha256Hex(`${TEXT_A}changed`) })], bindings: other }), /another revision of the criteria text/);
});

test("a binding for another revision than its statement is refused, even when the statement signs it", () => {
  // The control plane would not issue this. If it did, the engine still refuses: the binding is not for the text the run carries.
  const stale = [binding({ snapshotSha256: "6".repeat(64) })];
  assert.match(refused({ statements: [statementFor(stale, SNAP_A)], bindings: stale }), /another revision of the criteria text than its statement/);
});

test("the bindings presented must be exactly the set the statement covers: none more, none fewer, none changed", () => {
  const set = [binding(), second()];
  const issued = statementFor(set, SNAP_A);
  assert.match(refused({ statements: [issued], bindings: [set[0]] }), /covers 2 bindings, and 1 was presented/);
  assert.match(refused({ statements: [issued], bindings: [...set, binding({ id: "a-third" })] }), /covers 2 bindings, and 3 were presented/);
  assert.match(refused({ statements: [issued], bindings: [set[0], binding({ id: "balance-again", settling: { within: 120, readings: 3 } })] }), /not the set its statement covers/);
  assert.match(refused({ statements: [issued], bindings: [set[0], binding({ id: "swapped-in" })] }), /not the set its statement covers/);
  assert.match(refused({ statements: [issued], bindings: [] }), /covers 2 bindings, and 0 were presented/);
});

test("a binding no statement covers, two statements for one snapshot, and a statement with nothing beside it are refused", () => {
  const a = [binding()];
  assert.match(refused({ statements: [statementFor(a, SNAP_A)], bindings: [...a, ofB()] }), /for a snapshot that no statement covers/);
  assert.match(refused({ statements: [statementFor(a, SNAP_A), statementFor(a, SNAP_A, { issuedAt: "2026-11-22T11:30:00Z" })], bindings: a }), /more than one statement for its snapshot/);
  assert.match(refused({ statements: [], bindings: a }), /holds no statement/);
  assert.match(refused({ statements: [{ ...statementFor(a, SNAP_A), bindingCount: 0 }], bindings: [] }), /malformed/);
});

test("one name, one binding: the same id twice in a set, or in two sets of one run, is refused", () => {
  const twice = [binding(), binding({ settling: { within: 20, readings: 3 } })];
  assert.match(refused({ statements: [statementFor([twice[0]!], SNAP_A)], bindings: twice }), /two bindings have the same id/);
  const a = [binding({ id: "shared-name" })];
  const b = [ofB({ id: "shared-name" })];
  assert.match(refused({ statements: [statementFor(a, SNAP_A), statementFor(b, SNAP_B)], bindings: [...a, ...b] }), /two bindings have the same id/);
});

test("a wrong entry refuses the whole: a good statement beside a bad one gives no set", () => {
  const a = [binding()];
  const b = [ofB()];
  assert.match(refused({ statements: [statementFor(a, SNAP_A), statementFor(b, SNAP_B, { expiresAt: "2026-11-22T11:59:00Z" })], bindings: [...a, ...b] }), /binding statement 2 is refused because it has expired/);
});

// ---- the shape and content of a binding ----------------------------------------

test("evidence that is not a list of statements and a list of bindings is refused", () => {
  for (const evidence of [null, [], "x", {}, { statements: [] }, { statements: [], bindings: [], more: 1 }, { statements: {}, bindings: [] }]) {
    assert.match(refused(evidence), /not a list of statements and a list of bindings/, JSON.stringify(evidence));
  }
});

test("a binding with a field it should not have, a path with a query, or a number in another spelling is refused", () => {
  const good = binding();
  const bad: unknown[] = [
    { ...good, note: "free text" },
    { ...good, observation: { ...good.observation, path: "/account?tab=1" } },
    { ...good, observation: { ...good.observation, path: "/account#top" } },
    { ...good, observation: { ...good.observation, path: "account" } },
    { ...good, observation: { ...good.observation, locator: { by: "css", value: ".balance" } } },
    { ...good, observation: { ...good.observation, valueKind: "text" } },
    { ...good, expected: { ...good.expected, value: "124.0e0" } },
    { ...good, expected: { ...good.expected, value: "0124" } },
    { ...good, expected: { ...good.expected, value: 124 } },
    { ...good, settling: { within: 121, readings: 3 } },
    { ...good, settling: { within: 10, readings: 2 } },
    { ...good, formatVersion: 2 },
    { ...good, id: "has space" },
    { ...good, steps: [] },
    { ...good, steps: [{ kind: "wait", seconds: 5 }] },
    { ...good, setup: { kind: "fixture", method: "GET", path: "/api/test/accounts", body: "{{key}}" } },
  ];
  for (const one of bad) {
    assert.match(refused({ statements: [statementFor([good], SNAP_A)], bindings: [one] }), /binding 1 is malformed/, JSON.stringify(one).slice(0, 120));
  }
});

test("a binding is refused when it has no condition, a fixture that takes no key, a write also called background, or text not in NFC", () => {
  const good = binding();
  const noSee = binding({ steps: good.steps.filter((step) => step.kind !== "see") });
  assert.deepEqual(bindingProblems(good), []);
  assert.match(bindingProblems(noSee).join(" "), /no condition/);
  assert.match(bindingProblems(binding({ setup: { kind: "fixture", method: "POST", path: "/api/test/accounts", body: "{}" } })).join(" "), /no \{\{key\}\}/);
  assert.match(bindingProblems(binding({ background: [{ method: "POST", path: "/api/pay" }] })).join(" "), /also listed as background/);
  assert.match(bindingProblems(binding({ setup: { kind: "fresh-browser" } })).join(" "), /has no fixture/);
  // "é" as one code point and as "e" with a combining accent look the same and are not the same text.
  const composed = binding({ observation: { ...good.observation, locator: { by: "role", role: "status", name: "Solde cr\u00e9dit" } } });
  const decomposed = binding({ observation: { ...good.observation, locator: { by: "role", role: "status", name: "Solde cre\u0301dit" } } });
  assert.deepEqual(bindingProblems(composed), []);
  assert.match(bindingProblems(decomposed).join(" "), /not in Unicode NFC/);
  assert.match(bindingProblems(binding({ expected: { start: 0, end: 10_000, value: "124" } })).join(" "), /outside its quote/);
  // Signed or not, such a binding gives no set.
  assert.match(refused({ statements: [statementFor([noSee], SNAP_A)], bindings: [noSee] }), /binding 1 is refused because it has no condition/);
  assert.match(refused({ statements: [statementFor([decomposed], SNAP_A)], bindings: [decomposed] }), /not in Unicode NFC/);
});

test("bindings are only ever for a snapshot whose own approval verified", () => {
  const set = [binding()];
  const run = authorisedRun();
  // A caller that built the run itself, with text that is not what the hash was taken of.
  const forged = { ...run, snapshots: run.snapshots.map((snapshot) => (snapshot.id === SNAP_A.id ? { ...snapshot, content: `${snapshot.content}and more` } : snapshot)) } as AuthorisedRun;
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, forged), /another revision of the criteria text/);
  const unapproved = { ...run, snapshots: run.snapshots.map((snapshot) => ({ ...snapshot, approverVerified: false })) } as unknown as AuthorisedRun;
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, unapproved), /no verified approval of its own/);
});

// ---- not used by any run -------------------------------------------------------

test("nothing in the engine uses bindings yet: no other source file refers to the module or to what it exports, and nothing writes verdictsTrusted true", () => {
  const src = path.join(import.meta.dirname, "../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(file)) files.push(file);
    }
  };
  walk(src);
  // One file may: the check runner, which carries a binding out. No run uses the runner either, and
  // remote-check.test.ts holds that.
  const others = files.filter((file) => !file.endsWith(path.join("remote", "binding.ts")) && !file.endsWith(path.join("remote", "check.ts")));
  // By any spelling of its name (with or without an ending, in any kind of quote, or put together from parts),
  // and by the names of what it exports.
  const refers = /binding(\.[cm]?[jt]s)?["'`]|["'`]bind["'`]|authoriseBindings|bindingsSha256|bindingSha256|bindingProblems|BindingApproval|BindingEvidence|SignedBindingSet|signedBindingStatement|FIXTURE_KEY_PLACEHOLDER|BINDING_(APPROVAL|FORMAT)_VERSION/;
  assert.deepEqual(others.filter((file) => refers.test(readFileSync(file, "utf8"))).map((file) => path.relative(src, file)), []);
  // Trust is written in one place, as the constant false, and true nowhere: comments are left out before looking.
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const all = files.map(code).join("\n");
  assert.equal((all.match(/verdictsTrusted\s*:\s*true/g) ?? []).length, 0);
  assert.equal((all.match(/verdictsTrusted\s*=\s*true/g) ?? []).length, 0);
  assert.equal((code(path.join(src, "remote/run.ts")).match(/verdictsTrusted: false,/g) ?? []).length, 1);
});

// ---- found by the security review of this stage ---------------------------------

test("a statement has one spelling in bytes: half of a surrogate pair is refused, so a field cannot be altered into one that signs the same", () => {
  const set = [binding()];
  // Written out as UTF-8, half a pair becomes U+FFFD. A statement signed with U+FFFD must not also stand for one with half a pair.
  const signed = statementFor(set, SNAP_A, { approvedBy: "owner\ufffd@releaseproof.test" });
  assert.equal(authoriseBindings(authorisedRun(), { statements: [signed], bindings: set }, trusted, NOW).length, 1);
  for (const half of ["\ud800", "\udfff"]) {
    const altered = { ...signed, approvedBy: `owner${half}@releaseproof.test` };
    assert.match(refused({ statements: [altered], bindings: set }), /binding statement 1 is malformed/);
    assert.match(refused({ statements: [JSON.parse(JSON.stringify(altered))], bindings: set }), /binding statement 1 is malformed/);
  }
  const good = binding();
  const halved = { ...good, observation: { ...good.observation, locator: { by: "testid", value: "balance\ud800" } } };
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: [halved] }), /binding 1 is malformed/);
  const body = { ...good, setup: { kind: "fixture", method: "POST", path: "/api/test/accounts", body: '{"key":"{{key}}","n":"\ud800"}' } };
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: [body] }), /not well-formed Unicode/);
});

test("text that is not seen, or that turns the reading direction, is refused in a statement and in a binding", () => {
  const set = [binding()];
  const good = binding();
  for (const unseen of ["\u200b", "\u202e", "\ufeff", "\u2028", "\u0085", "\u00ad", "\u2066", "\r", "\t", "\u061c", "\u180e", "\u3164", "\u115f", "\u034f", "\ufff9", "\u{e0041}", "\u200d"]) {
    assert.match(refused({ statements: [{ ...statementFor(set, SNAP_A), approvedBy: `owner${unseen}@releaseproof.test` }], bindings: set }), /binding statement 1 is malformed/, JSON.stringify(unseen));
    const named = { ...good, observation: { ...good.observation, locator: { by: "role", role: "status", name: `Bal${unseen}ance` } } };
    assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: [named] }), /binding 1 is malformed/, JSON.stringify(unseen));
  }
});

test("a time now that cannot be read refuses everything: nothing is taken as not yet expired", () => {
  const set = [binding()];
  const longExpired = statementFor(set, SNAP_A, { approvedAt: "2020-01-01T00:00:00Z", issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T01:00:00Z" });
  assert.match(refused({ statements: [longExpired], bindings: set }), /has expired/);
  assert.match(refused({ statements: [longExpired], bindings: set }, authorisedRun(), new Date("not a date")), /the time now cannot be read/);
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, authorisedRun(), new Date(Number.NaN)), /the time now cannot be read/);
  assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: set }, authorisedRun(), "2026-11-22T12:00:00Z" as unknown as Date), /the time now cannot be read/);
});

test("the signed bytes are fixed: every field on its own line, in this sequence", () => {
  const fixed = {
    bindingApprovalVersion: 1 as const,
    keyId: "control-plane-2026-11",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    runId: RUN,
    targetOrigin: "https://app.releaseproof.test",
    scopeSha256: "a".repeat(64),
    snapshotId: "rules-r3",
    snapshotSha256: "b".repeat(64),
    bindingFormatVersion: 1 as const,
    bindingCount: 2,
    bindingsSha256: "c".repeat(64),
    approvedBy: "owner-a@releaseproof.test",
    approvedAt: "2026-11-21T10:00:00Z",
    issuedAt: "2026-11-22T11:00:00Z",
    expiresAt: "2026-11-22T13:00:00Z",
  };
  assert.equal(
    signedBindingStatement(fixed),
    [
      "releaseproof-binding-approval-v1",
      "1",
      "control-plane-2026-11",
      WORKSPACE,
      PROJECT,
      RUN,
      "https://app.releaseproof.test",
      "a".repeat(64),
      "rules-r3",
      "b".repeat(64),
      "1",
      "2",
      "c".repeat(64),
      "owner-a@releaseproof.test",
      "2026-11-21T10:00:00Z",
      "2026-11-22T11:00:00Z",
      "2026-11-22T13:00:00Z",
    ].join("\n"),
  );
});

test("the key a statement names is part of what is signed: named after signing as another trusted key, it does not verify", () => {
  const set = [binding()];
  const both: TrustedKeys = new Map([[KEY_ID, controlPlane.publicKey], ["second-key", controlPlane.publicKey]]);
  const signed = statementFor(set, SNAP_A);
  assert.equal(authoriseBindings(authorisedRun(), { statements: [signed], bindings: set }, both, NOW).length, 1);
  assert.match(refused({ statements: [{ ...signed, keyId: "second-key" }], bindings: set }, authorisedRun(), NOW, both), /signature that does not verify/);
});

test("a statement is a strict thing: an unknown field, an address that is not an origin, a signature of another length", () => {
  const set = [binding()];
  const signed = statementFor(set, SNAP_A);
  for (const wrong of [
    { ...signed, note: "extra" },
    { ...signed, targetOrigin: "https://app.releaseproof.test/" },
    { ...signed, targetOrigin: "https://app.releaseproof.test:443" },
    { ...signed, targetOrigin: "HTTPS://app.releaseproof.test" },
    { ...signed, signature: signed.signature.slice(0, 85) },
    { ...signed, signature: `${signed.signature}A` },
    { ...signed, bindingCount: 201 },
    { ...signed, bindingApprovalVersion: 2 },
    { ...signed, bindingFormatVersion: 2 },
  ]) {
    assert.match(refused({ statements: [wrong], bindings: set }), /binding statement 1 is malformed/, JSON.stringify(wrong).slice(0, 90));
  }
});

test("the five minutes allowed for clocks that disagree are five minutes", () => {
  const set = [binding()];
  const at = (issuedAt: string) => ({ statements: [statementFor(set, SNAP_A, { issuedAt, expiresAt: "2026-11-22T13:00:00Z" })], bindings: set });
  assert.equal(authoriseBindings(authorisedRun(), at("2026-11-22T12:05:00Z"), trusted, NOW).length, 1);
  assert.match(refused(at("2026-11-22T12:05:00.001Z")), /dated in the future/);
});

test("the limits are the limits: 40 statements, 200 bindings, 60 steps, a quote of 600, and positions inside it", () => {
  const set = [binding()];
  const signed = statementFor(set, SNAP_A);
  assert.match(refused({ statements: Array.from({ length: 41 }, () => signed), bindings: set }), /not a list of statements and a list of bindings, within their limits/);
  assert.match(refused({ statements: [signed], bindings: Array.from({ length: 201 }, () => set[0]) }), /within their limits/);
  const good = binding();
  const many = { ...good, steps: Array.from({ length: 61 }, () => good.steps[3]) };
  assert.match(refused({ statements: [signed], bindings: [many] }), /binding 1 is malformed/);
  assert.match(bindingProblems(binding({ quote: { start: 0, end: 601 } })).join(" "), /longer than 600/);
  assert.deepEqual(bindingProblems(binding({ quote: { start: 0, end: 600 } })), []);
  const seeOutside = binding({ steps: good.steps.map((step) => (step.kind === "see" && step.expected.from === "quote" ? { ...step, expected: { ...step.expected, start: 100, end: 105 } } : step)) });
  assert.match(bindingProblems(seeOutside).join(" "), /a condition's expected value lies outside the quote/);
  assert.match(bindingProblems(binding({ expected: { start: 10, end: 10, value: "124" } })).join(" "), /its expected value has a position that ends before it starts/);
  const seeBackwards = binding({ steps: good.steps.map((step) => (step.kind === "see" && step.expected.from === "quote" ? { ...step, expected: { ...step.expected, start: 9, end: 4 } } : step)) });
  assert.match(bindingProblems(seeBackwards).join(" "), /a condition's expected value has a position that ends before it starts/);
  assert.match(refused({ statements: [signed], bindings: [{ ...good, quote: { start: 5, end: 5 } }] }), /binding 1 is malformed/);
  assert.match(refused({ statements: [signed], bindings: [{ ...good, tolerated: [{ method: "GET", path: "/favicon.ico", status: 399 }] }] }), /binding 1 is malformed/);
  assert.match(refused({ statements: [signed], bindings: [{ ...good, tolerated: [{ method: "GET", path: "/favicon.ico", status: 600 }] }] }), /binding 1 is malformed/);
});

test("a path is a plain static path of the target: nothing a browser would read as another place", () => {
  const set = [binding()];
  const good = binding();
  for (const bad of ["/caf\u00e9", "/\u65e5\u672c", "/a\u00a0b", "//other.example/x", "/a//b", "/\\other.example", "/a/../b", "/a/./b", "/..", "/a%3Fb", "/a%2e%2e/b", "/a b", "/a\u202eb", "/a?b", "/a#b", ""]) {
    const moved = { ...good, observation: { ...good.observation, path: bad } };
    assert.match(refused({ statements: [statementFor(set, SNAP_A)], bindings: [moved] }), /binding 1 is malformed/, JSON.stringify(bad));
  }
  for (const fine of ["/", "/account", "/a/b-c_d.e/f", "/api/test/accounts"]) {
    assert.deepEqual(bindingProblems(binding({ observation: { ...good.observation, path: fine } })), [], fine);
  }
});

test("ordinary text in other scripts is still text, and the last limits hold", () => {
  const set = [binding()];
  const good = binding();
  for (const name of ["\u05e9\u05dc\u05d5\u05dd", "\u0645\u0631\u062d\u0628\u0627", "\u65e5\u672c\u8a9e", "caf\u00e9", "\u{1f600} ok", "\u{20000}"]) {
    assert.deepEqual(bindingProblems(binding({ observation: { ...good.observation, locator: { by: "role", role: "status", name } } })), [], name);
    assert.equal(authoriseBindings(authorisedRun(), { statements: [statementFor(set, SNAP_A, { approvedBy: name })], bindings: set }, trusted, NOW).length, 1, name);
  }
  const signed = statementFor(set, SNAP_A);
  const body = (length: number) => ({ ...good, setup: { kind: "fixture", method: "POST", path: "/api/test/accounts", body: `{{key}}${"x".repeat(length - 7)}` } });
  assert.match(refused({ statements: [signed], bindings: [body(4_001)] }), /binding 1 is malformed/);
  assert.doesNotMatch(refused({ statements: [signed], bindings: [body(4_000)] }), /malformed/);
  assert.match(refused({ statements: [signed], bindings: [{ ...good, quote: { start: 200_000, end: 200_001 } }] }), /binding 1 is malformed/);
});

test("a snapshot presented at another hash than the request carries it at is not the run's snapshot", () => {
  const set = [binding()];
  const run = authorisedRun();
  const other = sha256Hex(`${TEXT_A}other`);
  // A caller that built the run itself: the snapshot's text and hash agree with each other, and not with the request.
  const swapped = { ...run, snapshots: run.snapshots.map((snapshot) => (snapshot.id === SNAP_A.id ? { ...snapshot, content: `${TEXT_A}other`, sha256: other } : snapshot)) } as AuthorisedRun;
  const forOther = [binding({ snapshotSha256: other })];
  assert.match(refused({ statements: [statementFor(forOther, { ...SNAP_A, sha256: other })], bindings: forOther }, swapped), /a criteria snapshot this run does not carry/);
});

test("a snapshot that is not among the request's own criteria is not part of the run, whoever built the run", () => {
  const set = [binding()];
  const run = authorisedRun(request({ criteria: [SNAP_B] }));
  // A caller that put a snapshot beside the request's criteria, outside what the scope hash covers.
  const widened = { ...run, snapshots: [...run.snapshots, { ...SNAP_A, approverVerified: true, authority: run.snapshots[0]!.authority }] } as unknown as AuthorisedRun;
  const raw = request({ criteria: [SNAP_B] });
  assert.match(refused({ statements: [statementFor(set, SNAP_A, {}, controlPlane.privateKey, raw)], bindings: set }, widened), /a criteria snapshot this run does not carry/);
});
