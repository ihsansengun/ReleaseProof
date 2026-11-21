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
import { authoriseRemoteRun, loadTrustedKeys, signedStatement, type Approval, type TrustedKeys } from "../src/remote/authority.ts";
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

test("KAN-16 criterion 2: every snapshot needs its own approval", () => {
  const second = "Refunds return points.\n";
  const two = request({ criteria: [snapshot(), snapshot({ id: "refund-r1", content: second, sha256: sha256Hex(second) })] });
  assert.match(refusal(two, [approval()]), /"refund-r1" has no valid approval/);
  const both = [approval(), approval({ snapshotId: "refund-r1", snapshotSha256: sha256Hex(second) })];
  assert.equal(authoriseRemoteRun(admitRemoteRun(two, NOW), both, trusted, NOW).snapshots.length, 2);
});

test("KAN-16 criterion 2: an approval that was not asked for does no harm and grants nothing extra", () => {
  const extra = approval({ snapshotId: "something-else", snapshotSha256: sha256Hex("x") });
  const authorised = authoriseRemoteRun(admitRemoteRun(request(), NOW), [extra, approval()], trusted, NOW);
  assert.deepEqual(authorised.snapshots.map((s) => s.id), ["checkout-r3"]);
});

// ---- criterion 3 and 4: missing, forged, mismatched or unapproved is refused ---

for (const [what, evidence] of [
  ["no approval evidence at all", undefined],
  ["evidence that is not a list", { approval: "yes" }],
  ["an empty list", []],
] as const) {
  test(`KAN-16 criterion 4: ${what} is refused`, () => {
    assert.match(refusal(request(), evidence), /no valid approval|missing or is not a list/);
  });
}

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

test("KAN-16 criterion 3: the authority check is passed before anything that could call a model", () => {
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
});

test("the command authorises a run only with approvals that verify against the keys it was given, and holds no private key", async () => {
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
  const run = (approvals: string) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "check-remote-request", requestFile, "--approvals", approvals, "--authority-keys", keys], { env }).then(
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
});
