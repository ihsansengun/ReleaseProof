// The first run on an application built by others stalled on a form with no
// button to submit it: the executor had opened, by its address, a piece of
// HTML that the application loads into a dialog, and the button is drawn by
// the page's scripts. These tests rebuild that arrangement. No model is used.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeSession, openSession } from "../src/execute/run.ts";
import { PART_OF_A_PAGE, partOfAPage, runTool } from "../src/execute/tools.ts";
import { Manifest, type Scenario } from "../src/schema.ts";

const PIECE = `<h2>New member</h2><form method="post" action="/members"><label>Name <input name="name"></label><div class="js-buttons"></div></form>`;
const WHOLE = `<!doctype html><html><head><title>Members</title></head><body><h1>Members</h1>
<a href="/members/new" id="open">New member</a><div id="dialog"></div>
<script>
  document.getElementById("open").addEventListener("click", function (e) {
    e.preventDefault();
    fetch("/members/new").then(function (r) { return r.text(); }).then(function (html) {
      var dialog = document.getElementById("dialog");
      dialog.innerHTML = html;
      dialog.querySelector(".js-buttons").innerHTML = '<button type="submit">Save</button>';
    });
  });
</script></body></html>`;

test("an address that returns a part of a page is reported as that, and the dialog it belongs to works", async () => {
  const saved: string[] = [];
  const server: Server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      let body = "";
      request.on("data", (c) => (body += c));
      request.on("end", () => {
        saved.push(body);
        response.end(WHOLE.replace("<h1>Members</h1>", "<h1>Members</h1><p>Saved.</p>"));
      });
      return;
    }
    response.end(request.url === "/members/new" ? PIECE : WHOLE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scenario: Scenario = { id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions: [] };
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-fr-")) });
  const run = (tool: string, input: Record<string, unknown>) => runTool(open.session, tool, { ...input, rationale: "r" });
  try {
    // As in the run: the address copied from the link. The form is there and its button is not.
    const direct = await run("navigate", { path: "/members/new" });
    assert.equal(direct.ok, true);
    assert.ok(direct.output.startsWith(PART_OF_A_PAGE));
    assert.match(direct.output, /textbox "Name"/);
    assert.equal((await run("click", { element: { by: "role", role: "button", value: "Save" } })).ok, false);

    // A whole page carries no such note.
    const whole = await run("navigate", { path: "/" });
    assert.doesNotMatch(whole.output, /part of a page/);
    // Opened as a user opens it, the form has its button and can be saved.
    const dialog = await run("click", { element: { by: "role", role: "link", value: "New member" } });
    assert.match(dialog.output, /button "Save"/);
    await run("fill", { element: { by: "label", value: "Name" }, text: "Ada" });
    const done = await run("click", { element: { by: "role", role: "button", value: "Save" } });
    assert.match(done.output, /Saved\./);
    assert.deepEqual(saved, ["name=Ada"]);
  } finally {
    open.session.outcome ??= { kind: "completed", reason: "done" };
    await closeSession(open, { mode: "agent" });
    server.close();
  }
});

test("only an HTML answer without html, head or body counts as a part of a page", async () => {
  const answer = (type: string, body: string) => ({ headers: () => ({ "content-type": type }), text: async () => body });
  assert.equal(await partOfAPage(answer("text/html", PIECE)), PART_OF_A_PAGE);
  assert.equal(await partOfAPage(answer("text/html; charset=utf-8", WHOLE)), undefined);
  assert.equal(await partOfAPage(answer("text/html", "<BODY class='x'><p>old page</p></BODY>")), undefined);
  // Not HTML, empty, or no answer at all: nothing is claimed.
  assert.equal(await partOfAPage(answer("application/json", '{"a":1}')), undefined);
  assert.equal(await partOfAPage(answer("text/html", "  ")), undefined);
  assert.equal(await partOfAPage(null), undefined);
});
