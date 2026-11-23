// Which channel sees which request: CDP Fetch pause (page session), CDP Network, the proxy, the server.
import { target, proxy, launch, html, js, sleep } from "./lib.mts";
const P = (s: string) => `/w?s=${s}`;
const app = await target({
  "GET /": html(`<p>home</p>`),
  "GET /blank": html(`<p>blank</p>`),
  "GET /inner": html(`<script>addEventListener("message", (e) => eval(e.data))</script>`),
  "GET /pop": html(`<script>fetch("${P("popup-fetch")}", { method: "POST" })</script>`),
  "GET /worker.js": js(`fetch("${P("worker-fetch")}", { method: "POST" }); new Worker("/worker2.js")`),
  "GET /worker2.js": js(`fetch("${P("nested-worker-fetch")}", { method: "POST" })`),
  "GET /sw.js": js(`self.addEventListener("install", () => fetch("${P("sw-fetch")}", { method: "POST" }))`),
  "POST /w303": (_q, res) => { res.writeHead(303, { location: "/blank?after303" }); res.end(); },
  "POST /w307": (_q, res, url) => { res.writeHead(307, { location: `/w?s=${url.searchParams.get("s")}-redirected` }); res.end(); },
  "GET /es": (_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: x\n\n"); },
});
const scenarios: [string, string, ("close" | "nav" | "ctxclose")?][] = [
  ["fetch", `fetch("${P("fetch")}", { method: "POST" })`],
  ["xhr", `{ const x = new XMLHttpRequest(); x.open("POST", "${P("xhr")}"); x.send() }`],
  ["beacon", `navigator.sendBeacon("${P("beacon")}", "x")`],
  ["keepalive", `fetch("${P("keepalive")}", { method: "POST", keepalive: true })`],
  ["form-main", `{ const f = document.createElement("form"); f.method = "post"; f.action = "${P("form-main")}"; document.body.appendChild(f); f.submit() }`],
  ["form-303", `{ const f = document.createElement("form"); f.method = "post"; f.action = "/w303?s=form-303"; document.body.appendChild(f); f.submit() }`],
  ["fetch-307", `fetch("/w307?s=fetch-307", { method: "POST" })`],
  ["frame-fetch", `{ const f = document.createElement("iframe"); f.src = "/inner"; f.onload = () => f.contentWindow.postMessage('fetch("${P("frame-fetch")}", { method: "POST" })', "*"); document.body.appendChild(f) }`],
  ["frame-form-top", `{ const f = document.createElement("iframe"); document.body.appendChild(f); const d = f.contentDocument; d.body.innerHTML = '<form method=post action="${P("frame-form-top")}" target=_top></form>'; d.forms[0].submit() }`],
  ["blank-frame-fetch", `{ const f = document.createElement("iframe"); document.body.appendChild(f); f.contentWindow.fetch("${P("blank-frame-fetch")}", { method: "POST" }) }`],
  ["popup-fetch", `window.open("/pop")`],
  ["worker-fetch", `new Worker("/worker.js")`],
  ["blob-worker-fetch", `new Worker(URL.createObjectURL(new Blob(['fetch("${app.origin}${P("blob-worker-fetch")}", { method: "POST" })'], { type: "text/javascript" })))`],
  ["service-worker", `navigator.serviceWorker && navigator.serviceWorker.register("/sw.js")`],
  ["websocket", `new WebSocket("${app.origin.replace("http", "ws")}/ws?s=websocket")`],
  ["eventsource", `new EventSource("/es?s=eventsource")`],
  ["a-ping", `{ const a = document.createElement("a"); a.href = "/blank"; a.ping = "${P("a-ping")}"; document.body.appendChild(a); a.click() }`],
  ["pagehide-beacon@close", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon-close")}", "x"))`, "close"],
  ["pagehide-keepalive@close", `addEventListener("pagehide", () => fetch("${P("pagehide-keepalive-close")}", { method: "POST", keepalive: true }))`, "close"],
  ["visibility-beacon@close", `document.addEventListener("visibilitychange", () => navigator.sendBeacon("${P("visibility-beacon-close")}", "x"))`, "close"],
  ["unload-beacon@close", `addEventListener("unload", () => navigator.sendBeacon("${P("unload-beacon-close")}", "x"))`, "close"],
  ["pagehide-beacon@nav", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon-nav")}", "x"))`, "nav"],
  ["pagehide-xhr-sync@nav", `addEventListener("pagehide", () => { const x = new XMLHttpRequest(); x.open("POST", "${P("pagehide-xhr-nav")}", false); try { x.send() } catch {} })`, "nav"],
  ["pagehide-beacon@ctxclose", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon-ctxclose")}", "x"))`, "ctxclose"],
  ["pagehide-fetch-plain@close", `addEventListener("pagehide", () => fetch("${P("pagehide-fetch-plain-close")}", { method: "POST" }))`, "close"],
  ["fetchLater", `typeof fetchLater === "function" ? fetchLater("${P("fetchLater")}", { method: "POST", activateAfter: 100 }) : 0`, "close"],
];
const px = await proxy();
const browser = await launch(px.url);
const rows: Record<string, unknown>[] = [];
for (const [name, script, leave] of scenarios) {
  const tag = (list: { method: string; url: string }[]) => list.filter((h) => h.method !== "GET" && h.method !== "HEAD" || /ws\?|es\?/.test(h.url)).map((h) => h.method + " " + h.url.replace(app.origin, "")).join(", ");
  const h0 = app.hits.length, p0 = px.seen.length;
  const context = await browser.newContext({ serviceWorkers: name === "service-worker" ? "allow" : "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const paused: { method: string; url: string }[] = [], told: { method: string; url: string }[] = [];
  cdp.on("Fetch.requestPaused", (e) => { paused.push({ method: e.request.method, url: e.request.url }); cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}); });
  cdp.on("Network.requestWillBeSent", (e) => told.push({ method: e.request.method, url: e.request.url }));
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.send("Network.enable");
  await page.goto(app.origin + "/", { waitUntil: "load" });
  await page.evaluate(script).catch((e) => console.log(name, "evaluate:", String(e).slice(0, 100)));
  await sleep(700);
  if (leave === "close") await page.close();
  if (leave === "nav") await page.goto(app.origin + "/blank").catch(() => {});
  if (leave === "ctxclose") await context.close();
  await sleep(1200);
  rows.push({ name, fetchPause: tag(paused) || "-", network: tag(told) || "-", proxy: tag(px.seen.slice(p0)) || "-", server: tag(app.hits.slice(h0)) || "-" });
  await context.close().catch(() => {});
}
await sleep(1500);
for (const row of rows) console.log(JSON.stringify(row));
console.log("late arrivals after loop:", JSON.stringify(app.hits.filter((h) => h.method !== "GET").length), "proxy non-GET:", px.seen.filter((h) => h.method !== "GET").length);
await browser.close(); await px.close(); await app.close();
