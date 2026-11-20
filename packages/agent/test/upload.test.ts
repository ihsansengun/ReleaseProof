// Attaching a file is something a user does through the browser's file
// dialog, and the executor had no way to do it. These tests drive the upload
// tool against a real page and a server that keeps what it receives. No model
// is used, and no file is read from the machine the tests run on.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeSession, openSession } from "../src/execute/run.ts";
import { runTool, syntheticFile, toolDefinitions } from "../src/execute/tools.ts";
import { Manifest, type Assertion, type Scenario, type ScenarioResult } from "../src/schema.ts";

type Run = (tool: string, input: unknown) => Promise<{ ok: boolean; output: string }>;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withApp<T>(handler: Handler, scenario: Scenario, work: (run: Run) => Promise<T>): Promise<{ value: T; result: ScenarioResult }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = await openSession({ scenario, manifest: Manifest.parse({ baseUrl }), outDir: mkdtempSync(path.join(tmpdir(), "rp-up-")) });
  try {
    await open.session.page.goto(baseUrl);
    const value = await work((tool, input) => runTool(open.session, tool, input));
    open.session.outcome ??= { kind: "completed", reason: "done" };
    return { value, result: await closeSession(open, { mode: "agent" }) };
  } finally {
    server.close();
  }
}

const FORM = `<h1>New note</h1>
<form method="post" action="/save" enctype="multipart/form-data">
  <label>Title <input name="title"></label>
  <label>Attachment <input type="file" name="one"></label>
  <label>More files <input type="file" name="many" multiple></label>
  <input type="file" id="hidden" name="behind" multiple style="display:none">
  <a href="#" onclick="document.getElementById('hidden').click(); return false">choose files</a>
  <ul id="chosen"></ul>
  <button type="button">Help</button>
  <button>Save</button>
</form>
<script>
  document.getElementById("hidden").addEventListener("change", function (e) {
    document.getElementById("chosen").innerHTML = Array.from(e.target.files).map(function (f) { return "<li>" + f.name + "</li>"; }).join("");
  });
</script>`;

/** Splits a multipart body into its file parts, keeping the bytes. */
function fileParts(body: Buffer, contentType: string): Array<{ field: string; name: string; type: string; bytes: Buffer }> {
  const boundary = Buffer.from(`--${/boundary=(.+)$/.exec(contentType)![1]}`);
  const parts: Array<{ field: string; name: string; type: string; bytes: Buffer }> = [];
  let at = body.indexOf(boundary);
  while (at !== -1) {
    const next = body.indexOf(boundary, at + boundary.length);
    if (next === -1) break;
    const part = body.subarray(at + boundary.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const file = /name="([^"]*)"; filename="([^"]*)"/.exec(head);
    if (file && file[2] !== "") parts.push({ field: file[1]!, name: file[2]!, type: /Content-Type: (.+)/i.exec(head)?.[1]?.trim() ?? "", bytes: part.subarray(split + 4) });
    at = next;
  }
  return parts;
}

/** A small application that stores what is posted and serves it back. */
function app(): { handler: Handler; stored: Map<string, { type: string; bytes: Buffer }> } {
  const stored = new Map<string, { type: string; bytes: Buffer }>();
  const handler: Handler = (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (request.method === "POST" && url.pathname === "/save") {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        for (const f of fileParts(Buffer.concat(chunks), request.headers["content-type"] ?? "")) stored.set(f.name, { type: f.type, bytes: f.bytes });
        response.setHeader("content-type", "text/html");
        response.end(`<h1>Saved</h1><table aria-label="Attachments"><tr><th>Name</th><th>Size</th></tr>${[...stored].map(([name, f]) => `<tr><td>${name}</td><td>${f.bytes.length}</td></tr>`).join("")}</table>`);
      });
      return;
    }
    if (url.pathname.startsWith("/file/")) {
      const f = stored.get(decodeURIComponent(url.pathname.slice(6)));
      response.statusCode = f ? 200 : 404;
      response.end(f ? f.bytes : "");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(FORM);
  };
  return { handler, stored };
}

const scenario = (assertions: Assertion[] = []): Scenario => ({ id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "i", fixtures: {}, assertions });
const upload = (run: Run, element: unknown, files: Array<{ name: string; kind: string }>) => run("upload", { element, files, rationale: "r" });
const label = (value: string) => ({ by: "label", value });

test("a file chosen in a file field reaches the application unchanged, and can be checked there", async () => {
  const { handler, stored } = app();
  const size: Assertion = { id: "A1", description: "the stored size of notes.txt", kind: "number_equals", expected: { literal: 29 }, requirementId: "R1", unit: "plain" };
  const content: Assertion = { id: "A2", description: "the downloaded content of notes.txt", kind: "text_equals", expected: { literal: "Synthetic test file notes.txt" }, requirementId: "R1" };
  const { value, result } = await withApp(handler, scenario([size, content]), async (run) => {
    const chosen = await upload(run, label("Attachment"), [{ name: "notes.txt", kind: "text" }]);
    await run("click", { element: { by: "role", role: "button", value: "Save" }, rationale: "r" });
    const listed = await run("check", { assertionId: "A1", target: { source: "page", by: "cell", value: "Size", row: { by: "text", value: "notes.txt" }, count: false, read: "text" }, rationale: "r" });
    const fetched = await run("api_request", { method: "GET", path: "/file/notes.txt", rationale: "r" });
    const same = await run("check", { assertionId: "A2", target: { source: "api", responseId: "R1", field: "body", jsonPath: "" }, rationale: "r" });
    return { chosen, listed, fetched, same };
  });
  // The tool says what it sent, so the executor does not have to guess.
  assert.match(value.chosen.output, /^Chose 1 file: notes\.txt \(29 bytes, text\/plain, content "Synthetic test file notes\.txt"\)/);
  assert.deepEqual(stored.get("notes.txt"), { type: "text/plain", bytes: Buffer.from("Synthetic test file notes.txt") });
  assert.match(value.listed.output, /expected 29, actual 29 -> match/);
  assert.match(value.same.output, /-> match/);
  assert.equal(result.verdict, "passed");
  // The step is on record as an action, with the names as the executor gave them.
  assert.equal(result.steps.find((s) => s.tool === "upload")!.ok, true);
  assert.equal(result.assertionResults[0]!.evidence!.action?.tool, "click");
});

test("files are chosen through the dialog a button opens, several at once, and a picture arrives as a picture", async () => {
  const { handler, stored } = app();
  const { value } = await withApp(handler, scenario(), async (run) => {
    const chosen = await upload(run, { by: "role", role: "link", value: "choose files" }, [{ name: "plan.txt", kind: "text" }, { name: "shot.png", kind: "image" }]);
    await run("click", { element: { by: "role", role: "button", value: "Save" }, rationale: "r" });
    return { chosen };
  });
  assert.match(value.chosen.output, /^Chose 2 files: plan\.txt \(28 bytes, text\/plain, content "[^"]*"\); shot\.png \(70 bytes, image\/png\)/);
  // The page's own script saw the files, as it would for a user.
  assert.match(value.chosen.output, /plan\.txt[\s\S]*shot\.png/);
  assert.deepEqual([...stored.keys()], ["plan.txt", "shot.png"]);
  assert.equal(stored.get("shot.png")!.type, "image/png");
  assert.deepEqual(stored.get("shot.png")!.bytes, syntheticFile("shot.png", "image").buffer);
  // A PNG by its signature.
  assert.equal(stored.get("shot.png")!.bytes.subarray(1, 4).toString("latin1"), "PNG");

  const many = app();
  await withApp(many.handler, scenario(), async (run) => {
    await upload(run, label("More files"), [{ name: "a.txt", kind: "text" }, { name: "b.txt", kind: "text" }, { name: "c.txt", kind: "text" }]);
    await run("click", { element: { by: "role", role: "button", value: "Save" }, rationale: "r" });
  });
  assert.deepEqual([...many.stored.keys()], ["a.txt", "b.txt", "c.txt"]);
});

test("what is not a file control is refused, and nothing is uploaded", async () => {
  const { handler, stored } = app();
  const { value } = await withApp(handler, scenario(), async (run) => {
    const notAFileControl = await upload(run, { by: "role", role: "button", value: "Help" }, [{ name: "a.txt", kind: "text" }]);
    const textField = await upload(run, label("Title"), [{ name: "a.txt", kind: "text" }]);
    const tooMany = await upload(run, label("Attachment"), [{ name: "a.txt", kind: "text" }, { name: "b.txt", kind: "text" }]);
    const sameName = await upload(run, label("More files"), [{ name: "a.txt", kind: "text" }, { name: "A.txt", kind: "image" }]);
    const missing = await upload(run, label("No such field"), [{ name: "a.txt", kind: "text" }]);
    // A name is a name: no folder on the runner, or anywhere, can be named.
    const path1 = await upload(run, label("Attachment"), [{ name: "../../etc/passwd", kind: "text" }]);
    const path2 = await upload(run, label("Attachment"), [{ name: "/etc/hostname", kind: "text" }]);
    const kind = await upload(run, label("Attachment"), [{ name: "a.bin", kind: "binary" }]);
    const none = await upload(run, label("Attachment"), []);
    await run("click", { element: { by: "role", role: "button", value: "Save" }, rationale: "r" });
    return { notAFileControl, textField, tooMany, sameName, missing, path1, path2, kind, none };
  });
  assert.match(value.notAFileControl.output, /role button "Help" was clicked and opened no file dialog, so it is not a control for choosing files\. Nothing was chosen\./);
  assert.match(value.textField.output, /opened no file dialog/);
  assert.match(value.tooMany.output, /This file field takes one file\. Nothing was chosen\./);
  assert.match(value.sameName.output, /Each file needs its own name/);
  assert.match(value.missing.output, /found 0/);
  for (const refused of [value.path1, value.path2, value.kind, value.none]) {
    assert.equal(refused.ok, false);
    assert.match(refused.output, /Invalid input/);
  }
  assert.equal(stored.size, 0);
});

test("the tool takes names and kinds, never a path or content of the caller's choosing", () => {
  const definition = toolDefinitions.find((t) => t.name === "upload")!;
  const file = (definition.input_schema as unknown as { properties: { files: { items: { properties: Record<string, unknown>; additionalProperties?: boolean } } } }).properties.files.items;
  assert.deepEqual(Object.keys(file.properties).sort(), ["kind", "name"]);
  // The same name and kind always give the same bytes, so a repeat without a model sends what the first run sent.
  assert.deepEqual(syntheticFile("notes.txt", "text"), syntheticFile("notes.txt", "text"));
  assert.equal(syntheticFile("notes.txt", "text").buffer.toString("utf8"), "Synthetic test file notes.txt");
  assert.equal(syntheticFile("x.png", "image").buffer.length, 70);
});
