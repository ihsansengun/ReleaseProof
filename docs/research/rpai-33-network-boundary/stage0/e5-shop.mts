// The real Next.js shop through the owned proxy, with every request paused and decided, acts done on the held
// node, a new page per step and the proxy sealed while a page is closed.
import { proxy, launch, sleep, now } from "./lib.mts";
const origin = "http://localhost:4311";
const key = "spike" + Date.now();
const fx = await (await fetch(origin + "/api/test/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) })).json() as { email: string; password: string };
const px = await proxy();
const browser = await launch(px.url);
const context = await browser.newContext({ serviceWorkers: "block" });
const TYPE = `function (text) { this.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(this, text); this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.value === text ? "done" : "not-set"; }`;
const CLICK = `function () { this.click(); return "done"; }`;
const short = (u: string) => u.replace(origin, "").replace("http://127.0.0.1:4311", "").slice(0, 70);
type Step = { open: string; fills?: [string, string][]; press?: string; expect?: { method: string; path: string }; read?: string };
async function step(s: Step) {
  const p0 = px.seen.length;
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const main = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const cdpSeen: string[] = []; const decided: string[] = [];
  let phase: "open" | "fill" | "press" | "after" = "open"; let released = 0;
  cdp.on("Fetch.requestPaused", (e) => {
    const url = new URL(e.request.url); const write = e.request.method !== "GET" && e.request.method !== "HEAD";
    cdpSeen.push(`${e.request.method} ${short(e.request.url)}`);
    const mainDoc = e.resourceType === "Document" && e.frameId === main;
    if (phase === "open" && !write) return void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    if (phase === "after" && !write) { if (mainDoc) decided.push(`landing ${short(e.request.url)} released`); return void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}); }
    if (!write && !mainDoc) return void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    const expected = phase === "press" && s.expect && e.request.method === s.expect.method && url.pathname === s.expect.path && released === 0;
    decided.push(`${phase}: ${e.request.method} ${short(e.request.url)} type=${e.resourceType} next-action=${e.request.headers["next-action"] ? "y" : "n"} -> ${expected ? "RELEASE" : "REFUSE"}`);
    if (expected) { released += 1; phase = "after"; return void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}); }
    cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: 204 }).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  const t0 = now();
  await page.goto(origin + s.open, { waitUntil: "networkidle" });
  const loadMs = now() - t0;
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: main });
  const node = async (sel: string) => (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, contextId: executionContextId })).result.objectId!;
  const results: string[] = [];
  phase = "fill";
  for (const [sel, text] of s.fills ?? []) results.push(String((await cdp.send("Runtime.callFunctionOn", { objectId: await node(sel), functionDeclaration: TYPE, arguments: [{ value: text }], returnByValue: true })).result.value));
  if (s.press) { phase = "press"; results.push(String((await cdp.send("Runtime.callFunctionOn", { objectId: await node(s.press), functionDeclaration: CLICK, returnByValue: true })).result.value)); await page.waitForLoadState("networkidle").catch(() => {}); await sleep(800); }
  const read = s.read ? await page.locator(s.read).first().textContent().catch(() => "?") : undefined;
  const at = short(page.url());
  // Leave: seal the proxy, close the page, wait, unseal.
  const pBefore = px.seen.length; px.state.hold = true; await page.close(); await sleep(700); px.state.hold = false;
  const atLeave = px.seen.slice(pBefore).map((h) => `${h.method} ${short(h.url)}`);
  const proxySeen = px.seen.slice(p0, pBefore).map((h) => `${h.method} ${short(h.url)}`);
  const onlyProxy = proxySeen.filter((x) => !cdpSeen.includes(x)); const onlyCdp = cdpSeen.filter((x) => !proxySeen.includes(x));
  console.log(JSON.stringify({ open: s.open, loadMs, results, decided, endedAt: at, read, requests: { cdp: cdpSeen.length, proxy: proxySeen.length, onlyProxy, onlyCdp }, writesViaProxy: proxySeen.filter((x) => !x.startsWith("GET")), atLeave }));
}
await step({ open: "/login", fills: [["#email", fx.email], ["#password", fx.password]], press: "form:has(#email) button[type=submit]", expect: { method: "POST", path: "/login" } });
await step({ open: "/account", read: "[data-testid=loyalty-balance]" });
await step({ open: "/", press: "button[aria-label^=Add]", expect: { method: "POST", path: "/" } });
await step({ open: "/cart", read: "[data-testid=cart-subtotal]" });
await step({ open: "/checkout", fills: [["#card", process.argv[2] ?? "4242424242424242"]], press: "form:has(#card) button[type=submit]", expect: { method: "POST", path: "/checkout" } });
await step({ open: "/account", read: "[data-testid=loyalty-balance]" });
await context.close(); await browser.close(); await px.close();
