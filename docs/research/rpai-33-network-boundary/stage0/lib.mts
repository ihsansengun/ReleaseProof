import http from "node:http";
import net from "node:net";
import { chromium, type Browser } from "playwright";
export { chromium };
export type Hit = { at: number; method: string; url: string };
export const now = () => Math.round(performance.now());

/** A target application: routes by "METHOD /path"; every arrival is logged. */
export async function target(routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void>) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    hits.push({ at: now(), method: req.method!, url: req.url! });
    const route = routes[`${req.method} ${url.pathname}`] ?? routes[`* ${url.pathname}`];
    req.resume();
    req.on("end", () => {
      if (route) return route(req, res, url);
      if (req.method !== "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      res.writeHead(404); res.end("no");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
export const html = (body: string) => (_q: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><meta charset=utf-8><body>${body}`); };
export const js = (body: string) => (_q: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(body); };

/** A forwarding proxy the experiment owns: logs every request; can hold (not forward) on demand. */
export async function proxy() {
  const seen: (Hit & { held?: boolean; kind: string })[] = [];
  const state = { hold: false };
  const server = http.createServer((req, res) => {
    const held = state.hold;
    seen.push({ at: now(), method: req.method!, url: req.url!, held, kind: "http" });
    if (held) { req.resume(); res.writeHead(503); return res.end(); }
    const url = new URL(req.url!);
    const out = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers }, (back) => { res.writeHead(back.statusCode!, back.headers); back.pipe(res); });
    out.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(out);
  });
  server.on("connect", (req, socket) => {
    seen.push({ at: now(), method: "CONNECT", url: req.url!, held: state.hold, kind: "connect" });
    if (state.hold) return socket.end("HTTP/1.1 503 held\r\n\r\n");
    const [host, port] = req.url!.split(":");
    const up = net.connect(Number(port), host, () => { socket.write("HTTP/1.1 200 ok\r\n\r\n"); up.pipe(socket); socket.pipe(up); });
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
export async function launch(proxyUrl?: string): Promise<Browser> {
  return chromium.launch(proxyUrl ? { proxy: { server: proxyUrl, bypass: "<-loopback>" } } : {});
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
