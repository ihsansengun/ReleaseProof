// The Next.js shop behind HTTPS ("shop.test"), through the marking proxy, every request paused and decided,
// acts on the held node, a new page per step. Also: what tells one server action from another.
import { httpsTarget, markProxy, isolatedBrowser, newMark, sleep, now } from "./tls-lib.mts";
const site = await httpsTarget("shop.test", { forwardTo: 4311 });
const key = "tls" + Date.now();
const fx = await (await fetch("http://localhost:4311/api/test/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) })).json() as { email: string; password: string };
const mark = newMark();
const px = await markProxy({ resolve: { "shop.test": site.port }, allow: ["shop.test"], mark });
const browser = await isolatedBrowser(px.url);
const context = await browser.newContext({ serviceWorkers: "block" });
const TYPE = `function (text) { this.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(this, text); this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.value === text ? "done" : "not-set"; }`;
// Before pressing: what the form this button belongs to would submit (names only, and the values the engine typed).
const FORM_OF = `function () { const f = this.form; if (!f) return null; return { names: [...new FormData(f, this).keys()], hidden: [...f.querySelectorAll("input[type=hidden]")].map((i) => i.name + "=" + i.value.slice(0, 24)), action: f.getAttribute("action") }; }`;
const CLICK = `function () { this.click(); return "done"; }`;
type Step = { open: string; fills?: [string, string][]; press?: string; expect?: { method: string; path: string }; read?: string };
async function step(s: Step) {
  const l0 = px.log.length;
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const main = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const decided: string[] = []; let phase: "open" | "fill" | "press" | "after" = "open"; let released = 0; let writeSeen: Record<string, unknown> | undefined;
  const pass = (e: any) => cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {});
  cdp.on("Fetch.requestPaused", (e) => {
    const url = new URL(e.request.url); const write = e.request.method !== "GET" && e.request.method !== "HEAD";
    const mainDoc = e.resourceType === "Document" && e.frameId === main;
    if (!write && !(mainDoc && (phase === "fill" || phase === "press"))) return void pass(e);
    const expected = phase === "press" && s.expect && e.request.method === s.expect.method && url.pathname === s.expect.path && released === 0;
    decided.push(`${phase}: ${e.request.method} ${url.pathname} -> ${expected ? "RELEASE" : "REFUSE"}`);
    if (expected) { released += 1; phase = "after"; const body = e.request.postData ?? "";
      writeSeen = { nextAction: e.request.headers["next-action"] ?? e.request.headers["Next-Action"], contentType: (e.request.headers["content-type"] ?? e.request.headers["Content-Type"] ?? "").slice(0, 30), fieldNames: [...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1]), hasPostData: e.request.hasPostData, bodyBytes: body.length };
      return void pass(e); }
    cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: 204 }).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  const t0 = now(); await page.goto(site.origin + s.open, { waitUntil: "networkidle" }); const loadMs = now() - t0;
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: main });
  const node = async (sel: string) => (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, contextId: executionContextId })).result.objectId!;
  const results: string[] = []; let form: unknown;
  phase = "fill";
  for (const [sel, text] of s.fills ?? []) results.push(String((await cdp.send("Runtime.callFunctionOn", { objectId: await node(sel), functionDeclaration: TYPE, arguments: [{ value: text }], returnByValue: true })).result.value));
  if (s.press) { const n = await node(s.press); form = (await cdp.send("Runtime.callFunctionOn", { objectId: n, functionDeclaration: FORM_OF, returnByValue: true })).result.value; phase = "press"; results.push(String((await cdp.send("Runtime.callFunctionOn", { objectId: n, functionDeclaration: CLICK, returnByValue: true })).result.value)); await page.waitForLoadState("networkidle").catch(() => {}); await sleep(800); }
  const read = s.read ? await page.locator(s.read).first().textContent().catch(() => "?") : undefined;
  const at = page.url().replace(site.origin, "");
  const lBefore = px.log.length; await page.close(); await sleep(600);
  const atLeave = px.log.slice(lBefore).filter((l) => l.what !== "tunnel").map((l) => `${l.what}: ${l.line}`);
  const refused = px.log.slice(l0, lBefore).filter((l) => l.what !== "tunnel" && l.what !== "forwarded").map((l) => `${l.what}: ${l.line}`);
  console.log(JSON.stringify({ open: s.open, press: s.press, loadMs, results, decided, endedAt: at, read, formBeforePress: form, writeSeen, refusedByProxy: refused, atLeave }));
}
await step({ open: "/login", fills: [["#email", fx.email], ["#password", fx.password]], press: "form:has(#email) button[type=submit]", expect: { method: "POST", path: "/login" } });
await step({ open: "/account", read: "[data-testid=loyalty-balance]" });
await step({ open: "/", press: "button[aria-label^=Add]", expect: { method: "POST", path: "/" } });
await step({ open: "/checkout", fills: [["#card", "4242424242424242"]], press: "form:has(#card) button[type=submit]", expect: { method: "POST", path: "/checkout" } });
await step({ open: "/account", read: "[data-testid=loyalty-balance]" });
// The other action on the checkout page, for comparison: what would tell it from "Pay now"?
await step({ open: "/checkout", press: "header form button[type=submit], form:not(:has(#card)) button[type=submit]", expect: { method: "POST", path: "/checkout" } });
await context.close(); await browser.close(); await px.close(); await site.close();
