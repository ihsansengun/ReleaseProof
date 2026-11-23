// A hold with a policy: a main-frame document request the engine does not expect is ended at once (204) and the
// act is void; the expected write is released. Acts are done on the held node (Runtime.callFunctionOn), as merged.
import { target, launch, html, sleep, now } from "./lib.mts";
const second = `<input aria-label="Name" autofocus oninput="fetch('/taken?typed=' + this.value)"><button onclick="fetch('/taken?pressed')">Go</button><p id=which>second</p>`;
const app = await target({
  "GET /fill-replace": html(`<input aria-label="Name" onfocus="location.replace('/second')"><p id=which>first</p>`),
  "GET /fill-form": html(`<form method=post action=/second-post></form><input aria-label="Name" onfocus="document.forms[0].submit()"><p id=which>first</p>`),
  "GET /fill-honest": html(`<input aria-label="Name"><p id=which>first</p>`),
  "GET /fill-disabled-replace": html(`<input aria-label="Name" disabled><p id=which>first</p><script>setTimeout(() => location.replace('/second'), 400)</script>`),
  "GET /press-form": html(`<form method=post action=/purchase><button>Go</button></form><p id=which>first</p>`),
  "GET /press-fetch-then-nav": html(`<button onclick="fetch('/purchase', { method: 'POST' }).then(() => location.href = '/second')">Go</button><p id=which>first</p>`),
  "GET /press-nav-then-other-posts": html(`<button onclick="location.href = '/poster'">Go</button><p id=which>first</p>`),
  "GET /poster": html(`<script>fetch('/purchase', { method: 'POST' })</script><p id=which>poster</p>`),
  "GET /press-frame-form": html(`<button onclick="const f = document.createElement('iframe'); document.body.appendChild(f); const d = f.contentDocument; d.body.innerHTML = '<form method=post action=/purchase target=_top></form>'; d.forms[0].submit(); f.remove()">Go</button><p id=which>first</p>`),
  "GET /press-popup-form": html(`<button onclick="window.name = 'main'; const w = window.open('about:blank'); w.document.body.innerHTML = '<form method=post action=/purchase target=main></form>'; w.document.forms[0].submit(); w.close()">Go</button><p id=which>first</p>`),
  "GET /meta": html(`<meta http-equiv=refresh content="0.3;url=/second"><input aria-label="Name"><p id=which>first</p>`),
  "GET /blob": html(`<p id=which>first</p><script>setTimeout(() => location.href = URL.createObjectURL(new Blob(['<p id=which>blob</p>'], { type: 'text/html' })), 200)</script>`),
  "GET /second": html(second),
  "POST /second-post": html(second),
  "POST /purchase": (_q, res) => { res.writeHead(303, { location: "/second" }); res.end(); },
  "GET /taken": (_q, res) => { res.writeHead(200); res.end("{}"); },
});
const TYPE = `function (text) { this.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(this, text); this.dispatchEvent(new InputEvent("input", { bubbles: true })); return this.isConnected && this.ownerDocument === document ? "done" : "gone"; }`;
const CLICK = `function () { this.click(); return "done"; }`;
const browser = await launch();
async function run(path: string, act: "fill" | "press" | "wait", expect?: { method: string; path: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const main = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const log: string[] = [];
  let acting = false, released = 0, refused = 0;
  const initiators = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (e) => initiators.set(e.requestId, JSON.stringify({ type: e.initiator.type, url: e.initiator.url?.replace(app.origin, ""), frame: (e.initiator as any).frameId === main ? "main" : (e.initiator as any).frameId ? "other" : undefined, stackUrl: e.initiator.stack?.callFrames[0]?.url.replace(app.origin, ""), docURL: e.documentURL.replace(app.origin, ""), hasUserGesture: e.hasUserGesture })));
  cdp.on("Page.frameRequestedNavigation", (e: any) => log.push(`frameRequestedNavigation reason=${e.reason} frame=${e.frameId === main ? "main" : "other"} url=${e.url.replace(app.origin, "")}`));
  cdp.on("Fetch.requestPaused", async (e) => {
    const url = new URL(e.request.url); const where = e.frameId === main ? "main" : "other";
    const isMainDocument = e.resourceType === "Document" && e.frameId === main;
    const write = e.request.method !== "GET" && e.request.method !== "HEAD";
    if (acting && (isMainDocument || write)) {
      const expected = expect && e.request.method === expect.method && url.pathname === expect.path && released === 0;
      // Asked while the request is held: does the browser answer about frames?
      const t = now();
      const tree = await Promise.race([cdp.send("Page.getFrameTree").then((r) => `frames=${1 + (r.frameTree.childFrames?.length ?? 0)}`, () => "err"), sleep(300).then(() => "getFrameTree: NO ANSWER 0.3s")]);
      log.push(`paused ${e.request.method} ${url.pathname} type=${e.resourceType} frame=${where} networkId=${e.networkId ? "y" : "n"} init=${initiators.get(e.networkId ?? "") ?? "?"} | ${tree} (${now() - t}ms) -> ${expected ? "RELEASE" : "REFUSE"}`);
      if (expected) { released += 1; return void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}); }
      refused += 1;
      return void cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: 204 }).catch(() => {});
    }
    cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.send("Network.enable"); await cdp.send("Page.enable");
  const h0 = app.hits.length;
  await page.goto(app.origin + path, { waitUntil: "commit" });
  acting = act === "wait";
  await page.waitForLoadState("load").catch(() => {});
  let result = "-"; const t0 = now();
  if (act !== "wait") {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: main });
    const sel = act === "fill" ? "input" : "button";
    const node = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, contextId: executionContextId })).result.objectId!;
    acting = true;
    if (path.includes("disabled")) await sleep(700);
    result = await Promise.race([cdp.send("Runtime.callFunctionOn", { objectId: node, functionDeclaration: act === "fill" ? TYPE : CLICK, arguments: act === "fill" ? [{ value: "SECRET" }] : [], returnByValue: true }).then((r) => String(r.result.value), (e) => "ERR " + String(e).slice(0, 60)), sleep(4000).then(() => "ACT HUNG 4s")]);
  }
  const took = now() - t0;
  await sleep(1200);
  const after = await Promise.race([page.evaluate("document.getElementById('which')?.textContent + '|' + location.pathname").catch((e) => "ERR " + String(e).slice(0, 60)), sleep(3000).then(() => "NO ANSWER")]);
  console.log(JSON.stringify({ path, act, result, took, released, refused, after, server: app.hits.slice(h0).filter((h) => h.method !== "GET" || h.url.includes("taken") || h.url.includes("second") || h.url.includes("poster")).map((h) => h.method + " " + h.url), log }, null, 0));
  await context.close();
}




await run("/meta", "wait");
await run("/blob", "wait");
const buy = { method: "POST", path: "/purchase" };
await run("/press-form", "press", buy);
await run("/press-fetch-then-nav", "press", buy);
await run("/press-nav-then-other-posts", "press", buy);
await run("/press-frame-form", "press", buy);
await run("/press-popup-form", "press", buy);
await browser.close(); await app.close();
