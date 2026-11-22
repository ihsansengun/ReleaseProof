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
import { CAPTURE_LIMITS } from "../src/execute/capture.ts";
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
    if (url.pathname === "/long") return html(`<h1>Long</h1><script>console.error("x".repeat(400000));</script>`);
    if (url.pathname === "/leaky") {
      return html(`<h1>Leaky</h1><script>
        console.error("access_token=acc-tok-12345 refresh_token=ref-tok-12345 client_secret=cs-12345 authToken=camel-12345 pwd=pwd-12345");
        console.error("pass\\u200Bword=zw-hunter2 for ada\\u200B@example.test");
        console.error("Request to http://127.0.0.1:1/api/points?account=42 failed at http://shop.example/app.js:10:15");
        for (const p of ["/users/ada@example.test/orders", "/reset/tok4f9a8b7c6d5e4f3a2b1c", "/orders/12345"]) fetch(p).catch(() => {});
      </script>`);
    }
    if (url.pathname === "/chatty") return html(`<h1>Chatty</h1><script>for (let i = 0; i < 260; i++) console.error("line " + i + " " + "x".repeat(600));</script>`);
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

test("errors the page wrote to its console are kept with their step; ordinary lines and warnings are not", async () => {
  const { result } = await run([step("navigate", { path: "/quiet" }), step("navigate", { path: "/noisy" }), FINISH], true);
  const said = result.capture!.console;
  assert.ok(said.some((entry) => entry.level === "error" && /Could not load points/.test(entry.text)));
  assert.ok(said.some((entry) => entry.level === "uncaught" && /points is not defined/.test(entry.text)));
  assert.ok(!said.some((entry) => /ordinary line|a warning/.test(entry.text)));
  assert.ok(said.every((entry) => entry.step === 2), JSON.stringify(said));
});

test("requests that failed are kept with their step: an error answer, a missing file, and no answer at all", async () => {
  const { result } = await run([step("navigate", { path: "/noisy" }), FINISH], true);
  const failed = result.capture!.network;
  assert.ok(failed.some((entry) => entry.path === "/api/points" && entry.status === 500 && entry.method === "GET"));
  assert.ok(failed.some((entry) => entry.path === "/missing.png" && entry.status === 404));
  const cut = failed.find((entry) => entry.path === "/api/cut");
  assert.equal(cut?.status, 0);
  assert.ok((cut?.failure ?? "").length > 0);
  // A request to anywhere else was stopped by the run. It is not listed as a failure of the application.
  assert.ok(!failed.some((entry) => /elsewhere/.test(entry.path)));
});

test("what is kept is clean: no e-mail address, token, credential or query, and no host", async () => {
  const { result } = await run([step("navigate", { path: "/noisy" }), FINISH], true);
  const text = JSON.stringify(result.capture);
  for (const secret of ["ada@example.test", "tok_live_4f9a8b7c6d5e", "abcdefghijklmnop", "supersecretvalue", "account=42", "session=abcdef123456", "127.0.0.1"]) assert.ok(!text.includes(secret), secret);
  assert.ok(result.capture!.console.some((entry) => /\[redacted/.test(entry.text)));
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

test("there is a limit on entries and on the length of each, and what is left out is counted", async () => {
  const { result } = await run([step("navigate", { path: "/chatty" }), FINISH], true);
  const capture = result.capture!;
  // One step may not use up the whole allowance.
  assert.equal(capture.console.length, CAPTURE_LIMITS.entriesPerStep);
  assert.equal(capture.leftOut.console, 260 - CAPTURE_LIMITS.entriesPerStep);
  assert.ok(capture.console.every((entry) => entry.text.length <= CAPTURE_LIMITS.text));
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

test("a console line of any length costs no more than a short one", async () => {
  const began = Date.now();
  const { result } = await run([step("navigate", { path: "/long" }), FINISH], true);
  assert.ok(Date.now() - began < 8_000, `took ${Date.now() - began} ms`);
  assert.ok(result.capture!.console[0]!.text.length <= CAPTURE_LIMITS.text);
});

test("credentials under other names, split by characters that are not shown, or inside an address or a path, do not get through", async () => {
  const { result } = await run([step("navigate", { path: "/leaky" }), FINISH], true);
  const text = JSON.stringify(result.capture);
  for (const secret of ["acc-tok-12345", "ref-tok-12345", "cs-12345", "camel-12345", "pwd-12345", "zw-hunter2", "example.test", "127.0.0.1", "account=42", "shop.example", "tok4f9a8b7c6d5e4f3a2b1c"]) assert.ok(!text.includes(secret), `${secret} in ${text}`);
  const paths = result.capture!.network.map((entry) => entry.path).sort();
  // A short number in a path is an id and stays; an address and a token do not.
  assert.ok(paths.includes("/orders/12345"), paths.join(" "));
  assert.ok(paths.some((p) => p.startsWith("/reset/") && p.includes("[redacted")), paths.join(" "));
  assert.ok(paths.some((p) => p.startsWith("/users/") && p.includes("[redacted")), paths.join(" "));
  assert.ok(result.capture!.network.every((entry) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"].includes(entry.method)));
});
