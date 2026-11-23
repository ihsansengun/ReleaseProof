// The browser in a network namespace of its own: only loopback, and on it only a relay to the proxy.
import dgram from "node:dgram"; import net from "node:net"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright";
import { httpsTarget, markProxy, html, newMark, sleep, CERTS } from "./tls-lib.mts";
const here = import.meta.dirname;
const udp = dgram.createSocket("udp4"); let datagrams = 0; udp.on("message", () => datagrams++);
await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r)); const udpPort = udp.address().port;
let tcpDirect = 0; const tcp = net.createServer((s) => { tcpDirect++; s.destroy(); }); await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r)); const tcpPort = (tcp.address() as net.AddressInfo).port;
const app = await httpsTarget("app.test", { "GET /": html(`<p id=which>home</p>`) });
const mark = newMark();
const px = await markProxy({ resolve: { "app.test": app.port }, allow: ["app.test"], mark });
// The proxy's unix-socket door: bytes from the relay are handed to the proxy's TCP port outside.
const sock = fs.mkdtempSync("/tmp/spike-door-") + "/proxy.sock";
const door = net.createServer((c) => { const p = net.connect(px.port, "127.0.0.1"); c.pipe(p); p.pipe(c); c.on("error", () => p.destroy()); p.on("error", () => c.destroy()); }); await new Promise<void>((r) => door.listen(sock, r));
const INNER_PORT = 3128;
const wrapper = path.join(fs.mkdtempSync("/tmp/spike-wrap-"), "chrome-in-ns.sh");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec unshare -n sh -c 'python3 ${here}/ns-lo-up.py && (node ${here}/ns-relay.mjs ${INNER_PORT} ${sock} &) && sleep 0.3 && exec "${chromium.executablePath()}" "$@"' sh "$@"\n`, { mode: 0o755 });
const spki = fs.readFileSync(path.join(CERTS, "leaf.spki"), "utf8").trim();
const browser = await chromium.launch({ executablePath: wrapper, proxy: { server: `http://127.0.0.1:${INNER_PORT}`, bypass: "<-loopback>" }, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`] });
const context = await browser.newContext(); const page = await context.newPage(); const cdp = await context.newCDPSession(page);
cdp.on("Fetch.requestPaused", (e) => cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}));
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
const r = await page.goto(app.origin + "/").then((r) => r?.status(), (e) => String(e).split("\n")[0]);
console.log("page through the door:", r, await page.locator("#which").textContent().catch(() => "-"));
const tries: [string, string][] = [
  ["webrtc-stun", `(async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }] }); pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await new Promise((r) => setTimeout(r, 1500)); return pc.iceGatheringState })()`],
  ["webrtc-turn-udp", `(async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:127.0.0.1:${udpPort}", username: "u", credential: "p" }] }); pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await new Promise((r) => setTimeout(r, 1500)); return pc.iceGatheringState })()`],
  ["webtransport", `(async () => { try { const t = new WebTransport("https://127.0.0.1:${udpPort}/"); await Promise.race([t.ready, new Promise((_, j) => setTimeout(() => j("timeout"), 1500))]); return "ready" } catch (e) { return "failed" } })()`],
  ["fetch-ip-http", `fetch("http://127.0.0.1:${tcpPort}/x", { mode: "no-cors" }).then(() => "ok", () => "failed")`],
];
for (const [name, script] of tries) {
  const d0 = datagrams, t0 = tcpDirect, l0 = px.log.length;
  const result = await page.evaluate(script).catch((e) => "threw " + String(e).slice(0, 50)); await sleep(500);
  console.log(JSON.stringify({ name, result, udpOutside: datagrams - d0, tcpOutside: tcpDirect - t0, proxySaw: px.log.slice(l0).map((l) => `${l.what}: ${l.line}`).join(" | ") || "-" }));
}
// A marked write still works; a leave-time one is still refused.
await page.evaluate(`fetch("/w?s=in-ns", { method: "POST" })`); await page.evaluate(`addEventListener("pagehide", () => navigator.sendBeacon("/w?s=leave-in-ns", "x"))`); await sleep(400);
const l0 = px.log.length; await page.close(); await sleep(800);
console.log("server writes:", app.hits.filter((h) => h.method === "POST").map((h) => h.url).join(", "), "| at leave:", px.log.slice(l0).map((l) => `${l.what}: ${l.line}`).join(" | "));
await browser.close(); udp.close(); tcp.close(); door.close(); await px.close(); await app.close();
