// Can the page make the browser send anything that does not go through the proxy?
import dgram from "node:dgram"; import net from "node:net";
import { httpsTarget, markProxy, isolatedBrowser, html, newMark, sleep } from "./tls-lib.mts";
const udp = dgram.createSocket("udp4"); let datagrams = 0; udp.on("message", () => datagrams++);
await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r)); const udpPort = udp.address().port;
let tcpDirect = 0; const tcp = net.createServer((s) => { tcpDirect++; s.destroy(); }); await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r)); const tcpPort = (tcp.address() as net.AddressInfo).port;
const app = await httpsTarget("app.test", { "GET /": html(`<p id=which>home</p>`) });
const mark = newMark();
const px = await markProxy({ resolve: { "app.test": app.port }, allow: ["app.test"], mark });
const attempts: [string, string][] = [
  ["webrtc-stun", `(async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }] }); pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await new Promise((r) => setTimeout(r, 1500)); return pc.iceGatheringState })()`],
  ["webrtc-turn-tcp", `(async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:127.0.0.1:${tcpPort}?transport=tcp", username: "u", credential: "p" }] }); pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await new Promise((r) => setTimeout(r, 1500)); return pc.iceGatheringState })()`],
  ["webtransport", `(async () => { if (typeof WebTransport !== "function") return "no WebTransport"; try { const t = new WebTransport("https://127.0.0.1:${udpPort}/"); await Promise.race([t.ready, new Promise((_, j) => setTimeout(() => j("timeout"), 1500))]); return "ready" } catch (e) { return "failed: " + String(e).slice(0, 60) } })()`],
  ["fetch-ip-http", `fetch("http://127.0.0.1:${tcpPort}/x", { mode: "no-cors" }).then(() => "ok", (e) => "failed")`],
  ["fetch-ip-https", `fetch("https://127.0.0.1:${tcpPort}/x", { mode: "no-cors" }).then(() => "ok", (e) => "failed")`],
  ["ws-ip", `new Promise((r) => { const w = new WebSocket("ws://127.0.0.1:${tcpPort}/"); w.onerror = () => r("error"); w.onopen = () => r("open"); setTimeout(() => r("timeout"), 1500) })`],
  ["dns-prefetch+preconnect", `(() => { for (const rel of ["dns-prefetch", "preconnect"]) { const l = document.createElement("link"); l.rel = rel; l.href = "https://leak-" + rel + ".elsewhere.test"; document.head.appendChild(l) } return "added" })()`],
  ["img-ip", `new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => r("done"); i.src = "http://127.0.0.1:${tcpPort}/p.png" })`],
];
for (const [label, extra] of [["default flags", []], ["with webrtc + quic flags", ["--force-webrtc-ip-handling-policy", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", "--disable-features=WebRtcHideLocalIpsWithMdns"]]] as [string, string[]][]) {
  const browser = await isolatedBrowser(px.url, extra);
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", (e) => cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}));
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await page.goto(app.origin + "/");
  for (const [name, script] of attempts) {
    const d0 = datagrams, t0 = tcpDirect, l0 = px.log.length;
    const result = await page.evaluate(script).catch((e) => "threw " + String(e).slice(0, 60));
    await sleep(500);
    console.log(JSON.stringify({ flags: label, name, result, udpDatagramsOutsideProxy: datagrams - d0, tcpConnectionsOutsideProxy: tcpDirect - t0, proxySaw: px.log.slice(l0).filter((l) => l.what !== "forwarded").map((l) => `${l.what}: ${l.line}`).join(" | ") || "-" }));
  }
  await browser.close();
}
// The browser's own traffic at start and idle: anything not asked for by a page?
const l0 = px.log.length; const idle = await isolatedBrowser(px.url); const c = await idle.newContext(); await (await c.newPage()).goto("about:blank"); await sleep(6000); await idle.close();
console.log("browser's own traffic in 6 s idle:", JSON.stringify(px.log.slice(l0).map((l) => `${l.what}: ${l.line}`)));
udp.close(); tcp.close(); await px.close(); await app.close();
