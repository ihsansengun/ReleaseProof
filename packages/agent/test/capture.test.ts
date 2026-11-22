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
import { CAPTURE_LIMITS, cleanPath, cleanText } from "../src/execute/capture.ts";
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

test("a line made of the very words redaction looks for costs no more than any other", async () => {
  const began = Date.now();
  const { result } = await run([step("navigate", { path: "/words" }), FINISH], true);
  assert.ok(Date.now() - began < 8_000, `took ${Date.now() - began} ms`);
  const capture = result.capture!;
  // An ordinary long path is kept whole, a file's hash is replaced and its name and ending kept, and the engine's own placeholder stands.
  assert.ok(capture.network.some((entry) => entry.path === "/api/v2/international-shipping-rates"), JSON.stringify(capture.network));
  assert.ok(capture.console.some((entry) => entry.text.includes("/_next/static/chunks/app-[redacted].js")), JSON.stringify(capture.console));
  assert.ok(capture.console.some((entry) => entry.text.includes("{{secret:user.password}}")));
});

test("a path is cleaned segment by segment: what identifies a request stays, what could be a secret goes", () => {
  const session = { vault: { scrub: (text: string) => text.replaceAll("Zq7!vault-pw", "{{secret:u.password}}") } } as never;
  const cases: [string, string][] = [
    // Kept: what tells one request from another.
    ["/api/v1/customers/orders/recent", "/api/v1/customers/orders/recent"],
    ["/api/v2/international-shipping-rates", "/api/v2/international-shipping-rates"],
    ["/products/blue-cotton-t-shirt-2024", "/products/blue-cotton-t-shirt-2024"],
    ["/orders/12345", "/orders/12345"],
    ["/files/annual%20report.pdf", "/files/annual%20report.pdf"],
    ["/img/IMG_20241122_101500.jpg", "/img/IMG_20241122_101500.jpg"],
    ["/page=2/sort=name", "/page=2/sort=name"],
    ["/_next/static/chunks/app-1a2b3c4d5e6f7a8b.js", "/_next/static/chunks/app-[redacted].js"],
    ["/static/js/main.8f3c1e5a9b2d.chunk.js", "/static/js/main.[redacted].chunk.js"],
    ["/login/Zq7!vault-pw", "/login/{{secret:u.password}}"],
    // Replaced: anything that does not read as an ordinary name or a short number.
    ["/orders/550e8400-e29b-41d4-a716-446655440000", "/orders/[redacted]"],
    ["/reset/tok_live_4f9a8b7c6d5e", "/reset/[redacted]"],
    ["/reset/tok4f9a8b7c6d5e4f3a2b1c", "/reset/[redacted]"],
    ["/reset/token=abc", "/reset/[redacted]"],
    ["/login/pwd=abc", "/login/[redacted]"],
    ["/sid=abc/x", "/[redacted]/x"],
    ["/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJ_adQssw5c", "/verify/[redacted]"],
    ["/magic/k3Jd9sLmQpXz-AaBbCcDdEeFfGg_7hQ2wE4rT6yU8iO0pLkJ", "/magic/[redacted]"],
    ["/b64/AbCd-EfGh_IjKl-MnOp_QrSt-UvWx_Yz01-2345_6789-abcd", "/b64/[redacted]"],
    [`/key/${"1".repeat(40)}`, "/key/[redacted]"],
    [`/k/${"a".repeat(40)}`, "/k/[redacted]"],
    ["/users/ada@example.test/orders", "/users/[redacted-e-mail]/orders"],
    ["/users/ada%40example.test/orders", "/users/[redacted-e-mail]/orders"],
    // No host, no parameters, no way up.
    ["//elsewhere.example/x", "/elsewhere.example/x"],
    ["/a;jsessionid=abc123def456ghi789", "/a"],
    ["/a/../b", "/a/b"],
    ["/", "/"],
  ];
  // Cleaning what is already clean changes nothing.
  for (const [, expected] of cases) assert.equal(cleanPath(session, expected), expected, `again: ${expected}`);
  for (const [given, expected] of cases) assert.equal(cleanPath(session, given), expected, given);
  // And in time that grows with the length and no faster.
  const began = Date.now();
  cleanPath(session, `/${"token".repeat(20_000)}/${"a1".repeat(50_000)}`);
  assert.ok(Date.now() - began < 500, `took ${Date.now() - began} ms`);
});

// ---- taking pictures does nothing to the page ------------------------------------------

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

test("cleaning a text takes time that does not blow up on any pattern once found slow: under 150 ms each", () => {
  // Once, so that the first measurement does not carry the cost of starting up.
  cleanText(QUIET, "warm up");
  for (const [what, text] of ONCE_SLOW) {
    const took = timed(() => cleanText(QUIET, text));
    assert.ok(took < 150, `${what}: ${took.toFixed(0)} ms`);
    assert.ok(cleanText(QUIET, text).length <= CAPTURE_LIMITS.text, what);
  }
});

test("cleaning a path does not blow up either: under 150 ms each, whatever its length", () => {
  cleanPath(QUIET, "/warm/up");
  for (const pathname of [`/${"token".repeat(1_000_000)}`, `/${"a1".repeat(2_000_000)}`, `/${"a@b.".repeat(500_000)}`, "/a".repeat(1_000_000), `/${"%40".repeat(500_000)}`, `/${"-_.~".repeat(500_000)}`]) {
    const took = timed(() => cleanPath(QUIET, pathname));
    assert.ok(took < 150, `${pathname.slice(0, 12)}… (${pathname.length} characters): ${took.toFixed(0)} ms`);
    assert.ok(cleanPath(QUIET, pathname).length <= 200);
  }
});

test("a whole scenario's worth of the worst lines is cleaned in under two seconds", () => {
  const worst = "token".repeat(800);
  const took = timed(() => {
    for (let i = 0; i < 400; i++) cleanText(QUIET, worst);
  });
  assert.ok(took < 2_000, `${took.toFixed(0)} ms for 400 entries`);
});

test("what cleaning must remove, and what it must leave", () => {
  const session = { vault: { scrub: (text: string) => text.replaceAll("Zq7!vault-pw", "{{secret:u.password}}") } } as never;
  const gone: [string, string][] = [
    ["an e-mail address", "mail ada@example.test now"],
    ["a bearer credential", "Authorization: Bearer abcdefghijklmnop"],
    ["a signed token", "got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"],
    ["a named password", "password=hunter2-plain"],
    ["a named token under another name", "access_token=acc-tok-12345"],
    ["a camel-case name", "clientSecret: cs-camel-12345"],
    ["the first name of a printed object", "login failed {access_token: first-key-123, user: ada}"],
    ["a printed object with one name", "{pwd: only-key-456}"],
    ["a name in quotes", "{client_secret: 'quoted-789'}"],
    ["a name of 32 characters or more", "REACT_APP_THIRD_PARTY_SERVICE_ACCESS_TOKEN=long-name-321"],
    ["a value with letters of another alphabet and a tail", `pwd=${"é".repeat(200)}REST-OF-SECRET`],
    ["a name, a sign by itself, then the value", "my_secret_key => arrow-value-654"],
    ["a long opaque value", "id 0123456789abcdef0123456789abcdef0123"],
    ["a long run of digits", "card 4111111111111111"],
    ["the executor's own secret", "tried Zq7!vault-pw twice"],
    ["a query in an address", "GET http://shop.example/api?account=42&sig=abcdef failed"],
    ["an address stuck to a word", "QQQhttp://glued.example/after?token=zz"],
    ["an address of another kind", "ws://127.0.0.1/socket?token=wstoken"],
    ["a name split by a character that is not shown", "pass\u200Bword=zw-hunter2"],
    // Found by the fourth review.
    ["a quoted name with a space after it, as JSON is printed", '{ "user": "ada", "password": "json-spaced-1", "nested": { "token": "json-nested-2" } }'],
    ["a name that is not the first, in JSON with no spaces", '{"user":"ada","password":"json-tight-3","x":1}'],
    ["JSON inside a printed object", 'resp {status: 401, body: {"error":"bad","token":"json-inner-4"}}'],
    ["single quotes", "{'password': 'single-quoted-5'}"],
    ["an address in a line that also holds the executor's secret", "GET https://app.example/login?user=ada@example.test&pw=Zq7!vault-pw failed"],
    ["an e-mail address before a colon", "ada@example.test:colon-pass-6"],
    ["a value next to something already redacted", "token=glued-7[redacted]"],
    ["a value beside the engine's placeholder", "password=beside-8&x={{secret:u.x}}"],
    ["a kind of credential stuck to its name", "authorization:Bearer stuck-9abc"],
    ["a value of several words in quotes", 'password="several words-10 here" next'],
    ["a list of values", 'token: ["a", "listed-11"] after'],
    ["the word Token before a credential", "Token after-token-12"],
    ["a header named for what it holds", "x-auth: header-13"],
    ["every value of a cookie", "Cookie: theme=dark; id=cookie-14"],
    ["a space before the sign", "password =spaced-15"],
    ["a name, a verb, a value", "password is spoken-16"],
    ["other signs between name and value", "token>arrow-17 token|pipe-18"],
    ["a sign written as a code", "token%3Dencoded-19"],
    ["an e-mail address with no dot", "ada@localhost-20"],
    ["an e-mail address with its sign written as a code", "user%40encoded-21.example"],
    ["an e-mail address stuck in front of an address", "glue@example.test,http://h.example/x"],
    ["name and password inside an address", "http://user:inline-22@host.example/x"],
    // Found by the fifth review: where a value ends cannot be told, so nothing after its start is kept.
    ["a value with signs inside it", "password=Tr0ub&dor;3x-23"],
    ["a value with a comma and a bracket", "token=ab,cd)tail-24 more"],
    ["a quoted value with a quote written inside it", '{"password":"a\\"b inner-25"}'],
    ["a value of several words with no quotes", "{password: correct horse battery-26}"],
    ["a value of several words after a verb", "the secret is correct horse staple-27"],
    ["an arrow of another kind", "token -> thin-arrow-28"],
    ["a sign of two characters", "token := walrus-29"],
    ["a name with no sign at all before a bracket", "password(paren-30)"],
    ["a credential far into a line of many words", `${"word ".repeat(70)}password=late-31`],
    ["the sixteenth value of a cookie", `Cookie: ${Array.from({ length: 15 }, (_, i) => `c${i}=v${i}`).join("; ")}; sid=sixteenth-32`],
    ["a kind of credential not named before", "Proxy-Authorization: Negotiate negotiated-33"],
    ["a digest credential", 'Authorization: Digest username="digest-34", response="abc"'],
    ["a long name that says what it holds at its end", `${"x".repeat(200)}_password=long-tail-35`],
  ];
  const secrets = ["json-spaced-1", "json-nested-2", "json-tight-3", "json-inner-4", "single-quoted-5", "app.example", "colon-pass-6", "glued-7", "beside-8", "stuck-9abc", "several", "words-10", "listed-11", "after-token-12", "header-13", "cookie-14", "spaced-15", "spoken-16", "arrow-17", "pipe-18", "encoded-19", "localhost-20", "encoded-21", "glue@", "h.example", "inline-22", "dor;3x-23", "3x-23", "tail-24", "inner-25", "horse", "battery-26", "staple-27", "thin-arrow-28", "walrus-29", "paren-30", "late-31", "sixteenth-32", "negotiated-33", "digest-34", "long-tail-35", "host.example", "ada@example.test", "abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9", "hunter2-plain", "acc-tok-12345", "cs-camel-12345", "first-key-123", "only-key-456", "quoted-789", "long-name-321", "REST-OF-SECRET", "arrow-value-654", "0123456789abcdef0123456789abcdef0123", "4111111111111111", "Zq7!vault-pw", "account=42", "sig=abcdef", "shop.example", "glued.example", "wstoken", "127.0.0.1", "zw-hunter2"];
  for (const [what, text] of gone) {
    const cleaned = cleanText(session, text);
    for (const secret of secrets) assert.ok(!cleaned.includes(secret), `${what}: ${cleaned}`);
    assert.ok(!/[\u0000-\u001f]/.test(cleaned), `${what}: a character that is not shown`);
    // Cleaning what is already clean changes nothing.
    assert.equal(cleanText(session, cleaned), cleaned, `again: ${what}`);
  }
  // Left as they are: what a person needs to make sense of an error.
  for (const kept of ["Unexpected token < in JSON at position 0", "TypeError: Cannot read properties of undefined (reading 'total')", "Failed to load resource: the server responded with a status of 404 (Not Found)", "retry=3 timeout=5000", "monkey=banana primaryKey=42", "could not sign in with {{secret:user.password}}", "token=[redacted]", "see [redacted value] and [redacted e-mail] ok"]) {
    assert.equal(cleanText(session, kept), kept);
  }
  assert.equal(cleanText(session, "failed at http://127.0.0.1:1/api/v2/international-shipping-rates?x=1"), "failed at /api/v2/international-shipping-rates");
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
