// Over HTTPS, with the mark: what reaches the application, what is refused, what is seen as a page is left.
import { httpsTarget, markProxy, isolatedBrowser, html, js, newMark, sleep } from "./tls-lib.mts";
const P = (s: string) => `/w?s=${s}`;
const app = await httpsTarget("app.test", {
  "GET /": html(`<p id=which>home</p>`), "GET /blank": html(`<p>blank</p>`),
  "GET /inner": html(`<script>addEventListener("message", (e) => eval(e.data))</script>`),
  "GET /pop": html(`<script>fetch("${P("popup-fetch")}", { method: "POST" })</script>`),
  "GET /worker.js": js(`fetch("${P("worker-fetch")}", { method: "POST" })`),
  "GET /sw.js": js(`self.addEventListener("install", () => fetch("${P("sw-fetch")}", { method: "POST" }))`),
  "POST /w303": (_q, res) => { res.writeHead(303, { location: "/blank?after303" }); res.end(); },
  "POST /w307": (_q, res, url) => { res.writeHead(307, { location: `/w?s=${url.searchParams.get("s")}-redirected` }); res.end(); },
});
const mark = newMark();
const px = await markProxy({ resolve: { "app.test": app.port }, allow: ["app.test"], mark });
const browser = await isolatedBrowser(px.url);
const scenarios: [string, string, "close"?][] = [
  ["fetch", `fetch("${P("fetch")}", { method: "POST" })`],
  ["xhr", `{ const x = new XMLHttpRequest(); x.open("POST", "${P("xhr")}"); x.send() }`],
  ["beacon", `navigator.sendBeacon("${P("beacon")}", "x")`],
  ["keepalive", `fetch("${P("keepalive")}", { method: "POST", keepalive: true })`],
  ["form-main", `{ const f = document.createElement("form"); f.method = "post"; f.action = "${P("form-main")}"; document.body.appendChild(f); f.submit() }`],
  ["form-303", `{ const f = document.createElement("form"); f.method = "post"; f.action = "/w303?s=form-303"; document.body.appendChild(f); f.submit() }`],
  ["fetch-307", `fetch("/w307?s=fetch-307", { method: "POST" })`],
  ["frame-fetch", `{ const f = document.createElement("iframe"); f.src = "/inner"; f.onload = () => f.contentWindow.postMessage('fetch("${P("frame-fetch")}", { method: "POST" })', "*"); document.body.appendChild(f) }`],
  ["worker-fetch", `new Worker("/worker.js")`],
  ["popup-fetch", `window.open("/pop")`],
  ["service-worker(allowed)", `navigator.serviceWorker.register("/sw.js").catch(() => {})`],
  ["websocket", `new WebSocket("wss://app.test/ws?s=websocket")`],
  ["other-host-fetch", `fetch("https://elsewhere.test/collect?s=other-host", { method: "POST", mode: "no-cors" }).catch(() => {})`],
  ["other-host-img", `new Image().src = "https://elsewhere.test/pixel?s=img"`],
  ["plain-http-img", `new Image().src = "http://app.test/pixel?s=plain"`],
  ["pagehide-beacon@close", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon")}", "x"))`, "close"],
  ["pagehide-keepalive@close", `addEventListener("pagehide", () => fetch("${P("pagehide-keepalive")}", { method: "POST", keepalive: true }))`, "close"],
  ["visibility-beacon@close", `document.addEventListener("visibilitychange", () => navigator.sendBeacon("${P("visibility-beacon")}", "x"))`, "close"],
  ["unload-beacon@close", `addEventListener("unload", () => navigator.sendBeacon("${P("unload-beacon")}", "x"))`, "close"],
];
for (const [name, script, leave] of scenarios) {
  const h0 = app.hits.length, l0 = px.log.length;
  const context = await browser.newContext({ serviceWorkers: name.startsWith("service") ? "allow" : "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const paused: string[] = [];
  cdp.on("Fetch.requestPaused", (e) => { if (e.request.method !== "GET") paused.push(`${e.request.method} ${new URL(e.request.url).pathname}${new URL(e.request.url).search}`); cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await page.goto(app.origin + "/", { waitUntil: "load" });
  await page.evaluate(script).catch((e) => console.log(name, "evaluate:", String(e).slice(0, 80)));
  await sleep(700);
  if (leave) { await page.close(); await sleep(1200); }
  const w = (l: string[]) => l.join(", ") || "-";
  const logs = px.log.slice(l0).filter((l) => l.what !== "tunnel" && !(l.what === "forwarded" && l.line.startsWith("GET")));
  console.log(JSON.stringify({ name, enginePaused: w(paused), server: w(app.hits.slice(h0).filter((h) => h.method !== "GET").map((h) => `${h.method} ${h.url}`)), proxy: w(logs.map((l) => `${l.what}: ${l.line.replace("https://app.test", "")}`)) }));
  await context.close().catch(() => {});
}
// Does the mark ever reach the application or the page?
console.log("mark reached application in any request header:", app.hits.some((h) => JSON.stringify(h.headers ?? {}).includes(mark)));
await browser.close(); await px.close(); await app.close();
