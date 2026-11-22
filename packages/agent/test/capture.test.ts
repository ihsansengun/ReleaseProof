// KAN-16: what the browser showed and said. A picture after each step, console
// errors and failed requests, collected only when a run asks, kept small and
// kept clean. A real browser, a stand-in application on this machine, no model.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { CAPTURE_LIMITS, cleanPath } from "../src/execute/capture.ts";
import { plainAmount } from "../src/execute/clean.ts";
import { LEAKED_BEFORE, LEAKED_PATHS, SECRETS_BEFORE } from "./leaked-before.ts";
import { runScenario } from "../src/execute/run.ts";
import { Manifest, type Scenario, type ScenarioResult, type Step } from "../src/schema.ts";

async function app(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://app");
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body style="margin:0">${body}</body></html>`);
    };
    if (url.pathname === "/quiet") return html(`<h1>Quiet page</h1><p data-testid="value">60</p><a href="/noisy">Next</a>`);
    if (url.pathname === "/noisy") {
      return html(`<h1>Noisy page</h1><img src="/missing.png?session=abcdef123456"><script>
        console.log("an ordinary line");
        console.warn("a warning");
        console.error("Could not load points for ada@example.test, token=tok_live_4f9a8b7c6d5e and Authorization: Bearer abcdefghijklmnop");
        fetch("/api/points?account=42&key=supersecretvalue").catch(() => {});
        fetch("/api/cut").catch(() => {});
        fetch("http://127.0.0.1:9/elsewhere").catch(() => {});
        setTimeout(() => { throw new Error("points is not defined"); }, 50);
      </script>`);
    }
    if (url.pathname === "/moving") {
      return html(`<style>@keyframes slide { from { margin-left: 0 } to { margin-left: 40px } } #a { animation: slide 4s linear } #t { transition: opacity 4s linear; opacity: 1 }</style>
        <p id="a">Animated</p><p id="t">Fading</p><p data-testid="ended">1</p>
        <script>const done = () => (document.querySelector('[data-testid=ended]').textContent = '2');
          document.getElementById('a').addEventListener('animationend', done);
          document.getElementById('t').addEventListener('transitionend', done);
          requestAnimationFrame(() => (document.getElementById('t').style.opacity = '0.5'));</script>`);
    }
    if (url.pathname === "/many") {
      // More password fields than fit in the window, so that the first of them are above it once scrolled.
      const n = Number(url.searchParams.get("n") ?? "250");
      return html(`<div>${Array.from({ length: n }, () => '<input type="password" value="hunter2" style="display:block;width:1280px;height:60px;font-size:40px;box-sizing:border-box">').join("")}</div><script>scrollTo(0, 1e9)</script>`);
    }
    if (url.pathname === "/watched") {
      // A page that counts every change made to its own document, and holds a field to cover.
      return html(`<h1>Watched</h1><label>Password <input type="password" value="hunter2"></label><p data-testid="changes"></p>
        <button onclick="observer.disconnect(); document.querySelector('[data-testid=changes]').textContent = String(changes)">Show</button>
        <script>var changes = 0; var observer = new MutationObserver((list) => { changes += list.length; });
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });</script>`);
    }
    if (url.pathname === "/framed") return html(`<h1 style="margin:0;height:100px">Framed</h1><iframe src="/sign-in" style="display:block;border:0;width:1280px;height:600px"></iframe>`);
    if (url.pathname === "/words") {
      return html(`<h1>Words</h1><script>
        for (let i = 0; i < 5; i++) console.error("token".repeat(800));
        console.error("apikey-_".repeat(500));
        fetch("/" + "token".repeat(700)).catch(() => {});
        console.error("Loading chunk failed at render (http://127.0.0.1:1/_next/static/chunks/app-1a2b3c4d5e6f7a8b.js:12:345)");
        console.error("could not sign in with {{secret:user.password}}");
        fetch("/api/v2/international-shipping-rates").catch(() => {});
      </script>`);
    }
    if (url.pathname === "/broken") return html(`<h1>Broken</h1><script>console.error("/x\\ud800=1?a"); console.error("fine after"); setTimeout(() => { throw new Error("/y\\udc00=2?b"); }, 0);</script>`);
    if (url.pathname === "/unmeasured") return html(`<script>Element.prototype.getBoundingClientRect = () => ({ x: "a", y: {}, width: 1e9, height: NaN });</script><label style="display:block;font-size:40px">Password <input type="password" style="display:block;width:1200px;height:500px;font-size:300px" value="hunter2"></label>`);
    if (url.pathname === "/relabel") return html(`<label for="k" id="l" style="display:block;font-size:40px">API key</label><input id="k" type="text" style="display:block;width:1200px;height:400px;font-size:200px"><button onclick="document.getElementById('l').textContent = 'Saved'">Save</button>`);
        if (url.pathname === "/long") return html(`<h1>Long</h1><script>console.error("x".repeat(400000));</script>`);
    if (url.pathname === "/leaky") {
      return html(`<h1>Leaky</h1><script>
        console.error("access_token=acc-tok-12345 refresh_token=ref-tok-12345 client_secret=cs-12345 authToken=camel-12345 pwd=pwd-12345");
        console.error("pass\\u200Bword=zw-hunter2 for ada\\u200B@example.test");
        console.error("Request to http://127.0.0.1:1/api/points?account=42 failed at http://shop.example/app.js:10:15");
        for (const p of ["/users/ada@example.test/orders", "/reset/tok4f9a8b7c6d5e4f3a2b1c", "/orders/12345"]) fetch(p).catch(() => {});
      </script>`);
    }
    // 260 errors from one place, then 60 from 60 places.
    if (url.pathname === "/chatty") return html(`<h1>Chatty</h1><script>for (let i = 0; i < 260; i++) console.error("line " + i + " " + "x".repeat(600));\n${Array.from({ length: 60 }, (_, i) => `console.error("place ${i}");`).join("\n")}</script>`);
    // Every text that got through an earlier way of cleaning, said and thrown by the page.
    if (url.pathname === "/corpus") return html(`<h1>Corpus</h1><script>const lines = ${JSON.stringify(LEAKED_BEFORE)};\nfor (const line of lines) console.error(line);\nlines.forEach((line, i) => setTimeout(() => { throw new Error(line); }, i));\nfor (const way of ${JSON.stringify(LEAKED_PATHS)}) fetch(way).catch(() => {});</script>`);
    if (url.pathname === "/sign-in") return html(`<label style="display:block;font-size:40px">Password <input type="password" style="display:block;width:1200px;height:500px;font-size:300px" value="hunter2"></label>`);
    if (url.pathname === "/api/points") {
      response.writeHead(500, { "content-type": "application/json" });
      return response.end('{"error":"points service down"}');
    }
    if (url.pathname === "/api/cut") return void request.socket.destroy();
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const step = (tool: string, input: Record<string, unknown>): Step => ({ tool, input, ok: true, summary: "recorded" });
const FINISH = step("finish", { outcome: "completed", reason: "Done." });
const SCENARIO: Scenario = { id: "S1", title: "Capture", basis: "requirement", requirementIds: [], intent: "Look at pages.", fixtures: {}, assertions: [] };

async function run(steps: Step[], capture: boolean): Promise<{ result: ScenarioResult; dir: string }> {
  const { baseUrl, server } = await app();
  const dir = mkdtempSync(path.join(tmpdir(), "rp-capture-"));
  try {
    const result = await runScenario({ scenario: SCENARIO, manifest: Manifest.parse({ baseUrl }), outDir: dir, mode: { kind: "replay", steps }, viewport: { width: 1280, height: 720 }, ...(capture ? { capture: true } : {}) });
    return { result, dir };
  } finally {
    server.close();
  }
}

test("a picture and a time are kept for every step, and the files are there", async () => {
  const { result, dir } = await run([step("navigate", { path: "/quiet" }), step("click", { element: { by: "role", role: "link", value: "Next" } }), FINISH], true);
  const steps = result.capture!.steps;
  assert.deepEqual(steps.map((entry) => entry.step), [1, 2, 3]);
  for (const entry of steps) {
    assert.match(entry.screenshot ?? "", /^step-\d\.png$/);
    const file = readFileSync(path.join(dir, entry.screenshot!));
    assert.equal(file.subarray(1, 4).toString("latin1"), "PNG");
    assert.ok(file.length <= CAPTURE_LIMITS.screenshotBytes);
    assert.ok(entry.durationMs >= 0);
  }
  assert.ok(steps[0]!.atMs <= steps[1]!.atMs && steps[1]!.atMs <= steps[2]!.atMs, "steps are in time order");
});

test("a password field is covered in the picture", async () => {
  const { result, dir } = await run([step("navigate", { path: "/sign-in" }), FINISH], true);
  const picture = readFileSync(path.join(dir, result.capture!.steps[0]!.screenshot!)).toString("base64");
  // Read a point in the middle of the field back out of the picture.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const [r, g, b] = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(600, 350, 1, 1).data);
    }, picture);
    assert.deepEqual([r, g, b], [0x3a, 0x3a, 0x3a], "the field is one flat colour, not what was typed");
  } finally {
    await browser.close();
  }
});

test("nothing is collected unless the run asks: no pictures, no record, the result as it always was", async () => {
  const { result, dir } = await run([step("navigate", { path: "/noisy" }), FINISH], false);
  assert.equal(result.capture, undefined);
  assert.ok(!("capture" in result));
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("step-")), []);
  assert.ok(existsSync(path.join(dir, "result.json")) && statSync(path.join(dir, "result.json")).size > 0);
});

test("taking the pictures changes nothing in the page: an animation runs as it would without them", async () => {
  const read = [step("navigate", { path: "/moving" }), step("observe", { name: "ended", target: { source: "page", by: "testid", value: "ended" } }), FINISH];
  const without = await run(read, false);
  const withPictures = await run(read, true);
  assert.deepEqual(without.result.observations, { ended: 1 });
  assert.deepEqual(withPictures.result.observations, without.result.observations);
});

test("covering a field changes nothing in the page: a page that counts its own changes counts none", async () => {
  const steps = [step("navigate", { path: "/watched" }), step("click", { element: { by: "role", role: "button", value: "Show" } }), step("observe", { name: "changes", target: { source: "page", by: "testid", value: "changes" } }), FINISH];
  const without = await run(steps, false);
  const withPictures = await run(steps, true);
  assert.deepEqual(without.result.observations, { changes: 0 });
  assert.deepEqual(withPictures.result.observations, { changes: 0 });
  assert.ok(withPictures.result.capture!.steps.every((entry) => entry.screenshot !== undefined));
});

/** Reads one point back out of a picture the run kept. */
async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ data, x, y }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
      },
      { data: readFileSync(file).toString("base64"), x, y },
    );
  } finally {
    await browser.close();
  }
}

test("a password field inside a frame is covered too, with the whole of its frame", async () => {
  const { result, dir } = await run([step("navigate", { path: "/framed" }), FINISH], true);
  const file = path.join(dir, result.capture!.steps[0]!.screenshot!);
  assert.deepEqual(await pixel(file, 600, 400), [0x3a, 0x3a, 0x3a], "inside the frame");
  assert.notDeepEqual(await pixel(file, 600, 50), [0x3a, 0x3a, 0x3a], "the page above the frame is as it was");
});

// ---- time: each pattern once found slow, with a limit ------------------------------------

const QUIET = { vault: { scrub: (text: string) => text } } as never;
const timed = (work: () => void): number => {
  const began = performance.now();
  work();
  return performance.now() - began;
};

/** The inputs that once took seconds, each at the greatest length a page can make count. */
const ONCE_SLOW: [string, string][] = [
  ["a long run of one letter (the shared redaction, before text was cut first)", "x".repeat(400_000)],
  ["the word the credential pattern looks for, repeated", "token".repeat(800)],
  ["the same with separators", "token-_".repeat(600)],
  ["another of its words", "apikey".repeat(700)],
  ["and another", "credential_".repeat(400)],
  ["a name and a separator, repeated", "password=".repeat(450)],
  ["a quoted name, repeated", '"token":"'.repeat(450)],
  ["addresses back to back", "http://a/".repeat(450)],
  ["one very long address", `http://a/${"b".repeat(3_990)}`],
  ["at signs", "a@".repeat(2_000)],
  ["separators only", "-_".repeat(2_000)],
];

test("a field a secret was typed into stays covered when the way it was found stops finding it", async () => {
  const { result, dir } = await run(
    [step("navigate", { path: "/relabel" }), step("fill", { element: { by: "label", value: "API key" }, text: "{{secret:user.password}}" }), step("click", { element: { by: "role", role: "button", value: "Save" } }), FINISH],
    true,
  );
  // After the label has changed its words: the picture is covered where the field is, or there is no picture.
  for (const entry of result.capture!.steps.filter((taken) => taken.step >= 2)) {
    if (entry.screenshot === undefined) continue;
    assert.deepEqual(await pixel(path.join(dir, entry.screenshot), 600, 250), [0x3a, 0x3a, 0x3a], `step ${entry.step}`);
  }
  assert.ok(result.capture!.steps.some((taken) => taken.step >= 3 && taken.screenshot !== undefined), "a covered picture is kept after the label changed");
});

test("a field whose place the page does not give as numbers gets no picture, and that is counted", async () => {
  const { result, dir } = await run([step("navigate", { path: "/unmeasured" }), FINISH], true);
  const entry = result.capture!.steps[0]!;
  assert.equal(entry.screenshot, undefined);
  assert.equal(entry.noScreenshot, "The picture could not be taken.");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("step-1")), []);
  assert.ok(result.capture!.leftOut.screenshots >= 1);
});

test("every field is covered or no picture is kept: fields beyond a count are never left showing", async () => {
  // 250 fields, scrolled to the last of them: the ones in the window are the last in the page.
  const many = await run([step("navigate", { path: "/many?n=250" }), FINISH], true);
  const file = path.join(many.dir, many.result.capture!.steps[0]!.screenshot!);
  for (const y of [30, 200, 400, 600, 700]) assert.deepEqual(await pixel(file, 640, y), [0x3a, 0x3a, 0x3a], `row at ${y}`);
  // More than can be covered with care: no picture at all, and it is said why not.
  const tooMany = await run([step("navigate", { path: "/many?n=2500" }), FINISH], true);
  const entry = tooMany.result.capture!.steps[0]!;
  assert.equal(entry.screenshot, undefined);
  assert.equal(entry.noScreenshot, "The picture could not be taken.");
  assert.deepEqual(readdirSync(tooMany.dir).filter((name) => name.startsWith("step-1")), []);
});

// ---- no free text: what a page says is not kept in any form ------------------------------

const ENTRY_KEYS = new Set(["step", "level", "source", "count"]);
const SOURCE_KEYS = new Set(["path", "line", "column"]);
/** Whether an entry holds only what an entry may hold: a step, a kind, a cleaned place and a count. */
function structured(entry: Record<string, unknown>): boolean {
  if (!Object.keys(entry).every((key) => ENTRY_KEYS.has(key))) return false;
  if (!Number.isInteger(entry.step) || (entry.level !== "error" && entry.level !== "uncaught") || !Number.isInteger(entry.count)) return false;
  if (entry.source === undefined) return true;
  const source = entry.source as Record<string, unknown>;
  return Object.keys(source).every((key) => SOURCE_KEYS.has(key)) && typeof source.path === "string" && /^\/[\x21-\x7e]*$/.test(source.path) && [source.line, source.column].every((value) => value === undefined || Number.isInteger(value));
}

test("of an error the page wrote or did not catch, only its kind, its step, where it came from and how often are kept: never what it said", async () => {
  const { result } = await run([step("navigate", { path: "/quiet" }), step("navigate", { path: "/noisy" }), FINISH], true);
  const said = result.capture!.console;
  assert.ok(said.length >= 2, JSON.stringify(said));
  for (const entry of said) assert.ok(structured(entry as never), JSON.stringify(entry));
  // Both kinds, tied to the step that opened the noisy page, and placed in that page's own file.
  assert.deepEqual([...new Set(said.map((entry) => entry.level))].sort(), ["error", "uncaught"]);
  assert.ok(said.every((entry) => entry.step === 2));
  assert.ok(said.some((entry) => entry.source?.path === "/noisy" && Number.isInteger(entry.source.line)), JSON.stringify(said));
  // An ordinary line and a warning are not errors. The browser's own notes of the requests that failed are.
  assert.ok(said.reduce((sum, entry) => sum + entry.count, 0) >= 2);
  assert.ok(said.filter((entry) => entry.source?.path === "/noisy").reduce((sum, entry) => sum + entry.count, 0) <= 3, JSON.stringify(said));
  const text = JSON.stringify(result.capture);
  for (const word of ["Could not load", "points for", "points is", "ordinary", "warning", "ada@example.test", "tok_live", "Bearer", "abcdefghijklmnop", "not defined"]) assert.ok(!text.includes(word), `${word} in ${text}`);
});

test("requests that failed are kept with their step, method, cleaned path, status and kind, and nothing else", async () => {
  const { result } = await run([step("navigate", { path: "/noisy" }), FINISH], true);
  const asked = result.capture!.network;
  for (const entry of asked) assert.deepEqual(Object.keys(entry).sort(), ["kind", "method", "path", "status", "step"]);
  const byPath = new Map(asked.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("/api/points")?.status, 500);
  assert.equal(byPath.get("/missing.png")?.status, 404);
  assert.equal(byPath.get("/api/cut")?.status, 0);
  // A request the run itself stopped, to another origin, is not a failure of the application.
  assert.ok(!asked.some((entry) => entry.path.includes("elsewhere")));
  const text = JSON.stringify(result.capture);
  for (const secret of ["account=42", "supersecretvalue", "session=abcdef123456", "127.0.0.1", "?"]) assert.ok(!text.includes(secret), secret);
});

test("nothing that got through an earlier way of cleaning is kept: the page says and throws every such text, and none of it is in what the run collected", async () => {
  const { result } = await run([step("navigate", { path: "/corpus" }), step("navigate", { path: "/quiet" }), FINISH], true);
  assert.equal(result.verdict, "passed");
  const capture = result.capture!;
  assert.ok(capture.console.length >= 2);
  for (const entry of capture.console) assert.ok(structured(entry as never), JSON.stringify(entry));
  // Said once each and thrown once each: all counted, whether kept as entries or left out by the limit. The
  // browser's own notes of the requests that failed are counted too.
  const counted = capture.console.reduce((sum, entry) => sum + entry.count, 0) + capture.leftOut.console;
  assert.ok(counted >= LEAKED_BEFORE.length * 2 && counted <= LEAKED_BEFORE.length * 2 + LEAKED_PATHS.length, String(counted));
  const text = JSON.stringify(capture);
  for (const secret of SECRETS_BEFORE) assert.ok(!text.includes(secret), `${JSON.stringify(secret)} in ${text}`);
  assert.ok(!/[^\x20-\x7e]/.test(text), "nothing but plain printable characters");
});

test("errors from one place are counted, not listed; there is a limit on entries for a step, and what it leaves out is counted", async () => {
  const { result } = await run([step("navigate", { path: "/chatty" }), FINISH], true);
  const capture = result.capture!;
  assert.ok(capture.console.some((entry) => entry.count === 260), JSON.stringify(capture.console.slice(0, 3)));
  assert.equal(capture.console.length, CAPTURE_LIMITS.entriesPerStep);
  assert.equal(capture.leftOut.console, 61 - CAPTURE_LIMITS.entriesPerStep);
  assert.ok(JSON.stringify(capture).length < 10_000);
});

test("a page cannot stop the run with what it says, at any length or in any form: it is counted, and the run goes on", async () => {
  const began = Date.now();
  const long = await run([step("navigate", { path: "/long" }), FINISH], true);
  assert.ok(Date.now() - began < 8_000, `took ${Date.now() - began} ms`);
  assert.equal(long.result.capture!.console.reduce((sum, entry) => sum + entry.count, 0), 1);
  assert.ok(JSON.stringify(long.result.capture).length < 2_000);
  const broken = await run([step("navigate", { path: "/broken" }), step("navigate", { path: "/quiet" }), FINISH], true);
  assert.equal(broken.result.verdict, "passed");
  assert.equal(broken.result.capture!.console.reduce((sum, entry) => sum + entry.count, 0) + broken.result.capture!.leftOut.console, 3);
});

// ---- paths: closed by default ---------------------------------------------------------------

const VAULT = { vault: { scrub: (text: string) => text.replaceAll("Zq7!vault-pw", "{{secret:u.password}}").replaceAll("alpha/bravo-charlie", "{{secret:f.path}}").replaceAll("my secret pw", "{{secret:s.p}}") } } as never;

test("a path is kept segment by segment only where it reads as an ordinary name; nothing after a credential's name is kept", () => {
  const table: [string, string][] = [
    // What identifies a request stays.
    ["/", "/"],
    ["/api/v2/international-shipping-rates", "/api/v2/international-shipping-rates"],
    ["/orders/12345", "/orders/12345"],
    ["/api/orders/2026-11-22", "/api/orders/2026-11-22"],
    ["/docs/getting-started/installation-guide", "/docs/getting-started/installation-guide"],
    ["/assets/logo@2x.png", "/assets/logo@2x.png"],
    ["/assets/index-DiwrgTda.css", "/assets/index-DiwrgTda.css"],
    ["/account/settings", "/account/settings"],
    ["/authors/jane", "/authors/jane"],
    // No query, fragment or parameters.
    ["/cb?token=abc#frag", "/cb"],
    ["/a;jsessionid=abc/b", "/a"],
    // What could be a secret goes.
    ["/_next/static/chunks/app-1a2b3c4d5e6f7a8b.js", "/_next/static/chunks/app-[redacted].js"],
    ["/users/ada@example.test/orders", "/users/[redacted]/orders"],
    ["/users/42/hunter2", "/users/42/[redacted]"],
    ["/api/v1/customers/C0012345", "/api/v1/customers/[redacted]"],
    ["/files/report final.pdf", "/files/[redacted]"],
    ["/caf\u00e9/menu", "/[redacted]/menu"],
    ["/x\ud800=1", "/[redacted]"],
    ["/%E0%A4%A", "/[redacted]"],
    // After a segment that names a credential, or a link meant for one person, nothing is kept.
    ["/reset/tok4f9a8b7c6d5e4f3a2b1c", "/reset/[redacted]"],
    ["/reset/token/hunter2", "/reset/[redacted]/[redacted]"],
    ["/verify/otp/493817", "/verify/[redacted]/[redacted]"],
    ["/pin/4821", "/pin/[redacted]"],
    ["/session/ab12cd3", "/session/[redacted]"],
    ["/password/hunter2", "/password/[redacted]"],
    ["/api/token/refresh", "/api/token/[redacted]"],
    ["/token-hunter2", "/[redacted]"],
    ["/otp-493817", "/[redacted]"],
    // A secret the executor was given, however written and wherever it lies: the whole path goes.
    ["/login/Zq7!vault-pw", "/[redacted]"],
    ["/x/Zq7%21vault-pw", "/[redacted]"],
    ["/x/Zq7%2521vault-pw", "/[redacted]"],
    ["/alpha//bravo-charlie", "/[redacted]"],
    ["/alpha/%E2%80%8Bbravo-charlie", "/[redacted]"],
    ["/alpha/%00/bravo-charlie", "/[redacted]"],
    ["/alpha/../bravo-charlie", "/[redacted]"],
    ["/files/alpha/bravo%2Dcharlie", "/[redacted]"],
    ["/find/my%20secret pw", "/[redacted]"],
    // What looks like the engine's placeholder but holds a key is not kept.
    ["/%7B%7Bsecret:sEcReTt0ken1234567890abcdefXYZ%7D%7D", "/[redacted]"],
  ];
  for (const [given, cleaned] of table) {
    assert.equal(cleanPath(VAULT, given), cleaned, given);
    // Cleaning what is clean changes nothing.
    assert.equal(cleanPath(VAULT, cleaned), cleaned, `again: ${given}`);
  }
});

test("for any path made of the pieces that have broken cleaning before: no error, plain printable characters only, no known secret, and cleaning again changes nothing", () => {
  const pieces = ["password", "token", "otp", "reset", "=", ":", " ", "?", "&", "/", "//", "/./", "/../", "%41", "%25", "%2541", "%00", "%1B", "%E2%80%AE", "%E2%80%8B", "%2F", "%3F", "%20", "://", "http", "@", "@2x.png", "[redacted]", "{{secret:u.x}}", "{{secret:sEcReTt0ken1234567890abcdefXYZ}}", "%7B%7Bsecret:", "%7D%7D", "\ud800", "\udc00", "\u200b", "\u202e", "\u0085", "\u00a0", "é", "a", "b1", "hunter2", "Bearer", '"', "'", "(", ")", "[", "]", "{", "}", ",", ";", "|", "<", ">", ".", "-", "_", "~", "x".repeat(20), "12345678901234", "0", "key", "%zz", "%", "#", ".js", "Zq7!vault-pw", "Zq7%21vault-pw", "alpha", "bravo-charlie", "bravo%2Dcharlie", "my secret pw", "my%20secret", "pw"];
  // The same cases every time: a generator with a fixed start.
  let state = 42;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let round = 0; round < 120_000; round++) {
    let text = "";
    const length = 1 + Math.floor(next() * 12);
    for (let i = 0; i < length; i++) text += pieces[Math.floor(next() * pieces.length)];
    const way = cleanPath(VAULT, `/${text}`);
    assert.match(way, /^\/[\x21-\x7e]*$/, `from ${JSON.stringify(text)}`);
    for (const secret of ["Zq7!vault-pw", "alpha/bravo-charlie", "my secret pw"]) assert.ok(!way.includes(secret), `${secret} in ${way} from ${JSON.stringify(text)}`);
    assert.equal(cleanPath(VAULT, way), way, `again, from ${JSON.stringify(text)}`);
    assert.equal(cleanPath(QUIET, way), way, `again by the result's own rule, from ${JSON.stringify(text)}`);
  }
});

test("cleaning a path takes time that does not grow with what a page puts in it: under 150 ms each, whatever its length", () => {
  cleanPath(QUIET, "/warm/up");
  for (const unit of ["token", "apikey-_", "/a", "%41", "%25", "%E2%80%AE", "/./", "//", "a=", "\ud800", "{{secret:", "[redacted]", "@", "?", ";", "x"]) {
    for (const size of [1_000, 100_000, 4_000_000]) {
      const given = `/${unit.repeat(Math.ceil(size / unit.length))}`;
      const took = timed(() => cleanPath(QUIET, given));
      assert.ok(took < 150, `${JSON.stringify(unit)} x ${size}: ${took.toFixed(1)} ms`);
      assert.ok(cleanPath(QUIET, given).length <= 201);
    }
  }
});

test("a value is kept only if it is a plain number or amount; words are not", () => {
  for (const [given, kept] of [["160", "160"], [" 42 ", "42"], ["$42.00", "$42.00"], ["-3.5%", "-3.5%"], ["1,234.56", "1,234.56"], [160, "160"]] as const) assert.equal(plainAmount(given), kept);
  for (const given of ["160 points", "hunter2", "Signed in", "", "12:30", "4111111111111111", "password=1", "1e9", "0x1f", null, undefined, {}, Number.NaN, "1".repeat(30), "12 34 56 78 90 12 34"]) assert.equal(plainAmount(given), undefined, JSON.stringify(given));
});

