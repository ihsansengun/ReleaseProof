// The independent evaluation of 20 November reported five failures that were
// not failures: a count taken where nothing could be counted came back as 0
// and was compared. The same fault passed three comparisons that tested
// nothing: rows with an empty name are counted as 0 whatever the page shows.
// Each test rebuilds one of those readings on a small page. No model is used.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeSession, openSession } from "../src/execute/run.ts";
import { runTool } from "../src/execute/tools.ts";
import { Manifest, type Assertion, type Scenario, type ScenarioResult } from "../src/schema.ts";

type Run = (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;

async function withPage<T>(body: string, assertions: Assertion[], work: (run: Run) => Promise<T>, observations?: Scenario["observations"]): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scenario: Scenario = { id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions, ...(observations ? { observations } : {}) };
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-cnt-")) });
  try {
    await open.session.page.goto(baseUrl);
    const value = await work((tool, input) => runTool(open.session, tool, { ...input, rationale: "r" }));
    open.session.outcome ??= { kind: "completed", reason: "done" };
    return { value, result: await closeSession(open, { mode: "agent" }) };
  } finally {
    server.close();
  }
}

const n = (id: string, literal: number): Assertion => ({ id, description: id, kind: "number_equals", expected: { literal }, requirementId: "R9", unit: "plain" });
const count = (target: Record<string, unknown>) => ({ source: "page", count: true, read: "text", ...target });
const check = (run: Run, assertionId: string, target: Record<string, unknown>) => run("check", { assertionId, target });

// A task's page as the evaluated application draws it: a section named by a
// summary, a table of two attached files whose links end in an icon.
const TASK = `<h2>First task</h2>
<details open><summary>Attachments</summary>
  <table aria-label="Files"><tr><th>Filename</th><th>Size</th></tr>
    <tr><td><a href="/f/1">alpha.txt </a></td><td>29</td></tr>
    <tr><td><a href="/f/2">beta.txt </a></td><td>28</td></tr>
  </table>
</details>
<details open><summary>Sub-tasks</summary><ul aria-label="Sub-tasks"></ul><p>There is nothing to show.</p></details>
<section aria-label="Comments"><h3>Comments</h3></section>`;

test("a count where nothing could be counted is refused, and is not a failure (the three false failures of the attachments run)", async () => {
  const { value, result } = await withPage(TASK, [n("A4", 2), n("A3", 1), n("A1", 1)], async (run) => ({
    // "expected 2, got 0": links counted within the text that names the section.
    withinTheName: await check(run, "A4", count({ by: "role", role: "link", value: "", within: { by: "text", value: "Attachments" } })),
    // "expected 1, got 0": a link counted within a group that is not on the page.
    noSuchContainer: await check(run, "A3", count({ by: "role", role: "link", value: "alpha.txt", within: { by: "role", role: "group", value: "Attachments" } })),
    // The same without any container: nothing matches anywhere.
    nowhere: await check(run, "A1", count({ by: "role", role: "link", value: "gamma.txt" })),
    // A container that is there and holds nothing at all cannot be the list.
    hollow: await check(run, "A1", count({ by: "role", role: "link", value: "", within: { by: "role", role: "heading", value: "Comments" } })),
  }));
  assert.match(value.withinTheName.output, /Not counted: the container text "Attachments" is a label\. It names a section and does not hold its items\./);
  assert.match(value.noSuchContainer.output, /Not counted: expected exactly one container for \{"by":"role","role":"group","value":"Attachments"\}, found 0\./);
  assert.match(value.nowhere.output, /Not counted: nothing on the page matches .*"gamma\.txt".* an empty collection or a wrong target/);
  assert.match(value.hollow.output, /Not counted: the container role heading "Comments" is a heading/);
  for (const refused of Object.values(value)) assert.equal(refused.ok, false);
  // Nothing was recorded, so nothing failed: the scenario is without a verdict, as it should be.
  assert.deepEqual(result.assertionResults, []);
  assert.equal(result.verdict, "unverified");
});

test("the same counts, scoped to the element that holds the items, are read and compared", async () => {
  const table = { by: "role", role: "table", value: "Files" };
  const { value, result } = await withPage(TASK, [n("A4", 2), n("A3", 1), n("A1", 3), n("A2", 1)], async (run) => ({
    // No name given: every link in the table, icons or not.
    all: await check(run, "A4", count({ by: "role", role: "link", value: "", within: table })),
    one: await check(run, "A3", count({ by: "role", role: "link", value: "alpha.txt", within: table })),
    // An empty name used to match only nameless rows and read 0 on any table. Three rows: the header and two files.
    rows: await check(run, "A1", count({ by: "role", role: "row", value: "", within: table })),
    // A count that is really wrong still fails.
    wrong: await check(run, "A2", count({ by: "role", role: "link", value: "", within: table })),
  }));
  assert.match(value.all.output, /expected 2, actual 2 -> match/);
  assert.match(value.one.output, /expected 1, actual 1 -> match/);
  assert.match(value.rows.output, /expected 3, actual 3 -> match/);
  assert.match(value.wrong.output, /expected 1, actual 2 -> MISMATCH/);
  assert.equal(result.verdict, "failed");
  // The record says where it counted and what the place holds.
  const one = result.assertionResults.find((r) => r.assertionId === "A3")!.evidence!;
  assert.equal(one.target.scope, 'within role table "Files", which holds 2 elements of role link in all');
  assert.equal(result.assertionResults.find((r) => r.assertionId === "A4")!.evidence!.target.scope, 'within role table "Files"');
});

test("a collection that is really empty reads 0 inside its container, and that 0 is compared", async () => {
  const { value, result } = await withPage(
    `${TASK}<p>Labels</p>`,
    [n("A1", 0), n("A2", 0), n("A3", 0)],
    async (run) => ({
      // An empty list that is on the page: found by its role, it is the place, and it holds nothing.
      emptyList: await check(run, "A1", count({ by: "role", role: "listitem", value: "", within: { by: "role", role: "list", value: "Sub-tasks" } })),
      // No file of that name among the two that are there: a true zero, with the place it was looked for on record.
      noSuchFile: await check(run, "A2", count({ by: "role", role: "link", value: "gamma.txt", within: { by: "role", role: "table", value: "Files" } })),
      // The same holds for a count that is recorded as an observation.
      recorded: await run("observe", { name: "comments", target: count({ by: "role", role: "listitem", value: "", within: { by: "role", role: "region", value: "Comments" } }) }),
      // Words that only name something are not a place, whatever their tag.
      words: await check(run, "A3", count({ by: "role", role: "link", value: "", within: { by: "text", value: "Labels" } })),
    }),
    [{ name: "comments", what: "comments shown", when: "at the end", unit: "plain" }] as Scenario["observations"],
  );
  assert.match(value.emptyList.output, /expected 0, actual 0 -> match/);
  assert.match(value.noSuchFile.output, /expected 0, actual 0 -> match/);
  assert.match(value.recorded.output, /Recorded comments = 0/);
  assert.match(value.words.output, /Not counted: the container text "Labels" is text with nothing inside it/);
  assert.equal(result.assertionResults.find((r) => r.assertionId === "A2")!.evidence!.target.scope, 'within role table "Files", which holds 2 elements of role link in all');
  assert.deepEqual(result.assertionResults.map((r) => [r.assertionId, r.pass]), [["A1", true], ["A2", true]]);
});

test("a count of 0 that is true still compares when the section is named", async () => {
  const page = `<section aria-label="Results"><h2>Users (0)</h2><p>No users found.</p></section>
    <section aria-label="Members"><table><tr><th>Name</th></tr><tr><td>Ada</td></tr></table></section>`;
  const { value, result } = await withPage(page, [n("A1", 0), n("A2", 2)], async (run) => ({
    none: await check(run, "A1", count({ by: "role", role: "row", value: "", within: { by: "role", role: "region", value: "Results" } })),
    some: await check(run, "A2", count({ by: "role", role: "row", value: "" })),
  }));
  assert.match(value.none.output, /expected 0, actual 0 -> match/);
  // More than zero needs no container: the items themselves show the target is real.
  assert.match(value.some.output, /expected 2, actual 2 -> match/);
  assert.equal(result.verdict, "passed");
});
