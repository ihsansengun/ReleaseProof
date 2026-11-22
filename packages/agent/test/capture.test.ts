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
import { ENDPOINT_NOT_RECORDED, endpointOf, endpointOfPath, MOST_COUNTED, plainAmount, trustedRoutes, type EvidenceRoute } from "../src/execute/kept.ts";
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
        if (url.pathname === "/forged") return html(`<h1>Forged</h1><script>
        setTimeout(() => { throw new Error("card " + location.origin + "/pay:4111111:1111111 and more"); }, 0);
        setTimeout(() => { const e = new Error("x"); e.stack = "Error: " + location.origin + "/said/in/words.js:5:6\\n    at f (" + location.origin + "/the/admin/hunter/two.js?k=v#frag:12:34)"; throw e; }, 5);
      </script>`);
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

async function run(steps: Step[], capture: boolean, evidenceRoutes: EvidenceRoute[] = []): Promise<{ result: ScenarioResult; dir: string }> {
  const { baseUrl, server } = await app();
  const dir = mkdtempSync(path.join(tmpdir(), "rp-capture-"));
  try {
    const result = await runScenario({ scenario: SCENARIO, manifest: Manifest.parse({ baseUrl }), outDir: dir, mode: { kind: "replay", steps }, viewport: { width: 1280, height: 720 }, ...(capture ? { capture: true, evidenceRoutes } : {}) });
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
  // And such a run still records its trace, as it always did. Only a run that collects does not.
  assert.ok(existsSync(path.join(dir, "trace.zip")));
  const collecting = await run([step("navigate", { path: "/noisy" }), FINISH], true);
  assert.ok(!existsSync(path.join(collecting.dir, "trace.zip")));
  assert.deepEqual(readdirSync(collecting.dir).filter((name) => name.startsWith("check-")), []);
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

// ---- no free text and no address: what a page says and asks for is not kept in any form ------

const CONSOLE_KEYS = ["count", "endpoint", "level", "step"];
const NETWORK_KEYS = ["count", "endpoint", "failure", "kind", "status", "step"];
const ROUTES: EvidenceRoute[] = [{ id: "points-api", path: "/api/points" }, { id: "noisy-page", path: "/noisy" }];
/** Whether everything collected is in the forms it may have, naming no endpoint that is not on the list. */
function structured(capture: NonNullable<ScenarioResult["capture"]>, routes: EvidenceRoute[]): void {
  const names = [ENDPOINT_NOT_RECORDED, ...routes.map((route) => route.id)];
  for (const entry of capture.console) {
    assert.deepEqual(Object.keys(entry).sort(), CONSOLE_KEYS, JSON.stringify(entry));
    assert.ok(Number.isInteger(entry.step) && ["error", "uncaught"].includes(entry.level) && Number.isInteger(entry.count) && entry.count >= 1 && names.includes(entry.endpoint), JSON.stringify(entry));
  }
  for (const entry of capture.network) {
    assert.deepEqual(Object.keys(entry).sort(), NETWORK_KEYS, JSON.stringify(entry));
    assert.ok(Number.isInteger(entry.step) && Number.isInteger(entry.count) && (entry.status === 0 || (entry.status >= 400 && entry.status <= 599)), JSON.stringify(entry));
    assert.ok(["error answer", "no answer"].includes(entry.failure) && /^[a-z]{1,12}$/.test(entry.kind) && names.includes(entry.endpoint), JSON.stringify(entry));
  }
}

test("of an error the page wrote or did not catch, only its kind, its step and how often are kept: never what it said or where it came from", async () => {
  const { result } = await run([step("navigate", { path: "/quiet" }), step("navigate", { path: "/noisy" }), FINISH], true);
  const capture = result.capture!;
  structured(capture, []);
  assert.deepEqual([...new Set(capture.console.map((entry) => entry.level))].sort(), ["error", "uncaught"]);
  assert.ok(capture.console.every((entry) => entry.step === 2 && entry.endpoint === ENDPOINT_NOT_RECORDED));
  // One error the page did not catch. An ordinary line and a warning are not errors.
  assert.equal(capture.console.find((entry) => entry.level === "uncaught")?.count, 1);
  const text = JSON.stringify([capture.console, capture.network]);
  for (const word of ["Could not load", "points", "ordinary", "warning", "ada@example.test", "tok_live", "Bearer", "abcdefghijklmnop", "not defined", "noisy", "missing", "/api", "127.0.0.1", "http"]) assert.ok(!text.includes(word), `${word} in ${text}`);
});

test("of a request that failed, the status, the kind of request, whether it was answered, the step and a count are kept: no address and no part of one", async () => {
  const { result } = await run([step("navigate", { path: "/noisy" }), FINISH], true);
  const capture = result.capture!;
  structured(capture, []);
  const seen = capture.network.map((entry) => `${entry.status} ${entry.kind} ${entry.failure} ${entry.endpoint}`).sort();
  assert.deepEqual(seen, [`0 fetch no answer ${ENDPOINT_NOT_RECORDED}`, `404 image error answer ${ENDPOINT_NOT_RECORDED}`, `500 fetch error answer ${ENDPOINT_NOT_RECORDED}`]);
  // A request the run itself stopped, to another origin, is not a failure of the application: three, not four.
  assert.equal(capture.network.reduce((sum, entry) => sum + entry.count, 0), 3);
  const text = JSON.stringify([capture.console, capture.network]);
  for (const gone of ["account=42", "supersecretvalue", "session=abcdef123456", "127.0.0.1", "?", "/", "points", "missing", "cut", "elsewhere", "png"]) assert.ok(!text.includes(gone), `${gone} in ${text}`);
});

test("an endpoint is named only when the path asked for is exactly one on the trusted list, and then by its id alone", async () => {
  const { result } = await run([step("navigate", { path: "/noisy" }), FINISH], true, ROUTES);
  const capture = result.capture!;
  structured(capture, ROUTES);
  // The request to the listed path is named, with or without the query it carried. The others are not.
  assert.deepEqual(capture.network.map((entry) => `${entry.status} ${entry.endpoint}`).sort(), [`0 ${ENDPOINT_NOT_RECORDED}`, `404 ${ENDPOINT_NOT_RECORDED}`, "500 points-api"]);
  // An error the page wrote in its own file is placed there by the browser, and that file is on the list.
  assert.ok(capture.console.some((entry) => entry.level === "error" && entry.endpoint === "noisy-page"), JSON.stringify(capture.console));
  // An error that was not caught names no endpoint, whatever its trace says: the trace is the page's own text.
  assert.ok(capture.console.filter((entry) => entry.level === "uncaught").every((entry) => entry.endpoint === ENDPOINT_NOT_RECORDED));
  const text = JSON.stringify([capture.console, capture.network]);
  for (const gone of ["/api/points", "/noisy", "account=42", "supersecretvalue", "http"]) assert.ok(!text.includes(gone), `${gone} in ${text}`);
});

test("a list of routes is taken only in the form a route has, and a path is matched character for character", () => {
  const given = [
    { id: "points-api", path: "/api/points" },
    { id: "Points", path: "/x" },
    { id: "has space", path: "/y" },
    { id: "pattern", path: "/users/:id" },
    { id: "wild", path: "/files/*" },
    { id: "query", path: "/a?b=1" },
    { id: "host", path: "//elsewhere.example/a" },
    { id: "relative", path: "a/b" },
    { id: "points-api", path: "/again" },
    { id: "same-path", path: "/api/points" },
    { id: "x".repeat(40), path: "/long-id" },
    { id: "root", path: "/" },
    { id: "dots", path: "/a/../b" },
    { id: "dot", path: "/." },
    Object.create({ id: "inherited", path: "/inherited" }),
    { id: "thrower", get path(): string { throw new Error("no"); } },
    null,
    "points",
    { id: 5, path: {} },
  ];
  assert.deepEqual(trustedRoutes(given), [{ id: "points-api", path: "/api/points" }, { id: "root", path: "/" }]);
  for (const nothing of [undefined, null, "x", 5, {}]) assert.deepEqual(trustedRoutes(nothing), []);
  assert.equal(trustedRoutes(Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, path: `/p${i}` }))).length, 50);

  const routes = trustedRoutes(given);
  const origin = "http://app.example";
  assert.equal(endpointOf(routes, "http://app.example/api/points", origin), "points-api");
  assert.equal(endpointOf(routes, "http://app.example/api/points?account=42#frag", origin), "points-api");
  for (const other of [
    "http://app.example/api/points/",
    "http://app.example/api/points/42",
    "http://app.example/API/points",
    "http://app.example/api/points%2F",
    "http://app.example/api//points",
    "http://elsewhere.example/api/points",
    "https://app.example/api/points",
    "http://app.example:81/api/points",
    "http://user:pw@elsewhere.example/api/points",
    "/api/points",
    "not an address",
    "",
    null,
    undefined,
    5,
    {},
    `http://app.example/${"a".repeat(5_000)}`,
  ]) assert.equal(endpointOf(routes, other, origin), ENDPOINT_NOT_RECORDED, JSON.stringify(other)?.slice(0, 60));
  // An address that is not a web address names nothing, whatever its origin is said to be.
  assert.equal(endpointOf(routes, "file:///api/points", "null"), ENDPOINT_NOT_RECORDED);

  // A recorded step gives a path, compared as it is written: nothing is resolved, decoded or tidied first.
  assert.equal(endpointOfPath(routes, "/api/points"), "points-api");
  assert.equal(endpointOfPath(routes, "/api/points?account=42#frag"), "points-api");
  for (const other of [
    `/api/points${" ".repeat(1_995)}/more`,
    "/\\target.invalid/api/points",
    "http://target.invalid/api/points",
    "//target.invalid/api/points",
    "http://u:p@target.invalid/api/points",
    "api/points",
    "./api/points",
    " /api/points",
    "/api/po\tints",
    "\\api\\points",
    "/api/./points",
    "/api/x/../points",
    "/api/points/",
    "/API/points",
    "/api/%70oints",
    `/api/points?${"q".repeat(3_000)}`,
    "",
    null,
    5,
  ]) assert.equal(endpointOfPath(routes, other), ENDPOINT_NOT_RECORDED, JSON.stringify(other)?.slice(0, 60));
});

test("nothing that got through an earlier way of cleaning is kept: the page says, throws and asks for every such text and path, and none of it is in what the run collected", async () => {
  const { result } = await run([step("navigate", { path: "/corpus" }), step("navigate", { path: "/quiet" }), FINISH], true, ROUTES);
  assert.equal(result.verdict, "passed");
  const capture = result.capture!;
  structured(capture, ROUTES);
  // Said once each and thrown once each: all counted. The browser's own notes of the requests that failed are counted too.
  const counted = capture.console.reduce((sum, entry) => sum + entry.count, 0) + capture.leftOut.console;
  assert.ok(counted >= LEAKED_BEFORE.length * 2 && counted <= LEAKED_BEFORE.length * 2 + LEAKED_PATHS.length, String(counted));
  assert.equal(capture.network.reduce((sum, entry) => sum + entry.count, 0), LEAKED_PATHS.length);
  const text = JSON.stringify([capture.console, capture.network]);
  for (const secret of [...SECRETS_BEFORE, ...LEAKED_PATHS.flatMap((way) => way.split("/").filter((part) => part.length > 3))]) assert.ok(!text.includes(secret), `${JSON.stringify(secret)} in ${text}`);
  assert.ok(!/[^\x20-\x7e]/.test(text), "nothing but plain printable characters");
  assert.ok(!text.includes("/") && !text.includes("?") && !text.includes("%"), "no address and no part of one");
});

test("errors of one kind in a step are counted, not listed, however many a page writes", async () => {
  const { result } = await run([step("navigate", { path: "/chatty" }), FINISH], true);
  const capture = result.capture!;
  structured(capture, []);
  // 260 from one place and 60 from sixty: with no place kept they are one entry. A count stops at a hundred, which
  // then means a hundred or more: how often a page does a thing is the page's to choose.
  assert.equal(MOST_COUNTED, 100);
  assert.deepEqual(capture.console, [{ step: 1, level: "error", endpoint: ENDPOINT_NOT_RECORDED, count: 100 }]);
  assert.ok(CAPTURE_LIMITS.entriesPerStep <= 12 && CAPTURE_LIMITS.entries <= 60);
  assert.ok(JSON.stringify(capture).length < 1_000);
  assert.ok(CAPTURE_LIMITS.entriesPerStep >= 1);
});

test("a page cannot stop the run with what it says or asks for, at any length or in any form: it is counted, and the run goes on", async () => {
  const began = Date.now();
  const long = await run([step("navigate", { path: "/long" }), FINISH], true);
  assert.ok(Date.now() - began < 8_000, `took ${Date.now() - began} ms`);
  assert.equal(long.result.capture!.console.reduce((sum, entry) => sum + entry.count, 0), 1);
  assert.ok(JSON.stringify(long.result.capture).length < 2_000);
  for (const page of ["/broken", "/forged"]) {
    const run2 = await run([step("navigate", { path: page }), step("navigate", { path: "/quiet" }), FINISH], true, ROUTES);
    assert.equal(run2.result.verdict, "passed", page);
    structured(run2.result.capture!, ROUTES);
    const text = JSON.stringify([run2.result.capture!.console, run2.result.capture!.network]);
    for (const gone of ["4111111", "1111111", "pay", "said", "words", "hunter", "k=v", "frag", "/"]) assert.ok(!text.includes(gone), `${gone} in ${text}`);
  }
});

test("a value is kept only if it is a plain number or amount; words are not", () => {
  for (const [given, kept] of [["160", "160"], [" 42 ", "42"], ["$42.00", "$42.00"], ["-3.5%", "-3.5%"], ["1,234.56", "1,234.56"], [160, "160"]] as const) assert.equal(plainAmount(given), kept);
  for (const given of ["160 points", "hunter2", "Signed in", "", "12:30", "4111111111111111", "password=1", "1e9", "0x1f", null, undefined, {}, Number.NaN, "1".repeat(30), "12 34 56 78 90 12 34", "192.168.1.1", "1.2.3.4", "555 123 4567", "+1 555 123 4567", "4 9 3 8 1 7", "12\n%", "12\t%", "12\u00a0%", "12 %", "\u0661\u0662"]) assert.equal(plainAmount(given), undefined, JSON.stringify(given));
});
