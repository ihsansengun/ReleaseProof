// KAN-16: a criteria snapshot may set expected values only if the control
// plane approved it for this run. These tests are about that check. Keys are
// made here for the tests; no model and no browser is involved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { authoriseForExecution, authoriseRemoteRun, directoryLedger, isStartable, runStartKey, loadTrustedKeys, memoryLedger, scopeSha256, signedStatement, type Approval, type TrustedKeys } from "../src/remote/authority.ts";
import { admitRemoteRun, RemoteRequestRefused, sha256Hex } from "../src/remote/request.ts";

const NOW = new Date("2026-11-21T12:00:00Z");
const CRITERIA = "1. A first paid order adds 100 points.\n";
const RUN = "a0000000-0000-4000-8000-000000000401";
const WORKSPACE = "a0000000-0000-4000-8000-00000000000a";
const PROJECT = "a0000000-0000-4000-8000-000000000101";
const OTHER = "b0000000-0000-4000-8000-000000000401";

const controlPlane = generateKeyPairSync("ed25519");
const someoneElse = generateKeyPairSync("ed25519");
const trusted: TrustedKeys = new Map([["control-plane-2026-11", controlPlane.publicKey]]);

function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: "checkout-r3", content: CRITERIA, sha256: sha256Hex(CRITERIA), approvedBy: "owner-a@releaseproof.test", approvedAt: "2026-11-20T09:30:00Z", ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestVersion: 1,
    runId: RUN,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["shop.releaseproof.test"] },
    criteria: [snapshot()],
    limits: { maxUsd: 1, maxScenarios: 5, maxMinutes: 10 },
    ...overrides,
  };
}

/** What the control plane would issue. `key` lets a test sign with the wrong key. */
function approval(overrides: Partial<Approval> = {}, key: KeyObject = controlPlane.privateKey): Approval {
  const statement = {
    approvalVersion: 1 as const,
    keyId: "control-plane-2026-11",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    runId: RUN,
    targetOrigin: "https://shop.releaseproof.test",
    scopeSha256: scopeSha256(request()),
    snapshotId: "checkout-r3",
    snapshotSha256: sha256Hex(CRITERIA),
    approvedBy: "owner-a@releaseproof.test",
    approvedAt: "2026-11-20T09:30:00Z",
    issuedAt: "2026-11-21T11:55:00Z",
    expiresAt: "2026-11-21T13:55:00Z",
    ...overrides,
  };
  delete (statement as Partial<Approval>).signature;
  return { ...statement, signature: sign(null, Buffer.from(signedStatement(statement), "utf8"), key).toString("base64url") };
}

function refusal(raw: unknown, evidence: unknown, keys: TrustedKeys = trusted): string {
  const admitted = admitRemoteRun(raw, NOW);
  try {
    authoriseRemoteRun(admitted, evidence, keys, NOW);
  } catch (error) {
    assert.ok(error instanceof RemoteRequestRefused, `expected a refusal, got ${error}`);
    return error.reasons.join(" | ");
  }
  assert.fail("the run was authorised");
}

// ---- criterion 2: an approved snapshot is authoritative ------------------------

test("KAN-16 criterion 2: a snapshot with a valid approval for this run is authoritative", () => {
  const authorised = authoriseRemoteRun(admitRemoteRun(request(), NOW), [approval()], trusted, NOW);
  assert.equal(authorised.snapshots.length, 1);
  const [only] = authorised.snapshots;
  assert.equal(only.approverVerified, true);
  assert.equal(only.integrity, "hash-matched");
  assert.deepEqual(only.authority, {
    keyId: "control-plane-2026-11",
    approvedBy: "owner-a@releaseproof.test",
    approvedAt: "2026-11-20T09:30:00Z",
    issuedAt: "2026-11-21T11:55:00Z",
    expiresAt: "2026-11-21T13:55:00Z",
  });
});

// ---- replay: an approval starts one run, the one the caller asked for ----------

const EXPECTED = { runId: RUN, workspaceId: WORKSPACE, projectId: PROJECT };

test("KAN-16 criterion 4: a request and approval presented a second time are refused", () => {
  const ledger = memoryLedger();
  const start = () => authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected: EXPECTED, ledger, now: NOW });
  assert.equal(start().snapshots.length, 1);
  assert.throws(start, /already been started once/);
  assert.throws(start, RemoteRequestRefused);
});

test("KAN-16 criterion 4: a started run stays started for every later ledger opened on the same directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-ledger-"));
  const start = () =>
    authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected: EXPECTED, ledger: directoryLedger(dir), now: NOW });
  assert.equal(start().snapshots.length, 1);
  assert.throws(start, /already been started once/);
});

// ---- the set of criteria is part of what is approved ----------------------------

const SECOND = "2. A refund returns the points.\n";
const twoSnapshots = () => request({ criteria: [snapshot(), snapshot({ id: "refund-r1", content: SECOND, sha256: sha256Hex(SECOND) })] });
const approvalsForTwo = () => {
  const scope = scopeSha256(twoSnapshots());
  return [approval({ scopeSha256: scope }), approval({ scopeSha256: scope, snapshotId: "refund-r1", snapshotSha256: sha256Hex(SECOND) })];
};

test("KAN-16 criterion 4: approved criteria cannot be left out of a run", () => {
  // The control plane approved a run with two snapshots. The request keeps one.
  const [first, second] = approvalsForTwo();
  assert.match(refusal(request(), [first]), /different target address, set of allowed hosts, limits or set of criteria/);
  const onlySecond = request({ criteria: [snapshot({ id: "refund-r1", content: SECOND, sha256: sha256Hex(SECOND) })] });
  assert.match(refusal(onlySecond, [second]), /set of criteria/);
  assert.equal(authoriseRemoteRun(admitRemoteRun(twoSnapshots(), NOW), [first, second], trusted, NOW).snapshots.length, 2);
});

test("KAN-16 criterion 4: criteria cannot be added to an approved run", () => {
  // Approved with one snapshot; the request adds a second with a genuine approval issued for some other shape of run.
  const extra = approval({ snapshotId: "refund-r1", snapshotSha256: sha256Hex(SECOND) });
  assert.match(refusal(twoSnapshots(), [approval(), extra]), /set of criteria/);
});

test("the criteria are bound as a set: their sequence does not matter", () => {
  const reversed = request({ criteria: [...twoSnapshots().criteria].reverse() });
  assert.equal(scopeSha256(reversed as never), scopeSha256(twoSnapshots() as never));
});

test("KAN-16 criterion 4: one run starts once, even with a re-issued approval", () => {
  const ledger = memoryLedger();
  const start = (evidence: Approval[]) => authoriseForExecution(admitRemoteRun(request(), NOW), evidence, trusted, { expected: EXPECTED, ledger, now: NOW });
  assert.equal(start([approval()]).snapshots.length, 1);
  // A second, equally genuine approval for the same run, signed later.
  const reissued = approval({ issuedAt: "2026-11-21T11:58:00Z" });
  assert.notEqual(reissued.signature, approval().signature);
  assert.throws(() => start([reissued]), /already been started once/);
});

test("two snapshots are claimed as one run, with one claim", () => {
  const ledger = memoryLedger();
  let claims = 0;
  const counting = { claim: (key: string) => ((claims += 1), ledger.claim(key)) };
  const start = () => authoriseForExecution(admitRemoteRun(twoSnapshots(), NOW), approvalsForTwo(), trusted, { expected: EXPECTED, ledger: counting, now: NOW });
  assert.equal(start().snapshots.length, 2);
  assert.equal(claims, 1);
  assert.throws(start, /already been started once/);
});

test("KAN-16 criterion 4: an approved run split into two requests starts at most once, and only whole", () => {
  const ledger = memoryLedger();
  const [first, second] = approvalsForTwo();
  const start = (raw: unknown, evidence: Approval[]) => authoriseForExecution(admitRemoteRun(raw, NOW), evidence, trusted, { expected: EXPECTED, ledger, now: NOW });
  const onlySecond = request({ criteria: [snapshot({ id: "refund-r1", content: SECOND, sha256: sha256Hex(SECOND) })] });
  assert.throws(() => start(request(), [first]), /set of criteria/);
  assert.throws(() => start(onlySecond, [second]), /set of criteria/);
  assert.equal(start(twoSnapshots(), [first, second]).snapshots.length, 2);
  assert.throws(() => start(twoSnapshots(), [first, second]), /already been started once/);
});

test("the authority check refuses admitted snapshots that are not exactly what the request carries", () => {
  const admitted = admitRemoteRun(twoSnapshots(), NOW);
  const evidence = approvalsForTwo();
  for (const snapshots of [[], [admitted.snapshots[0]], [...admitted.snapshots].reverse(), [...admitted.snapshots, admitted.snapshots[0]]]) {
    assert.throws(() => authoriseRemoteRun({ ...admitted, snapshots }, evidence, trusted, NOW), /not exactly the criteria the request carries/);
    assert.throws(
      () => authoriseForExecution({ ...admitted, snapshots }, evidence, trusted, { expected: EXPECTED, ledger: memoryLedger(), now: NOW }),
      /not exactly the criteria the request carries/,
    );
  }
});

test("only the object authoriseForExecution returned is startable: a checked run, a copy or a cast is not", () => {
  const checked = authoriseRemoteRun(admitRemoteRun(request(), NOW), [approval()], trusted, NOW);
  const startable = authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected: EXPECTED, ledger: memoryLedger(), now: NOW });
  assert.equal(isStartable(startable), true);
  assert.equal(isStartable(checked), false);
  assert.equal(isStartable({ ...startable }), false);
  assert.equal(isStartable(checked as unknown as typeof startable), false);
  assert.equal(isStartable(null), false);
});

test("a run has one ledger key however its ids are spelled", () => {
  const upper = { runId: RUN.toUpperCase(), workspaceId: WORKSPACE.toUpperCase(), projectId: PROJECT.toUpperCase() };
  assert.equal(runStartKey(upper), runStartKey(EXPECTED));
  assert.notEqual(runStartKey({ ...EXPECTED, runId: OTHER }), runStartKey(EXPECTED));
  assert.throws(() => runStartKey({ ...EXPECTED, runId: "a\nb" }), /three ids/);
});

test("a ledger directory that does not exist is an error, never a fresh ledger", () => {
  assert.throws(() => directoryLedger(path.join(tmpdir(), "rp-ledger-absent", String(process.pid))), /does not exist/);
});

for (const field of ["snapshotId", "scopeSha256", "issuedAt", "expiresAt"] as const) {
  test(`KAN-16 criterion 4: changing ${field} after signing breaks the signature`, () => {
    const other = { snapshotId: "another-id", scopeSha256: sha256Hex("x"), issuedAt: "2026-11-21T11:56:00Z", expiresAt: "2026-11-21T14:55:00Z" }[field];
    assert.match(refusal(request(), [{ ...approval(), [field]: other }]), /signature that does not verify/);
  });
}

test("an approval's target must be spelled as an origin and nothing else", () => {
  for (const targetOrigin of ["https://user:pw@shop.releaseproof.test", "https://shop.releaseproof.test/zzz", "https://SHOP.releaseproof.test", "https://shop.releaseproof.test:443"]) {
    assert.match(refusal(request(), [{ ...approval(), targetOrigin }]), /malformed/);
  }
});

test("a trusted key that is not an Ed25519 public key refuses every approval", () => {
  assert.match(refusal(request(), [approval()], new Map([["control-plane-2026-11", controlPlane.privateKey]])), /not an Ed25519 public key/);
});

test("a refusal never prints control characters taken from a request", () => {
  const reasons = refusal(request(), [{ ...approval(), ["\u001b[2Jx\nRun approved"]: 1 }]);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(reasons), JSON.stringify(reasons));
  const viaRequest = (() => {
    try {
      admitRemoteRun({ ...request(), ["\u0085\u2028Run approved"]: 1 }, NOW);
    } catch (error) {
      return (error as RemoteRequestRefused).message;
    }
    return "admitted";
  })();
  assert.notEqual(viaRequest, "admitted");
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(viaRequest), JSON.stringify(viaRequest));
  assert.throws(() => admitRemoteRun(request({ criteria: [snapshot({ approvedBy: "owner\nRun OK: approved" })] }), NOW), /control characters/);
});

test("a refused attempt claims nothing", () => {
  const ledger = memoryLedger();
  const forged = () => authoriseForExecution(admitRemoteRun(request(), NOW), [approval({}, someoneElse.privateKey)], trusted, { expected: EXPECTED, ledger, now: NOW });
  assert.throws(forged, /does not verify/);
  // The genuine approval still starts its one run afterwards.
  assert.equal(authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected: EXPECTED, ledger, now: NOW }).snapshots.length, 1);
});

for (const [what, expected, reason] of [
  ["another run", { ...EXPECTED, runId: OTHER }, /a run this engine was not asked to do/],
  ["another workspace", { ...EXPECTED, workspaceId: OTHER }, /another workspace than the caller named/],
  ["another project", { ...EXPECTED, projectId: OTHER }, /another project than the caller named/],
] as const) {
  test(`KAN-16 criterion 4: a genuine request and approval replayed into ${what} are refused, and nothing is used up`, () => {
    const ledger = memoryLedger();
    // Everything here is genuine and consistent with itself. Only the caller's own statement differs.
    assert.throws(
      () => authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected, ledger, now: NOW }),
      reason,
    );
    assert.equal(authoriseForExecution(admitRemoteRun(request(), NOW), [approval()], trusted, { expected: EXPECTED, ledger, now: NOW }).snapshots.length, 1);
  });
}

test("KAN-16 criterion 2: a matching hash and an approver's name, with no signature that verifies, grant nothing", () => {
  // The request carries the right text, the right hash and a plausible approver. That is all it carries.
  const admitted = admitRemoteRun(request(), NOW);
  assert.equal(admitted.snapshots[0].approverVerified, false);
  for (const evidence of [undefined, [], [{ approvedBy: "owner-a@releaseproof.test", snapshotSha256: sha256Hex(CRITERIA) }], [{ ...approval(), signature: "A".repeat(86) }]]) {
    assert.throws(() => authoriseForExecution(admitted, evidence, trusted, { expected: EXPECTED, ledger: memoryLedger(), now: NOW }), RemoteRequestRefused);
  }
});

test("KAN-16 criterion 2: every snapshot needs its own approval", () => {
  const second = "Refunds return points.\n";
  const two = request({ criteria: [snapshot(), snapshot({ id: "refund-r1", content: second, sha256: sha256Hex(second) })] });
  const scope = scopeSha256(two);
  assert.match(refusal(two, [approval({ scopeSha256: scope })]), /"refund-r1" has no valid approval/);
  const both = [approval({ scopeSha256: scope }), approval({ scopeSha256: scope, snapshotId: "refund-r1", snapshotSha256: sha256Hex(second) })];
  assert.equal(authoriseRemoteRun(admitRemoteRun(two, NOW), both, trusted, NOW).snapshots.length, 2);
});

test("KAN-16 criterion 2: an approval that was not asked for does no harm and grants nothing extra", () => {
  const extra = approval({ snapshotId: "something-else", snapshotSha256: sha256Hex("x") });
  const authorised = authoriseRemoteRun(admitRemoteRun(request(), NOW), [extra, approval()], trusted, NOW);
  assert.deepEqual(authorised.snapshots.map((s) => s.id), ["checkout-r3"]);
});

// ---- criterion 3 and 4: missing, forged, mismatched or unapproved is refused ---

for (const [what, evidence, reason] of [
  ["no approval evidence at all", undefined, /missing or is not a list/],
  ["evidence that is not a list", { approval: "yes" }, /missing or is not a list/],
  ["an empty list", [], /"checkout-r3" has no valid approval/],
  ["more approvals than are ever needed", Array.from({ length: 41 }, () => ({})), /more than 40 approvals/],
] as const) {
  test(`KAN-16 criterion 4: ${what} is refused`, () => {
    assert.match(refusal(request(), evidence), reason);
  });
}

// ---- the approval covers where the run may go and what it may spend ------------

for (const [what, changed] of [
  ["another path on the approved host", { target: { baseUrl: "https://shop.releaseproof.test/admin/delete?x=1", allowedHosts: ["shop.releaseproof.test"] } }],
  ["an extra allowed host", { target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["shop.releaseproof.test", "attacker.releaseproof.test"] } }],
  ["a higher spending limit", { limits: { maxUsd: 100, maxScenarios: 5, maxMinutes: 10 } }],
  ["more scenarios", { limits: { maxUsd: 1, maxScenarios: 50, maxMinutes: 10 } }],
  ["more minutes", { limits: { maxUsd: 1, maxScenarios: 5, maxMinutes: 120 } }],
] as const) {
  test(`KAN-16 criterion 4: an approval does not stretch to ${what}`, () => {
    // The approval is genuine and was issued for the unchanged request.
    assert.match(refusal(request(changed), [approval()]), /different target address, set of allowed hosts, limits or set of criteria/);
  });
}

test("the allowed hosts are bound as a set: their sequence does not matter", () => {
  const hosts = (list: string[]) => request({ target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: list } });
  const forward = hosts(["shop.releaseproof.test", "cdn.releaseproof.test"]);
  const backward = hosts(["cdn.releaseproof.test", "shop.releaseproof.test"]);
  assert.equal(scopeSha256(forward), scopeSha256(backward));
  const issued = approval({ scopeSha256: scopeSha256(forward) });
  assert.equal(authoriseRemoteRun(admitRemoteRun(backward, NOW), [issued], trusted, NOW).snapshots.length, 1);
});

test("the authority check recomputes the hash itself and does not rely on who built its input", () => {
  const admitted = admitRemoteRun(request(), NOW);
  const swapped = { ...admitted, snapshots: admitted.snapshots.map((s) => ({ ...s, content: "Everything is free.\n" })) };
  assert.throws(() => authoriseRemoteRun(swapped, [approval()], trusted, NOW), /does not match its hash/);
});

test("a signature has one accepted spelling", () => {
  const good = approval();
  const last = good.signature.at(-1)!;
  // Same 512 bits, different spare bits in the last character.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = good.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
  assert.match(refusal(request(), [{ ...good, signature: twin }]), /not in canonical base64url/);
});

for (const [what, times, reason] of [
  ["expires exactly now", { expiresAt: "2026-11-21T12:00:00Z" }, /it has expired/],
  ["expires before it was issued", { issuedAt: "2026-11-21T12:04:00Z", expiresAt: "2026-11-21T12:01:00Z" }, /expires before it was issued/],
  ["was issued before the approval it states", { issuedAt: "2026-11-20T09:00:00Z", expiresAt: "2026-11-21T08:00:00Z" }, /issued before the approval it states/],
  ["is dated more than five minutes ahead", { issuedAt: "2026-11-21T12:05:01Z" }, /dated in the future/],
] as const) {
  test(`KAN-16 criterion 4: an approval that ${what} is refused`, () => {
    assert.match(refusal(request(), [approval(times)]), reason);
  });
}

test("an approval issued up to five minutes ahead of this clock is accepted", () => {
  const issued = approval({ issuedAt: "2026-11-21T12:05:00Z" });
  assert.equal(authoriseRemoteRun(admitRemoteRun(request(), NOW), [issued], trusted, NOW).snapshots.length, 1);
});

test("a key id that is not plain printable characters is refused before it is printed", () => {
  const reasons = refusal(request(), [{ ...approval(), keyId: "zz\u001b[2J" }]);
  assert.match(reasons, /malformed/);
  assert.ok(!reasons.includes("\u001b"));
});

test("KAN-16 criterion 4: an approval signed with a key that is not the control plane's is refused", () => {
  assert.match(refusal(request(), [approval({}, someoneElse.privateKey)]), /signature that does not verify/);
});

test("KAN-16 criterion 4: an approval that names its own key is refused, even with a valid signature by that key", () => {
  const selfIssued = approval({ keyId: "attacker-key" }, someoneElse.privateKey);
  assert.match(refusal(request(), [selfIssued]), /names a key that is not trusted/);
});

test("KAN-16 criterion 4: with no trusted key, nothing is authoritative", () => {
  assert.match(refusal(request(), [approval()], new Map()), /no trusted approval key/);
});

for (const [what, field, value] of [
  ["another run", "runId", OTHER],
  ["another workspace", "workspaceId", OTHER],
  ["another project", "projectId", OTHER],
  ["another target", "targetOrigin", "https://evil.releaseproof.test"],
  ["different text", "snapshotSha256", sha256Hex("Everything is free.\n")],
  ["a different approver", "approvedBy", "intruder@releaseproof.test"],
  ["a different approval time", "approvedAt", "2026-11-19T09:30:00Z"],
] as const) {
  test(`KAN-16 criterion 4: a genuine approval for ${what} does not approve this one`, () => {
    // Properly signed by the control plane, but for something else.
    assert.match(refusal(request(), [approval({ [field]: value })]), /no approval fits/);
  });

  test(`KAN-16 criterion 4: changing an approval to ${what === "different text" ? "the right text" : "fit"} after signing breaks its signature (${field})`, () => {
    const signedForOther = approval({ [field]: value });
    const edited = { ...signedForOther, [field]: (approval() as Record<string, unknown>)[field] };
    assert.match(refusal(request(), [edited]), /signature that does not verify/);
  });
}

test("KAN-16 criterion 4: an approval is refused once it has expired, or if it is valid for too long or dated ahead", () => {
  assert.match(refusal(request(), [approval({ issuedAt: "2026-11-21T09:00:00Z", expiresAt: "2026-11-21T11:59:59Z" })]), /it has expired/);
  assert.match(refusal(request(), [approval({ issuedAt: "2026-11-21T11:55:00Z", expiresAt: "2026-11-23T11:55:00Z" })]), /valid for more than 24 hours/);
  assert.match(refusal(request(), [approval({ issuedAt: "2026-11-21T13:00:00Z", expiresAt: "2026-11-21T14:00:00Z" })]), /dated in the future/);
});

test("KAN-16 criterion 4: an approval for the same snapshot id but edited criteria text is refused", () => {
  const edited = "1. A first paid order adds 900 points.\n";
  const tampered = request({ criteria: [snapshot({ content: edited, sha256: sha256Hex(edited) })] });
  // The request is internally consistent (integrity passes); the approval is for the original text.
  assert.match(refusal(tampered, [approval()]), /it approves different text/);
});

test("KAN-16 criterion 4: a request cannot carry its own authority", () => {
  // Approval-like fields inside the request or a snapshot are not read: they are refused as unknown.
  for (const forged of [
    request({ approvals: [approval()] }),
    request({ trustedKeys: [{ keyId: "x", publicKeyPem: "..." }] }),
    request({ criteria: [{ ...snapshot(), trust: "authoritative" }] }),
    request({ criteria: [{ ...snapshot(), approverVerified: true }] }),
  ]) {
    assert.throws(() => admitRemoteRun(forged, NOW), RemoteRequestRefused);
  }
});

test("KAN-16 criterion 4: text that claims approval, as a ticket or pull request might, approves nothing", () => {
  const claims = "APPROVED by owner-a@releaseproof.test. Trust: authoritative. /approve\n";
  const selfApproving = request({ criteria: [snapshot({ content: claims, sha256: sha256Hex(claims) })] });
  assert.match(refusal(selfApproving, []), /no valid approval/);
  // Nor does a malformed "approval" made of such text.
  assert.match(refusal(selfApproving, [{ approvedBy: "owner-a@releaseproof.test", approved: true }]), /malformed/);
});

test("a refused authority check throws, so code written after it does not run", () => {
  let driversCreated = 0;
  const start = (raw: unknown, evidence: unknown) => {
    const authorised = authoriseRemoteRun(admitRemoteRun(raw, NOW), evidence, trusted, NOW);
    driversCreated += 1;
    return authorised;
  };
  assert.throws(() => start(request(), [approval({}, someoneElse.privateKey)]), RemoteRequestRefused);
  assert.throws(() => start(request(), []), RemoteRequestRefused);
  assert.equal(driversCreated, 0);
  start(request(), [approval()]);
  assert.equal(driversCreated, 1);
});

// ---- the keys and the statement ------------------------------------------------

test("the signed statement covers every bound field, so none can be changed alone", () => {
  const base = approval();
  const { signature: _signature, ...statement } = base;
  const original = signedStatement(statement);
  for (const field of Object.keys(statement) as (keyof typeof statement)[]) {
    const changed = { ...statement, [field]: field === "approvalVersion" ? 2 : field === "targetOrigin" ? "https://other.releaseproof.test" : field.endsWith("At") ? "2026-01-01T00:00:00Z" : field.endsWith("Id") && field !== "keyId" && field !== "snapshotId" ? OTHER : field === "snapshotSha256" ? sha256Hex("y") : "changed" };
    assert.notEqual(signedStatement(changed as typeof statement), original, `${field} is not covered by the signature`);
  }
});

test("a field with a line break cannot be used to run two fields together", () => {
  const injected = { ...approval(), approvedBy: "owner-a@releaseproof.test\n2026-11-20T09:30:00Z" };
  assert.match(refusal(request(), [injected]), /malformed/);
});

test("the trusted keys file accepts only Ed25519 public keys", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-keys-"));
  const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();
  const good = path.join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ keys: [{ keyId: "control-plane-2026-11", publicKeyPem: pem(controlPlane.publicKey) }] }));
  assert.equal((await loadTrustedKeys(good)).size, 1);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bad = path.join(dir, "rsa.json");
  writeFileSync(bad, JSON.stringify({ keys: [{ keyId: "rsa", publicKeyPem: pem(rsa.publicKey) }] }));
  await assert.rejects(loadTrustedKeys(bad), /not an Ed25519 public key/);

  const twice = path.join(dir, "twice.json");
  writeFileSync(twice, JSON.stringify({ keys: [{ keyId: "k", publicKeyPem: pem(controlPlane.publicKey) }, { keyId: "k", publicKeyPem: pem(someoneElse.publicKey) }] }));
  await assert.rejects(loadTrustedKeys(twice), /more than once/);

  // A private key would otherwise be read as its public half.
  const secret = path.join(dir, "private.json");
  writeFileSync(secret, JSON.stringify({ keys: [{ keyId: "k", publicKeyPem: controlPlane.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }] }));
  await assert.rejects(loadTrustedKeys(secret), /not a public key in PEM form/);
});

test("the command authorises a run only with approvals that verify against the keys it was given", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-authority-"));
  const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  // Approvals made now, so that they are current when the command reads the clock.
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const file = (name: string, value: unknown) => {
    writeFileSync(path.join(dir, name), JSON.stringify(value));
    return path.join(dir, name);
  };
  const requestFile = file("request.json", request());
  const keys = file("keys.json", { keys: [{ keyId: "control-plane-2026-11", publicKeyPem: controlPlane.publicKey.export({ type: "spki", format: "pem" }).toString() }] });
  const EXPECT = ["--expect-run", RUN, "--expect-workspace", WORKSPACE, "--expect-project", PROJECT];
  const run = (approvals: string) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "check-remote-request", requestFile, "--approvals", approvals, "--authority-keys", keys, ...EXPECT], { env }).then(
      (out) => ({ code: 0, text: out.stdout + out.stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, text: error.stdout + error.stderr }),
    );

  const good = await run(file("good.json", [approval({ issuedAt, expiresAt })]));
  assert.equal(good.code, 0, good.text);
  assert.match(good.text, /approved for this run/);

  const forged = await run(file("forged.json", [approval({ issuedAt, expiresAt }, someoneElse.privateKey)]));
  assert.equal(forged.code, 2, forged.text);
  assert.match(forged.text, /does not verify/);

  const none = await run(file("none.json", []));
  assert.equal(none.code, 2, none.text);
  assert.match(none.text, /has no valid approval/);

  // Authority is never skipped by leaving a flag out or empty.
  const bare = (...flags: string[]) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "check-remote-request", requestFile, ...flags], { env }).then(
      (out) => ({ code: 0, text: out.stdout + out.stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, text: error.stdout + error.stderr }),
    );
  for (const flags of [[], ["--approvals", ""], ["--approvals", "", "--authority-keys", ""], ["--approvals=", "--authority-keys="], ["--authority-keys", keys]]) {
    const result = await bare(...flags);
    assert.equal(result.code, 2, `${JSON.stringify(flags)}: ${result.text}`);
    assert.match(result.text, /needs --approvals and --authority-keys/);
  }
  const mixed = await bare("--integrity-only", "--approvals", file("mixed.json", []));
  assert.equal(mixed.code, 2, mixed.text);

  const integrity = await bare("--integrity-only");
  assert.equal(integrity.code, 0, integrity.text);
  assert.match(integrity.text, /authority was NOT checked/);

  const good2 = file("good2.json", [approval({ issuedAt, expiresAt })]);
  const noExpectation = await bare("--approvals", good2, "--authority-keys", keys);
  assert.equal(noExpectation.code, 2, noExpectation.text);
  assert.match(noExpectation.text, /needs --expect-run, --expect-workspace and --expect-project/);
  const otherRun = await bare("--approvals", good2, "--authority-keys", keys, "--expect-run", OTHER, "--expect-workspace", WORKSPACE, "--expect-project", PROJECT);
  assert.equal(otherRun.code, 2, otherRun.text);
  assert.match(otherRun.text, /a run this engine was not asked to do/);

  const unreadable = await bare("--approvals", file("broken.json", "x").replace("broken.json", "absent.json"), "--authority-keys", keys, ...EXPECT);
  assert.equal(unreadable.code, 2, unreadable.text);
  assert.match(unreadable.text, /approvals file could not be read/);
});

// ---- RPAI-39: one spelling in bytes, and a clock that can be read ---------------

test("RPAI-39: an approval's text has one spelling in bytes, so a field cannot be altered into one that signs the same", () => {
  // Written out as UTF-8 for signing, half of a surrogate pair becomes U+FFFD. An approval signed with U+FFFD in
  // the approver's name must not also stand for one with half a pair there. The request is not signed, so whoever
  // writes it can make its snapshot name the altered approver too.
  const signedBy = "owner\ufffd@releaseproof.test";
  const genuineRequest = request({ criteria: [snapshot({ approvedBy: signedBy })] });
  const genuine = approval({ approvedBy: signedBy, scopeSha256: scopeSha256(genuineRequest) });
  assert.equal(authoriseRemoteRun(admitRemoteRun(genuineRequest, NOW), [genuine], trusted, NOW).snapshots[0]!.authority.approvedBy, signedBy);

  for (const half of ["\ud800", "\udbff", "\udc00", "\udfff"]) {
    const alteredBy = `owner${half}@releaseproof.test`;
    const alteredRequest = request({ criteria: [snapshot({ approvedBy: alteredBy })] });
    // The scope does not cover the approver's name, so the signature still fits: only the text's form stops it.
    assert.equal(scopeSha256(alteredRequest), scopeSha256(genuineRequest));
    // A request that names the altered approver is not admitted at all.
    assert.throws(() => admitRemoteRun(alteredRequest, NOW), RemoteRequestRefused);
    assert.notEqual(signedStatement({ ...genuine, approvedBy: alteredBy }), signedStatement(genuine), "as text the two differ");
    assert.equal(Buffer.from(signedStatement({ ...genuine, approvedBy: alteredBy }), "utf8").equals(Buffer.from(signedStatement(genuine), "utf8")), true, "the two would be signed as the same bytes");
    const altered = { ...genuine, approvedBy: alteredBy };
    // And the approval is refused for its own form, whatever request it is presented with.
    assert.match(refusal(genuineRequest, [altered]), /approval 1 is malformed: approvedBy must be well-formed Unicode/);
    assert.match(refusal(genuineRequest, [JSON.parse(JSON.stringify(altered))]), /approval 1 is malformed: approvedBy must be well-formed Unicode/);
  }
  // In the snapshot's id as well.
  assert.match(refusal(request(), [{ ...approval(), snapshotId: "checkout-r3\ud800" }]), /approval 1 is malformed: snapshotId must be well-formed Unicode/);
});

test("RPAI-39: well-formed text in any script is still accepted in an approval, a pair of surrogates included", () => {
  for (const name of ["Zo\u00eb Owner", "\u05d1\u05e2\u05dc\u05d9\u05dd", "\u6240\u6709\u8005", "owner \u{1f600}", "\u{20000}", "owner\ufffd"]) {
    const raw = request({ criteria: [snapshot({ approvedBy: name })] });
    const authorised = authoriseRemoteRun(admitRemoteRun(raw, NOW), [approval({ approvedBy: name, scopeSha256: scopeSha256(raw) })], trusted, NOW);
    assert.equal(authorised.snapshots[0]!.authority.approvedBy, name);
  }
});

test("RPAI-39: a time now that cannot be read refuses the run: nothing is taken as not yet expired", () => {
  const raw = request();
  const admitted = admitRemoteRun(raw, NOW);
  const longExpired = approval({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T01:00:00Z", approvedAt: "2020-01-01T00:00:00Z" });
  const old = request({ criteria: [snapshot({ approvedAt: "2020-01-01T00:00:00Z" })] });
  // With a clock, it has expired.
  assert.throws(() => authoriseRemoteRun(admitRemoteRun(old, NOW), [{ ...longExpired, scopeSha256: scopeSha256(old) }], trusted, NOW), RemoteRequestRefused);
  // A thing that only looks like a date is not a clock.
  const unreadable: unknown[] = [new Date("not a date"), new Date(Number.NaN), new Date(8.64e15 + 1), "2026-11-21T12:00:00Z", 1_795_000_000_000, null, { getTime: () => NOW.getTime() }, Object.create(Date.prototype)];
  for (const clock of unreadable) {
    const reasons = (work: () => unknown) => {
      try {
        work();
      } catch (error) {
        assert.ok(error instanceof RemoteRequestRefused, String(error));
        return error.reasons.join(" | ");
      }
      assert.fail(`accepted with the clock ${String(clock)}`);
    };
    // A genuine, current approval is refused too: without a clock nothing can be said to be current.
    assert.match(reasons(() => authoriseRemoteRun(admitted, [approval()], trusted, clock as Date)), /the time now cannot be read, so no approval can be checked/);
    // Where the clock is an option, "none given" means the machine's own, as before; anything else given must be readable.
    if (clock !== null) assert.match(reasons(() => authoriseForExecution(admitted, [approval()], trusted, { expected: EXPECTED, ledger: memoryLedger(), now: clock as Date })), /the time now cannot be read/);
    // And a request is not admitted: its snapshots' dates could not be compared with anything.
    assert.match(reasons(() => admitRemoteRun(request({ criteria: [snapshot({ approvedAt: "2999-01-01T00:00:00Z" })] }), clock as Date)), /the time now cannot be read, so the request cannot be admitted/);
  }
  // With no clock given, the machine's own is used, as before.
  assert.throws(() => authoriseRemoteRun(admitted, [approval()], trusted), RemoteRequestRefused);
});

test("RPAI-39: with a readable clock everything is as it was: the same approval is accepted, expired and future-dated ones refused", () => {
  const admitted = admitRemoteRun(request(), NOW);
  assert.equal(authoriseRemoteRun(admitted, [approval()], trusted, NOW).snapshots.length, 1);
  assert.match(refusal(request(), [approval({ expiresAt: "2026-11-21T12:00:00Z" })]), /it has expired/);
  assert.match(refusal(request(), [approval({ issuedAt: "2026-11-21T12:05:01Z" })]), /it is dated in the future/);
  assert.throws(() => admitRemoteRun(request({ criteria: [snapshot({ approvedAt: "2026-11-21T12:05:01Z" })] }), NOW), RemoteRequestRefused);
});

test("RPAI-39: half a surrogate pair is found wherever it stands, and whole pairs are left alone", () => {
  // The approval is what is looked at here. A request naming such an approver is refused before it gets this far,
  // so the altered approvals are presented with an ordinary request.
  const withBy = (approvedBy: string) => {
    const admissible = !/[\ud800-\udfff]/.test(approvedBy.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
    const raw = admissible ? request({ criteria: [snapshot({ approvedBy })] }) : request();
    return { raw, evidence: [approval({ approvedBy, scopeSha256: scopeSha256(raw) })] };
  };
  // Beside a whole pair, at the start, at the end, two halves the wrong way round, and one after another.
  const refusedOnes = ["\ud800\u{10000}", "\u{10000}\udc00", "\udc00\ud800", "\ud800owner", "owner\udc00", "\udc00owner", "owner\ud800", "o\ud800\ud800\udc00", "o\ud800\udc00\udc00"];
  const acceptedOnes = ["\u{10000}", "\u{10ffff}", "a\u{10000}b\u{1f600}c", "\ud7ff\ue000"];
  // One refused straight after another, the second with its half earlier in the text than the first's: a check
  // that remembered where it last looked would miss it.
  const late = withBy("owner-name\udc00x");
  const early = withBy("\udc00owner-name");
  assert.match(refusal(late.raw, late.evidence), /approvedBy must be well-formed Unicode/);
  assert.match(refusal(early.raw, early.evidence), /approvedBy must be well-formed Unicode/);
  // Turn about, so that nothing remembered from one text is carried to the next.
  for (let index = 0; index < refusedOnes.length; index += 1) {
    const bad = withBy(refusedOnes[index]!);
    assert.match(refusal(bad.raw, bad.evidence), /approvedBy must be well-formed Unicode/, JSON.stringify(refusedOnes[index]));
    const good = withBy(acceptedOnes[index % acceptedOnes.length]!);
    assert.equal(authoriseRemoteRun(admitRemoteRun(good.raw, NOW), good.evidence, trusted, NOW).snapshots.length, 1);
    assert.match(refusal(bad.raw, bad.evidence), /approvedBy must be well-formed Unicode/);
  }
});

test("RPAI-39: an approval's target is compared as the text it is: a space or a line break around it is another text, and is refused", () => {
  const genuine = approval();
  assert.equal(authoriseRemoteRun(admitRemoteRun(request(), NOW), [genuine], trusted, NOW).snapshots.length, 1);
  const origin = genuine.targetOrigin;
  for (const spelled of [` ${origin}`, `${origin} `, `${origin}\n`, `${origin}\t`, `\ufeff${origin}`, `${origin}/`, `${origin}:443`, origin.toUpperCase(), "not an address", `${origin}\ud800`, "", "ftp://shop.releaseproof.test", "wss://shop.releaseproof.test", "ws://shop.releaseproof.test", "file://shop.releaseproof.test"]) {
    // Refused as a malformed approval, by the engine's own refusal and not by an error from somewhere beneath it.
    assert.match(refusal(request(), [{ ...genuine, targetOrigin: spelled }]), /approval 1 is malformed: targetOrigin must be an origin/, JSON.stringify(spelled));
  }
});

test("RPAI-39: the clock is read once and in the standard way: a date from elsewhere is a date, and one that answers differently each time is read once", () => {
  const admitted = admitRemoteRun(request(), NOW);
  // A date made in another realm is as good a date as any.
  const elsewhere = runInNewContext(`new Date(${NOW.getTime()})`) as Date;
  assert.equal(elsewhere instanceof Date, false);
  assert.equal(authoriseRemoteRun(admitted, [approval()], trusted, elsewhere).snapshots.length, 1);
  assert.equal(admitRemoteRun(request(), elsewhere).snapshots.length, 1);
  // A date whose own answer changes is asked nothing: its time is read from the date itself, once.
  class Later extends Date {
    override getTime(): number {
      return Number.NaN;
    }
  }
  assert.equal(authoriseRemoteRun(admitted, [approval()], trusted, new Later(NOW.getTime())).snapshots.length, 1);
  assert.match(refusal(request(), [approval({ expiresAt: "2026-11-21T12:00:00Z" })]), /it has expired/);
  assert.throws(() => authoriseRemoteRun(admitted, [approval({ expiresAt: "2026-11-21T12:00:00Z" })], trusted, new Later(NOW.getTime())), RemoteRequestRefused);
  // The same one reading is what "dated in the future" is measured against, for an approval and for a snapshot.
  const later = new Later(NOW.getTime());
  assert.throws(
    () => authoriseRemoteRun(admitted, [approval({ issuedAt: "2026-11-21T12:05:01Z" })], trusted, later),
    (error: unknown) => error instanceof RemoteRequestRefused && /dated in the future/.test(error.reasons.join(" ")),
  );
  assert.throws(
    () => admitRemoteRun(request({ criteria: [snapshot({ approvedAt: "2026-11-21T12:05:01Z" })] }), later),
    (error: unknown) => error instanceof RemoteRequestRefused && /claims an approval in the future/.test(error.reasons.join(" ")),
  );
});
