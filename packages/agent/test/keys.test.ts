// A walkthrough of an application built by others, with the executor's own
// tools and no model, showed three things a user does that the tools could
// not: submit a field that has no button, replace what a field holds when the
// page moves the caret on focus, and name a control whose label ends in an
// icon. Each test rebuilds one of them on a small page.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeSession, openSession } from "../src/execute/run.ts";
import { exactName, runTool } from "../src/execute/tools.ts";
import { Manifest, type Scenario } from "../src/schema.ts";

const PEOPLE = ["Ada Lovelace", "Alan Turing", "Mary Smith"];
const page = (term: string) => {
  const found = PEOPLE.filter((p) => p.toLowerCase().includes(term.toLowerCase()));
  return `<!doctype html><html><head><title>People</title></head><body>
<header><a href="#" id="menu">admin </a><ul id="items" hidden><li><a href="/?out=1">Sign out</a></li></ul></header>
<h1>People (${found.length})</h1>
<form method="get" action="/"><input type="text" name="q" value="${term}" aria-label="Search"></form>
<label>Member <input id="member" autocomplete="off"></label><ul id="suggestions"></ul>
${found.length ? `<ul aria-label="Results">${found.map((p) => `<li>${p}</li>`).join("")}</ul>` : "<p>Nobody found.</p>"}
<script>
  // As some applications do: on focus, put the caret at the end of what is there.
  var q = document.querySelector("[name=q]");
  q.addEventListener("focus", function () { setTimeout(function () { q.setSelectionRange(q.value.length, q.value.length); }, 0); });
  q.addEventListener("select", function () { q.setSelectionRange(q.value.length, q.value.length); });
  document.getElementById("menu").addEventListener("click", function (e) { e.preventDefault(); document.getElementById("items").hidden = false; });
  // Suggestions arrive a moment after typing.
  var timer;
  document.getElementById("member").addEventListener("input", function (e) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var term = e.target.value.toLowerCase();
      document.getElementById("suggestions").innerHTML = ${JSON.stringify(PEOPLE)}.filter(function (p) { return term && p.toLowerCase().indexOf(term) !== -1; }).map(function (p) { return "<li>" + p + "</li>"; }).join("");
    }, 300);
  });
</script></body></html>`;
};

async function withPeople<T>(work: (run: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>) => Promise<T>): Promise<T> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(url.searchParams.has("out") ? "<!doctype html><html><body><h1>Signed out</h1></body></html>" : page(url.searchParams.get("q") ?? ""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scenario: Scenario = { id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions: [] };
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-key-")) });
  try {
    await open.session.page.goto(baseUrl);
    return await work((tool, input) => runTool(open.session, tool, { ...input, rationale: "r" }));
  } finally {
    open.session.outcome ??= { kind: "completed", reason: "done" };
    await closeSession(open, { mode: "agent" });
    server.close();
  }
}

const search = { by: "role", role: "textbox", value: "Search" };

test("a search box with no button is submitted with Enter, and a second term replaces the first", async () => {
  await withPeople(async (run) => {
    await run("fill", { element: search, text: "smith" });
    // Typing alone changes nothing: this is where the paid run stood still.
    const typed = await run("fill", { element: search, text: "smith" });
    assert.match(typed.output, /heading "People \(3\)"/);
    const first = await run("press", { element: search, key: "Enter" });
    assert.match(first.output, /URL: \/\?q=smith\n/);
    assert.match(first.output, /heading "People \(1\)"/);

    // The box now holds "smith", and this page moves the caret to its end on focus.
    const second = await run("fill", { element: search, text: "nobody" });
    assert.doesNotMatch(second.output, /NOTE: the field now holds/);
    const none = await run("press", { element: search, key: "Enter" });
    assert.match(none.output, /URL: \/\?q=nobody\n/);
    assert.match(none.output, /Nobody found\./);

    // Emptied, it lists everyone again.
    await run("fill", { element: search, text: "" });
    assert.match((await run("press", { element: search, key: "Enter" })).output, /heading "People \(3\)"/);

    // Only the listed keys, and only on one element.
    const other = await run("press", { element: search, key: "F5" });
    assert.equal(other.ok, false);
    assert.match(other.output, /Invalid input/);
    assert.equal((await run("press", { element: { by: "role", role: "textbox", value: "No such box" }, key: "Enter" })).ok, false);
  });
});

test("what appears a moment after typing is in the page that fill returns", async () => {
  await withPeople(async (run) => {
    const typed = await run("fill", { element: { by: "label", value: "Member" }, text: "al" });
    // The suggestion list sits right under the field; the results list further down is another list.
    assert.match(typed.output, /textbox "Member": al\n- list:\n  - listitem: Alan Turing\n/);
    const none = await run("fill", { element: { by: "label", value: "Member" }, text: "zzz" });
    assert.match(none.output, /textbox "Member": zzz\n- list\n/);
  });
});

test("an icon after a name is not part of the name", async () => {
  await withPeople(async (run) => {
    // The page description leaves the glyph out, so there is nothing to copy wrongly.
    const shown = await run("press", { element: search, key: "Tab" });
    assert.match(shown.output, /link "admin "?:/);
    assert.doesNotMatch(shown.output, /[-]/);
    // And the name without it finds the link.
    const menu = await run("click", { element: { by: "role", role: "link", value: "admin" } });
    assert.equal(menu.ok, true);
    assert.match(menu.output, /link "Sign out"/);
    // Within a landmark, by a role the tools now know.
    const out = await run("click", { element: { by: "role", role: "link", value: "Sign out", within: { by: "role", role: "banner", value: "" } } });
    assert.match(out.output, /Signed out/);
  });

  // A name is still matched in full: a part of it is not it.
  assert.equal(exactName("admin").test("admin "), true);
  assert.equal(exactName("admin").test(" admin"), true);
  assert.equal(exactName("admin").test("administrator"), false);
  assert.equal(exactName("admin").test("admin settings"), false);
  assert.equal(exactName("Total").test("Subtotal"), false);
  assert.equal(exactName("Save (draft)").test("Save (draft)"), true);
  assert.equal(exactName("a.b").test("axb"), false);
});
