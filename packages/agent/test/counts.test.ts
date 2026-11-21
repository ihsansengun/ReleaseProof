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

// The two gaps left after the evaluation. A count took in what the page holds
// but does not show; and inside a real container, a count of a kind of element
// the page never uses for its items read 0 and could pass a "none shown" check.

test("only items that are shown are counted, and how many are present goes on record", async () => {
  const page = `<table aria-label="Orders"><tr><th>Ref</th></tr>
    <tr><td>A-1</td></tr><tr><td>A-2</td></tr>
    <tr hidden><td>A-3</td></tr><tr style="display:none"><td>A-4</td></tr></table>
    <ul aria-label="Tags"><li>red</li><li>green</li><li>blue</li><li hidden>grey</li><li style="visibility:hidden">black</li></ul>`;
  const hiddenWords = `<div aria-label="Alerts" role="group"><p data-testid="alert">Low stock</p><p data-testid="alert">Low stock</p><p data-testid="alert" hidden>Low stock</p></div>`;
  const words = await withPage(hiddenWords, [n("A1", 2), n("A2", 2)], async (run) => ({
    // Found by text or by test id, a hidden element used to be counted with the rest.
    text: await check(run, "A1", count({ by: "text", value: "Low stock", within: { by: "role", role: "group", value: "Alerts" } })),
    testid: await check(run, "A2", count({ by: "testid", value: "alert", within: { by: "role", role: "group", value: "Alerts" } })),
  }));
  assert.match(words.value.text.output, /expected 2, actual 2 -> match/);
  assert.match(words.value.testid.output, /expected 2, actual 2 -> match/);
  assert.deepEqual(words.result.assertionResults.map((r) => [r.evidence!.target.shown, r.evidence!.target.present]), [[2, 3], [2, 3]]);
  const { value, result } = await withPage(page, [n("A1", 3), n("A2", 3)], async (run) => ({
    // Header row and two shown rows; two more rows are in the page and hidden.
    rows: await check(run, "A1", count({ by: "role", role: "row", value: "", within: { by: "role", role: "table", value: "Orders" } })),
    items: await check(run, "A2", count({ by: "role", role: "listitem", value: "", within: { by: "role", role: "list", value: "Tags" } })),
  }));
  assert.match(value.rows.output, /expected 3, actual 3 -> match/);
  assert.match(value.items.output, /expected 3, actual 3 -> match/);
  const items = result.assertionResults.find((r) => r.assertionId === "A2")!.evidence!.target;
  assert.equal(items.shown, 3);
  assert.equal(items.present, 5);
  assert.match(items.scope!, /2 more present in the page but not shown, and not counted/);
  assert.equal(result.verdict, "passed");
});

test("where nothing is hidden, shown and present agree and the scope says nothing more", async () => {
  const { result } = await withPage(TASK, [n("A1", 2)], async (run) => check(run, "A1", count({ by: "role", role: "link", value: "", within: { by: "role", role: "table", value: "Files" } })));
  const target = result.assertionResults[0]!.evidence!.target;
  assert.deepEqual([target.shown, target.present], [2, 2]);
  assert.doesNotMatch(target.scope!, /not shown/);
});

// A results panel that draws its entries as cards, not as rows or list items.
const CARDS = `<section aria-label="Results"><h2>Results</h2>
  <div class="card"><b>Ada</b> <span>admin</span></div>
  <div class="card"><b>Grace</b> <span>member</span></div></section>`;

test("a zero for a kind of element never seen in the place is not a reading, and is not compared", async () => {
  const { value, result } = await withPage(CARDS, [n("A1", 0), n("A2", 0)], async (run) => ({
    rows: await check(run, "A1", count({ by: "role", role: "row", value: "", within: { by: "role", role: "region", value: "Results" } })),
    named: await check(run, "A2", count({ by: "role", role: "listitem", value: "Ada", within: { by: "role", role: "region", value: "Results" } })),
  }));
  assert.match(value.rows.output, /Not counted: role region "Results" shows content, but no element of role row was seen in it/);
  assert.match(value.named.output, /Not counted: .* no element of role listitem was seen in it/);
  assert.equal(value.rows.ok, false);
  // Nothing was compared, so nothing passed: the "none shown" check did not go through.
  assert.deepEqual(result.assertionResults, []);
  assert.notEqual(result.verdict, "passed");
});

test("a zero stands where the place says it is empty, holds only its headings, or held such items earlier", async () => {
  const page = `<section aria-label="Results"><h2>Results</h2><p>No users found.</p></section>
    <section aria-label="Queue"><h2>Queue</h2></section>
    <section aria-label="Inbox"><h2>Inbox</h2><ul id="inbox"><li>One</li><li>Two</li></ul><p id="note">Up to date</p>
      <button onclick="document.getElementById('inbox').remove();document.getElementById('note').textContent='All caught up'">Clear</button></section>`;
  const { value, result } = await withPage(page, [n("A1", 0), n("A2", 0), n("A3", 2), n("A4", 0)], async (run) => {
    const inbox = count({ by: "role", role: "listitem", value: "", within: { by: "role", role: "region", value: "Inbox" } });
    const saysEmpty = await check(run, "A1", count({ by: "role", role: "row", value: "", within: { by: "role", role: "region", value: "Results" } }));
    const onlyHeading = await check(run, "A2", count({ by: "role", role: "listitem", value: "", within: { by: "role", role: "region", value: "Queue" } }));
    const before = await check(run, "A3", inbox);
    await run("click", { element: { by: "role", role: "button", value: "Clear" } });
    // The panel now shows other words and no list, and does not say it is empty: the earlier count is what makes 0 a reading.
    const after = await check(run, "A4", inbox);
    return { saysEmpty, onlyHeading, before, after };
  });
  assert.match(value.saysEmpty.output, /expected 0, actual 0 -> match/);
  assert.match(value.onlyHeading.output, /expected 0, actual 0 -> match/);
  assert.match(value.before.output, /expected 2, actual 2 -> match/);
  assert.match(value.after.output, /expected 0, actual 0 -> match/);
  assert.equal(result.verdict, "passed");
});
