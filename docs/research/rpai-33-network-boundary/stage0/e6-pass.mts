// A stronger rule: the proxy forwards only what the engine held and released (marked with a secret per check);
// everything else is refused and logged. Which requests then reach the application?
import http from "node:http"; import net from "node:net"; import crypto from "node:crypto";
import { target, launch, html, js, sleep, now } from "./lib.mts";
const P = (s: string) => `/w?s=${s}`;
const app = await target({
  "GET /": html(`<p id=which>home</p>`), "GET /blank": html(`<p>blank</p>`),
  "GET /inner": html(`<script>addEventListener("message", (e) => eval(e.data))</script>`),
  "GET /pop": html(`<script>fetch("${P("popup-fetch")}", { method: "POST" })</script>`),
  "GET /worker.js": js(`fetch("${P("worker-fetch")}", { method: "POST" })`),
  "GET /sw.js": js(`self.addEventListener("install", () => fetch("${P("sw-fetch")}", { method: "POST" }))`),
  "POST /w303": (_q, res) => { res.writeHead(303, { location: "/blank?after303" }); res.end(); },
  "POST /w307": (_q, res, url) => { res.writeHead(307, { location: `/w?s=${url.searchParams.get("s")}-redirected` }); res.end(); },
});
const pass = crypto.randomBytes(16).toString("hex");
const refused: string[] = []; const forwarded: string[] = [];
const px = http.createServer((req, res) => {
  const url = new URL(req.url!); const line = `${req.method} ${url.pathname}${url.search}`;
  if (req.headers["x-rp-pass"] !== pass) { refused.push(line); req.resume(); res.writeHead(403); return res.end(); }
  forwarded.push(line); const headers = { ...req.headers }; delete headers["x-rp-pass"];
  const out = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers }, (back) => { res.writeHead(back.statusCode!, back.headers); back.pipe(res); });
  out.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(out);
});
px.on("connect", (req, socket) => { refused.push(`CONNECT ${req.url}`); socket.end("HTTP/1.1 403 no\r\n\r\n"); });
await new Promise<void>((r) => px.listen(0, "127.0.0.1", r));
const browser = await launch(`http://127.0.0.1:${(px.address() as net.AddressInfo).port}`);
const scenarios: [string, string, ("close" | "browserclose")?][] = [
  ["fetch", `fetch("${P("fetch")}", { method: "POST" })`],
  ["xhr", `{ const x = new XMLHttpRequest(); x.open("POST", "${P("xhr")}"); x.send() }`],
  ["beacon", `navigator.sendBeacon("${P("beacon")}", "x")`],
  ["keepalive", `fetch("${P("keepalive")}", { method: "POST", keepalive: true })`],
  ["form-main", `{ const f = document.createElement("form"); f.method = "post"; f.action = "${P("form-main")}"; document.body.appendChild(f); f.submit() }`],
  ["form-303", `{ const f = document.createElement("form"); f.method = "post"; f.action = "/w303?s=form-303"; document.body.appendChild(f); f.submit() }`],
  ["fetch-307", `fetch("/w307?s=fetch-307", { method: "POST" })`],
  ["frame-fetch", `{ const f = document.createElement("iframe"); f.src = "/inner"; f.onload = () => f.contentWindow.postMessage('fetch("${P("frame-fetch")}", { method: "POST" })', "*"); document.body.appendChild(f) }`],
  ["popup-fetch", `window.open("/pop")`],
  ["worker-fetch", `new Worker("/worker.js")`],
  ["service-worker(allowed)", `navigator.serviceWorker.register("/sw.js")`],
  ["websocket", `new WebSocket("${app.origin.replace("http", "ws")}/ws?s=websocket")`],
  ["cors-preflight-like", `fetch("${P("custom-header")}", { method: "POST", headers: { "x-custom": "1", "content-type": "application/json" }, body: "{}" })`],
  ["pagehide-beacon@close", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon-close")}", "x"))`, "close"],
  ["pagehide-busy3s-beacon@close", `addEventListener("pagehide", () => { const t = performance.now(); while (performance.now() - t < 3000); navigator.sendBeacon("${P("pagehide-busy-beacon-close")}", "x") })`, "close"],
  ["pagehide-beacon@browserclose", `addEventListener("pagehide", () => navigator.sendBeacon("${P("pagehide-beacon-browserclose")}", "x"))`, "browserclose"],
];
let b = browser;
for (const [name, script, leave] of scenarios) {
  const h0 = app.hits.length, r0 = refused.length, f0 = forwarded.length;
  const context = await b.newContext({ serviceWorkers: name.startsWith("service") ? "allow" : "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", (e) => {
    const headers = Object.entries({ ...e.request.headers, "x-rp-pass": pass }).map(([name, value]) => ({ name, value: String(value) }));
    cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers }).catch((err) => console.log(name, "continue err", String(err).slice(0, 80)));
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await page.goto(app.origin + "/", { waitUntil: "load" });
  await page.evaluate(script).catch((e) => console.log(name, "evaluate:", String(e).slice(0, 80)));
  await sleep(700);
  const t0 = now(); let closeMs = 0;
  if (leave === "close") { await page.close(); closeMs = now() - t0; await sleep(4500); }
  if (leave === "browserclose") { await b.close(); closeMs = now() - t0; await sleep(1500); }
  else await sleep(500);
  const w = (list: string[]) => list.filter((l) => !l.startsWith("GET") || /ws\?/.test(l)).join(", ") || "-";
  const sawPassHeader = false;
  console.log(JSON.stringify({ name, serverGot: w(app.hits.slice(h0).map((h) => `${h.method} ${h.url}`)), proxyForwarded: w(forwarded.slice(f0)), proxyRefused: refused.slice(r0).join(", ") || "-", closeMs: closeMs || undefined }));
  if (leave !== "browserclose") await context.close().catch(() => {});
}
px.closeAllConnections(); px.close(); await app.close(); await browser.close().catch(() => {});
