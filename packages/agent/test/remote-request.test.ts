// KAN-16: a run against a deployed application is started from a request
// that carries its approved criteria as snapshots. These tests are about the
// gate every such request passes before a model is called or a browser is
// opened. No model and no browser is involved in any of them.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { admitRemoteRun, loadRemoteRequest, RemoteRequestRefused, sha256Hex } from "../src/remote/request.ts";

const CRITERIA = "1. A signed-in customer sees their loyalty balance.\n2. A first paid order adds 100 points.\n";
const NOW = new Date("2026-11-21T12:00:00Z");

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "checkout-criteria-r3",
    content: CRITERIA,
    sha256: sha256Hex(CRITERIA),
    approvedBy: "owner-a@releaseproof.test",
    approvedAt: "2026-11-20T09:30:00Z",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestVersion: 1,
    runId: "a0000000-0000-4000-8000-000000000401",
    workspaceId: "a0000000-0000-4000-8000-00000000000a",
    projectId: "a0000000-0000-4000-8000-000000000101",
    target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["shop.releaseproof.test"] },
    criteria: [snapshot()],
    limits: { maxUsd: 1, maxScenarios: 5, maxMinutes: 10 },
    ...overrides,
  };
}

function reasonsFor(raw: unknown): string[] {
  try {
    admitRemoteRun(raw, NOW);
  } catch (error) {
    assert.ok(error instanceof RemoteRequestRefused, `expected a refusal, got ${error}`);
    return error.reasons;
  }
  assert.fail("the request was admitted");
}

// ---- criterion 1: a target and snapshots are enough ---------------------------

test("KAN-16 criterion 1: a target address and one snapshot are a complete request, with no pull request or ticket", () => {
  const admitted = admitRemoteRun(request(), NOW);
  assert.equal(admitted.request.target.baseUrl, "https://shop.releaseproof.test/");
  assert.equal(admitted.snapshots.length, 1);
  assert.deepEqual(Object.keys(admitted.request).sort(), ["criteria", "limits", "projectId", "requestVersion", "runId", "target", "workspaceId"]);
});

test("KAN-16 criterion 1: several snapshots are admitted together, in the order given", () => {
  const second = "Refunds return the points they earned.\n";
  const admitted = admitRemoteRun(
    request({ criteria: [snapshot(), snapshot({ id: "refund-criteria-r1", content: second, sha256: sha256Hex(second) })] }),
    NOW,
  );
  assert.deepEqual(admitted.snapshots.map((s) => s.id), ["checkout-criteria-r3", "refund-criteria-r1"]);
});

test("KAN-16 criterion 1: a request has no place for a pull request, ticket or repository", () => {
  for (const extra of [{ pullRequest: { repo: "o/r", number: 1 } }, { ticketKey: "KAN-1" }, { repository: "o/r" }]) {
    const reasons = reasonsFor(request(extra));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /unrecognized key/i);
  }
});

// ---- criterion 2: a matching, approved snapshot is authoritative --------------

test("KAN-16 criterion 2: a snapshot whose text matches its hash is marked intact, with its approver as claimed", () => {
  const [intact] = admitRemoteRun(request(), NOW).snapshots;
  assert.equal(intact.integrity, "hash-matched");
  assert.equal(intact.sha256, sha256Hex(CRITERIA));
  assert.equal(intact.approvedBy, "owner-a@releaseproof.test");
  assert.equal(intact.content, CRITERIA);
});

test("KAN-16 criterion 2: a matching hash does not make a snapshot authoritative", () => {
  // Anyone can write a request with a correct hash and any approver's name.
  const forged = snapshot({ approvedBy: "ceo@releaseproof.test" });
  const [intact] = admitRemoteRun(request({ criteria: [forged] }), NOW).snapshots;
  assert.equal(intact.integrity, "hash-matched");
  assert.equal(intact.approverVerified, false, "the gate never vouches for the approver");
  assert.equal("verified" in intact, false);
  assert.equal("trust" in intact, false);
});

test("KAN-16 criterion 2: the hash is of the exact text, as UTF-8", () => {
  const text = "Le total s'affiche en € — arrondi au centime.\n";
  const admitted = admitRemoteRun(request({ criteria: [snapshot({ content: text, sha256: sha256Hex(text) })] }), NOW);
  assert.equal(admitted.snapshots[0].content, text);
  // A known value, so that the function is not only compared with itself.
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

for (const [what, overrides] of [
  ["no approver", { approvedBy: undefined }],
  ["an empty approver", { approvedBy: "" }],
  ["an approver that is only spaces", { approvedBy: "   " }],
  ["no approval time", { approvedAt: undefined }],
  ["an approval time that is not a time", { approvedAt: "yesterday" }],
] as const) {
  test(`KAN-16 criterion 2: a snapshot with ${what} is refused`, () => {
    const reasons = reasonsFor(request({ criteria: [snapshot(overrides)] }));
    assert.ok(reasons.some((reason) => /criteria\.0\.approved(By|At)/.test(reason)), reasons.join("; "));
  });
}

test("KAN-16 criterion 2: an approval dated in the future is refused", () => {
  const reasons = reasonsFor(request({ criteria: [snapshot({ approvedAt: "2026-11-22T12:00:00Z" })] }));
  assert.match(reasons.join(";"), /approval in the future/);
});

// ---- criterion 3: a mismatch is rejected before any model call ----------------

for (const [what, change] of [
  ["one character changed", (text: string) => text.replace("100", "900")],
  ["a line added", (text: string) => `${text}3. Every order ships free.\n`],
  ["a line removed", (text: string) => text.split("\n").slice(1).join("\n")],
  ["trailing whitespace added", (text: string) => `${text} `],
  ["line endings changed", (text: string) => text.replaceAll("\n", "\r\n")],
  ["an invisible character inserted", (text: string) => text.replace("points", "po​ints")],
] as const) {
  test(`KAN-16 criterion 3: a snapshot with ${what} no longer matches its hash and is refused`, () => {
    const reasons = reasonsFor(request({ criteria: [snapshot({ content: change(CRITERIA) })] }));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /"checkout-criteria-r3" does not match its hash/);
    assert.ok(reasons[0].includes(sha256Hex(change(CRITERIA))), "the refusal names the hash the text really has");
  });
}

test("KAN-16 criterion 3: a hash for some other text is refused", () => {
  const reasons = reasonsFor(request({ criteria: [snapshot({ sha256: sha256Hex("something else") })] }));
  assert.match(reasons[0], /does not match its hash/);
});

test("KAN-16 criterion 3: one bad snapshot refuses the whole request, and nothing is handed on", () => {
  const good = snapshot();
  const bad = snapshot({ id: "tampered", content: "Everything is free.\n" });
  assert.throws(() => admitRemoteRun(request({ criteria: [good, bad] }), NOW), RemoteRequestRefused);
});

test("KAN-16 criterion 3: the gate is passed before anything that could call a model", async () => {
  // What a caller does: admit first, and only then create the driver.
  let driversCreated = 0;
  const start = (raw: unknown) => {
    const admitted = admitRemoteRun(raw, NOW);
    driversCreated += 1;
    return admitted;
  };
  assert.throws(() => start(request({ criteria: [snapshot({ content: "changed" })] })), RemoteRequestRefused);
  assert.equal(driversCreated, 0);
  start(request());
  assert.equal(driversCreated, 1);
});

test("KAN-16 criterion 3: the command refuses a tampered request with no model key present, and admits a sound one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-remote-"));
  const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const run = (file: string) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "check-remote-request", file, "--integrity-only"], { env }).then(
      (out) => ({ code: 0, text: out.stdout + out.stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, text: error.stdout + error.stderr }),
    );

  writeFileSync(path.join(dir, "good.json"), JSON.stringify(request()));
  writeFileSync(path.join(dir, "bad.json"), JSON.stringify(request({ criteria: [snapshot({ content: "changed" })] })));

  const good = await run(path.join(dir, "good.json"));
  assert.equal(good.code, 0, good.text);
  assert.match(good.text, /checkout-criteria-r3/);
  assert.match(good.text, new RegExp(sha256Hex(CRITERIA)));

  const bad = await run(path.join(dir, "bad.json"));
  assert.equal(bad.code, 2, bad.text);
  assert.match(bad.text, /does not match its hash/);
});

// ---- the rest of the request --------------------------------------------------

test("every reason for a refusal is given, not only the first", () => {
  const reasons = reasonsFor(
    request({
      criteria: [snapshot({ content: "changed" }), snapshot({ content: "changed again" })],
      target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["elsewhere.releaseproof.test"] },
    }),
  );
  assert.equal(reasons.length, 4);
  assert.ok(reasons.some((reason) => /more than once/.test(reason)));
  assert.ok(reasons.some((reason) => /does not include the target's own host/.test(reason)));
});

for (const [what, overrides, expected] of [
  ["no request version", { requestVersion: undefined }, /requestVersion/],
  ["a version this engine does not read", { requestVersion: 2 }, /requestVersion/],
  ["a run id that is not a UUID", { runId: "run-1" }, /runId/],
  ["no criteria", { criteria: [] }, /criteria/],
  ["a target that is not http(s)", { target: { baseUrl: "file:///etc/passwd", allowedHosts: ["shop.releaseproof.test"] } }, /target\.baseUrl/],
  ["credentials in the target address", { target: { baseUrl: "https://user:pw@shop.releaseproof.test/", allowedHosts: ["shop.releaseproof.test"] } }, /must not carry credentials/],
  ["an allowed host that is an address", { target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["shop.releaseproof.test", "127.0.0.1"] } }, /allowedHosts/],
  ["an allowed host with a wildcard", { target: { baseUrl: "https://shop.releaseproof.test/", allowedHosts: ["*.releaseproof.test"] } }, /allowedHosts/],
  ["a negative cost limit", { limits: { maxUsd: -1, maxScenarios: 5, maxMinutes: 10 } }, /limits\.maxUsd/],
  ["no scenario limit", { limits: { maxUsd: 1, maxMinutes: 10 } }, /limits\.maxScenarios/],
] as const) {
  test(`a request with ${what} is refused`, () => {
    assert.match(reasonsFor(request(overrides)).join("; "), expected);
  });
}

test("a target on a port is admitted when that host and port are allowed", () => {
  const admitted = admitRemoteRun(
    request({ target: { baseUrl: "https://shop.releaseproof.test:8443/app", allowedHosts: ["shop.releaseproof.test:8443"] } }),
    NOW,
  );
  assert.equal(admitted.request.target.allowedHosts[0], "shop.releaseproof.test:8443");
});

test("a file that is not JSON is refused with a reason, not a crash", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-remote-"));
  writeFileSync(path.join(dir, "broken.json"), "{ not json");
  await assert.rejects(loadRemoteRequest(path.join(dir, "broken.json"), NOW), RemoteRequestRefused);
  await assert.rejects(loadRemoteRequest(path.join(dir, "missing.json"), NOW), RemoteRequestRefused);
});

test("a target address that another URL parser could read differently is refused", () => {
  for (const baseUrl of ["https://shop.releaseproof.test\\@evil.releaseproof.test/", "https://ｓhop.releaseproof.test/"]) {
    assert.throws(
      () => admitRemoteRun(request({ target: { baseUrl, allowedHosts: ["shop.releaseproof.test"] } }), NOW),
      /plain ASCII with no backslash/,
    );
  }
});

// ---- RPAI-39: approved text has one spelling in bytes --------------------------

/** The reasons a request is refused with, or a failure of the test if it is admitted. */
function refusedBecause(raw: unknown): string {
  try {
    admitRemoteRun(raw, NOW);
  } catch (error) {
    assert.ok(error instanceof RemoteRequestRefused, String(error));
    return error.reasons.join(" | ");
  }
  assert.fail("the request was admitted");
}
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);

test("RPAI-39: approved text with half a surrogate pair is refused: it would share its hash with the text that has U+FFFD there", () => {
  const approved = `1. A first paid order adds 100 points ${REPLACEMENT} and no more.\n`;
  const altered = approved.replace(REPLACEMENT, HIGH);
  // The two are different texts, and hash the same: the hash is taken of the bytes, where half a pair has none of its own.
  assert.notEqual(altered, approved);
  assert.equal(sha256Hex(altered), sha256Hex(approved));
  // The text as approved is admitted, U+FFFD and all.
  assert.equal(admitRemoteRun(request({ criteria: [snapshot({ content: approved, sha256: sha256Hex(approved) })] }), NOW).snapshots[0]!.content, approved);
  // The altered one is refused, though its hash "matches".
  assert.match(refusedBecause(request({ criteria: [snapshot({ content: altered, sha256: sha256Hex(approved) })] })), /criteria\.0\.content: must be well-formed Unicode/);
  // And as it would arrive in a file.
  const arrived = JSON.parse(JSON.stringify(request({ criteria: [snapshot({ content: altered, sha256: sha256Hex(approved) })] })));
  assert.match(refusedBecause(arrived), /criteria\.0\.content: must be well-formed Unicode/);
});

test("RPAI-39: half a pair is found wherever it stands in approved text, and in the approver's name", () => {
  const texts = [`${HIGH}Rule one.`, `Rule one.${LOW}`, `Rule ${LOW}${HIGH} one.`, `Rule ${HIGH}\u{10000} one.`, `Rule \u{10000}${LOW} one.`, `Rule ${HIGH}${HIGH}${LOW} one.`];
  for (const content of texts) {
    assert.match(refusedBecause(request({ criteria: [snapshot({ content, sha256: sha256Hex(content) })] })), /criteria\.0\.content: must be well-formed Unicode/, JSON.stringify(content));
  }
  // One refused straight after another, the second with its half earlier in the text.
  const late = `A long enough rule${LOW}.`;
  const early = `${LOW}A long enough rule.`;
  assert.match(refusedBecause(request({ criteria: [snapshot({ content: late, sha256: sha256Hex(late) })] })), /content: must be well-formed Unicode/);
  assert.match(refusedBecause(request({ criteria: [snapshot({ content: early, sha256: sha256Hex(early) })] })), /content: must be well-formed Unicode/);
  for (const approvedBy of [`owner${HIGH}@releaseproof.test`, `${LOW}owner@releaseproof.test`, `owner@releaseproof.test${HIGH}`]) {
    assert.match(refusedBecause(request({ criteria: [snapshot({ approvedBy })] })), /criteria\.0\.approvedBy: must be well-formed Unicode/, JSON.stringify(approvedBy));
  }
  // In the second snapshot of two as well.
  const bad = `Rule two.${HIGH}`;
  assert.match(refusedBecause(request({ criteria: [snapshot(), snapshot({ id: "second", content: bad, sha256: sha256Hex(bad) })] })), /criteria\.1\.content: must be well-formed Unicode/);
});

test("RPAI-39: well-formed approved text is admitted as before, in any script, with whole pairs and with U+FFFD itself", () => {
  const texts = [
    CRITERIA,
    "1. Le solde affich\u00e9 est de 124 points.\n",
    "1. \u6b8b\u9ad8\u306f124\u30dd\u30a4\u30f3\u30c8\u3067\u3059\u3002\n",
    "1. \u05d4\u05d9\u05ea\u05e8\u05d4 \u05d4\u05d9\u05d0 124.\n",
    "1. A paid order shows \u{1f600} and 124 points.\n",
    `1. Text that went through a lossy decoder: ${REPLACEMENT}${REPLACEMENT}.\n`,
    "\u{10000}\u{10ffff}",
    `${String.fromCharCode(0xd7ff)}${String.fromCharCode(0xe000)} are not halves of anything.`,
  ];
  for (const content of texts) {
    const admitted = admitRemoteRun(request({ criteria: [snapshot({ content, sha256: sha256Hex(content) })] }), NOW);
    assert.equal(admitted.snapshots[0]!.content, content);
    assert.equal(admitted.snapshots[0]!.sha256, sha256Hex(content));
  }
  for (const approvedBy of ["Zo\u00eb Owner", "\u6240\u6709\u8005", "owner \u{1f600}", `owner${REPLACEMENT}`]) {
    assert.equal(admitRemoteRun(request({ criteria: [snapshot({ approvedBy })] }), NOW).snapshots[0]!.approvedBy, approvedBy);
  }
});
