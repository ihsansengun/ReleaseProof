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
  assert.deepEqual(Object.keys(admitted.request).sort(), ["criteria", "limits", "requestVersion", "runId", "target"]);
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

test("KAN-16 criterion 2: a snapshot whose text matches its hash and names an approver is marked verified", () => {
  const [verified] = admitRemoteRun(request(), NOW).snapshots;
  assert.equal(verified.verified, true);
  assert.equal(verified.sha256, sha256Hex(CRITERIA));
  assert.equal(verified.approvedBy, "owner-a@releaseproof.test");
  assert.equal(verified.content, CRITERIA);
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
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "check-remote-request", file], { env }).then(
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
