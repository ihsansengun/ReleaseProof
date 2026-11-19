// What leaves the runner by default, and the no-model check that an
// application answers and its declared accounts can sign in.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { checkAvailability } from "../src/ci/availability.ts";
import { publicResult, render } from "../src/ci/report.ts";
import { logTail } from "../src/ci/run.ts";
import { Manifest } from "../src/schema.ts";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const result = (reason: string) => ({
  status: "completed",
  repo: "acme/tool",
  pr: 7,
  headSha: SHA,
  isolation: { environment: ["PATH"], outboundNetwork: "blocked", rootFilesystem: "read-only", user: "10001", ok: true },
  run: {
    ticketKey: "ABC-1",
    pullRequest: { repo: "acme/tool", number: 7, headSha: SHA, title: "t" },
    environment: { baseUrl: "http://10.0.0.2:8080" },
    driver: "test",
    executionMode: "autonomous",
    context: {
      docs: [], changedFiles: [], omitted: [],
      docChanges: [{ path: "README.md", kind: "modified", hash: HASH, removedLines: [], addedLines: ["x"] }],
      sources: [{ id: "T3.1", kind: "ticket-comment", trust: "authoritative", origin: "Jira issue ABC-1: comment 5 by a listed requirement owner", basis: "b", identity: "Jane Doe (712020:abc)" }],
    },
    analysis: { featureSummary: "", requirements: [{ id: "R1", text: "rule", kind: "documented", quote: "rule text here", sourceId: "T3.1", trust: "authoritative", origin: "o" }], ambiguities: [], risks: [] },
    analysisNotes: [],
    plan: { notes: [], clarifications: [], scenarios: [{ status: "runnable", blockedReason: "", scenario: { id: "S1", title: "Scenario", requirementIds: ["R1"], assertions: [{ id: "A1", description: "total", requirementId: "R1" }] } }] },
    results: [{
      scenarioId: "S1", title: "Scenario", verdict: "failed", reason,
      assertionResults: [{ assertionId: "A1", expected: 45, actual: 45.01, pass: false, target: { by: "role" }, screenshot: "/home/runner/out/check-A1.png" }],
      steps: [{ tool: "fill", input: { text: "typed by the executor" }, ok: true, summary: "page content seen by the executor" }],
      observations: { seen: 1 },
      evidence: { dir: "/home/runner/out", trace: "trace.zip" },
    }],
    confirmations: { S1: "reproduced" },
    timings: [],
    startedAt: "2026-01-01T00:00:00Z",
  },
});

test("the result handed on as an artifact holds only what the report renders, redacted, with commit and change ids exact", () => {
  const handed = publicResult(result("A1: expected 45, got 45.01; contact jane.doe@example.com, session=abc123xyz"));
  const text = JSON.stringify(handed);
  // Nothing the executor saw or typed, no screenshot, no path on the runner, no author identity.
  for (const absent of [/typed by the executor/, /page content seen/, /check-A1\.png/, /\/home\/runner/, /trace\.zip/, /observations/, /Jane Doe/, /712020:abc/, /jane\.doe/, /abc123xyz/]) {
    assert.doesNotMatch(text, absent);
  }
  assert.match(text, /\[redacted e-mail\]/);
  // Identifiers the report needs exact survive, although they are long and opaque.
  assert.equal(handed.headSha, SHA);
  assert.equal(handed.run!.pullRequest.headSha, SHA);
  assert.equal(handed.run!.context!.docChanges![0]!.hash, HASH);
  // The report made from it is the report made from the full result, when nothing needed redacting.
  const clean = result("A1: expected 45, got 45.01");
  assert.equal(render(publicResult(clean), "https://example.invalid/r").body, render(clean as Parameters<typeof render>[0], "https://example.invalid/r").body);
  // And the approval command it prints still carries the exact commit and change hash.
  assert.match(render(handed, "https://example.invalid/r").body, new RegExp(`approve-requirements ${SHA} ${HASH}`));
});

test("the application's log is redacted before it is printed", () => {
  const lines = logTail("user jane.doe@example.com signed in\nSet-Cookie: session=abc123xyz\n::error::Authorization: Bearer abcdef0123456789abcdef");
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^app\| /);
  assert.doesNotMatch(lines.join("\n"), /jane\.doe|abc123xyz|abcdef0123456789/);
});

test("by default only the sanitised files are uploaded; full evidence needs a repository variable", () => {
  const qa = parse(readFileSync(new URL("../../../.github/workflows/releaseproof-qa-reusable.yml", import.meta.url), "utf8"));
  type Step = { name?: string; if?: string; with?: { name?: string; path?: string } };
  const steps = qa.jobs.qa.steps as Step[];
  const uploads = steps.filter((s) => s.with?.name === "releaseproof-evidence");
  assert.equal(uploads.length, 2);
  const [sanitised, full] = uploads as [Step, Step];
  assert.equal(sanitised.if, "always() && vars.RELEASEPROOF_FULL_EVIDENCE != 'on'");
  assert.deepEqual(sanitised.with!.path!.trim().split(/\s+/), ["out/public/summary.json", "out/public/diagnostics.md", "out/public/diagnostics.json"]);
  assert.equal(full.if, "always() && vars.RELEASEPROOF_FULL_EVIDENCE == 'on'");
  assert.match(full.with!.path!, /!out\/\*\*\/trace\.zip/);
  // A variable, never an input: a request cannot ask for it.
  assert.doesNotMatch(JSON.stringify(qa.on), /FULL_EVIDENCE|full_evidence/i);
  // Between jobs travels the reduced result only, and nothing else names the full one.
  const handOff = steps.find((s) => s.with?.name === "releaseproof-result")!;
  assert.equal(handOff.with!.path, "out/public/report-input.json");
  assert.doesNotMatch(JSON.stringify(qa.jobs), /ci-result\.json/);
});

// ---- availability and sign-in, against a small server that knows one account

function server(page: "form" | "no form" | "error"): Promise<{ baseUrl: string; close: () => void; posts: string[] }> {
  const posts: string[] = [];
  const form = '<form method="post" action="/enter"><input type="hidden" name="t" value="1"><label>Name <input name="who"></label><label>Secret <input type="password" name="pass"></label><input type="checkbox" name="keep"><button>Go</button></form>';
  const s: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "text/html");
      if (page === "error") return void response.writeHead(500).end("broken");
      if (request.method === "POST") {
        posts.push(body);
        const ok = new URLSearchParams(body).get("who") === "admin" && new URLSearchParams(body).get("pass") === "admin";
        return void response.end(ok ? "<h1>Welcome back</h1>" : `<p>Wrong</p>${form}`);
      }
      response.end(page === "form" ? form : "<h1>Nothing to sign in to</h1>");
    });
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({ baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close(), posts })));
}
const manifest = (baseUrl: string, password: string | null) =>
  Manifest.parse({ baseUrl, accounts: password === null ? {} : { admin: { description: "d", username: "admin", password } } });
const out = () => mkdtempSync(path.join(tmpdir(), "rp-avail-"));

test("the availability check signs in with a declared account without a model, and fails verification when it cannot", async () => {
  const good = await server("form");
  try {
    assert.deepEqual(await checkAvailability(manifest(good.baseUrl, "admin"), out()), { status: 200, accounts: [{ alias: "admin", outcome: "signed in" }], ok: true });
    assert.equal(good.posts.length, 1, "one sign-in was sent, with the manifest's values");
    assert.deepEqual(await checkAvailability(manifest(good.baseUrl, "wrong"), out()), { status: 200, accounts: [{ alias: "admin", outcome: "not signed in" }], ok: false });
    // No account declared: answering is enough.
    assert.deepEqual(await checkAvailability(manifest(good.baseUrl, null), out()), { status: 200, accounts: [], ok: true });
  } finally {
    good.close();
  }
  const bare = await server("no form");
  try {
    assert.deepEqual(await checkAvailability(manifest(bare.baseUrl, "admin"), out()), { status: 200, accounts: [{ alias: "admin", outcome: "no sign-in form found" }], ok: false });
  } finally {
    bare.close();
  }
  const broken = await server("error");
  try {
    const a = await checkAvailability(manifest(broken.baseUrl, null), out());
    assert.deepEqual([a.status, a.ok], [500, false]);
  } finally {
    broken.close();
  }
  const nothing = await checkAvailability(manifest("http://127.0.0.1:9", null), out());
  assert.deepEqual([nothing.status, nothing.ok], [0, false]);
});
