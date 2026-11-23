// HTTPS spike: a target served over TLS under a name the browser cannot resolve itself, and a proxy that ends
// the browser's TLS with its own certificate, reads the request, and forwards only what bears the engine's mark.
import http from "node:http"; import https from "node:https"; import tls from "node:tls"; import net from "node:net";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";
export const CERTS = process.env.SPIKE_CERTS ?? path.join(import.meta.dirname, "certs");
const read = (name: string) => fs.readFileSync(path.join(CERTS, name));
export const now = () => Math.round(performance.now());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type Hit = { at: number; method: string; url: string; body?: string; headers?: http.IncomingHttpHeaders };
type Route = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
export const html = (body: string): Route => (_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><meta charset=utf-8><body>${body}`); };
export const js = (body: string): Route => (_q, res) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(body); };

/** An HTTPS target for `host`, with a certificate from the "public" authority of the spike (or a given one). */
export async function httpsTarget(host: string, routes: Record<string, Route> | { forwardTo: number }, cert = `${host}.pem`) {
  const hits: Hit[] = [];
  const server = https.createServer({ key: read("target.key"), cert: read(cert) }, (req, res) => {
    const url = new URL(req.url!, `https://${host}`);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ at: now(), method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString("latin1").slice(0, 2000), headers: req.headers });
      if ("forwardTo" in routes) {
        const out = http.request({ host: "127.0.0.1", port: routes.forwardTo as number, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${routes.forwardTo}`, "x-forwarded-host": host, "x-forwarded-proto": "https"} }, (back) => { res.writeHead(back.statusCode!, back.headers); back.pipe(res); });
        out.on("error", () => { res.writeHead(502); res.end(); });
        return void out.end(Buffer.concat(chunks));
      }
      const route = (routes as Record<string, Route>)[`${req.method} ${url.pathname}`];
      if (route) return route(req, res, url);
      if (req.method !== "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      res.writeHead(404); res.end("no");
    });
  });
  server.on("upgrade", (req, socket) => { hits.push({ at: now(), method: "UPGRADE", url: req.url! }); socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { host, port: (server.address() as net.AddressInfo).port, origin: `https://${host}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const leafFor = new Map<string, Buffer>();
function leaf(host: string): Buffer {
  if (!leafFor.has(host)) {
    const dir = fs.mkdtempSync("/tmp/spike-leaf-");
    execFileSync("openssl", ["req", "-new", "-key", path.join(CERTS, "leaf.key"), "-subj", `/CN=${host}`, "-out", `${dir}/l.csr`], { stdio: "ignore" });
    fs.writeFileSync(`${dir}/l.ext`, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
    execFileSync("openssl", ["x509", "-req", "-in", `${dir}/l.csr`, "-CA", path.join(CERTS, "engine-ca.pem"), "-CAkey", path.join(CERTS, "engine-ca.key"), "-CAcreateserial", "-days", "1", "-extfile", `${dir}/l.ext`, "-out", `${dir}/l.pem`], { stdio: "ignore" });
    leafFor.set(host, fs.readFileSync(`${dir}/l.pem`));
  }
  return leafFor.get(host)!;
}

/**
 * The proxy. `resolve` says where a name really is (the browser cannot resolve names itself). `allow` is the
 * set of hosts the check may reach at all. A request is forwarded only if it bears the mark; the upstream's
 * certificate is verified against the public authority.
 */
export async function markProxy(opts: { resolve: Record<string, number>; allow: string[]; mark: string | null; verifyUpstream?: boolean }) {
  const log: { at: number; what: "forwarded" | "refused-unmarked" | "refused-host" | "tunnel" | "upstream-error" | "plain-http" | "ws-refused"; line: string }[] = [];
  const state = { mark: opts.mark };
  const inner = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0]!;
    const line = `${req.method} https://${host}${req.url}`;
    if (!opts.allow.includes(host)) { log.push({ at: now(), what: "refused-host", line }); req.resume(); res.writeHead(403); return res.end(); }
    if (state.mark !== null && req.headers["x-rp-pass"] !== state.mark) { log.push({ at: now(), what: "refused-unmarked", line }); req.resume(); res.writeHead(403); return res.end(); }
    const headers = { ...req.headers }; delete headers["x-rp-pass"];
    const out = https.request({ host: "127.0.0.1", port: opts.resolve[host], servername: host, path: req.url, method: req.method, headers, ca: read("target-ca.pem"), rejectUnauthorized: opts.verifyUpstream !== false }, (back) => { log.push({ at: now(), what: "forwarded", line }); res.writeHead(back.statusCode!, back.headers); back.pipe(res); });
    out.on("error", (e) => { log.push({ at: now(), what: "upstream-error", line: `${line} ${(e as any).code ?? e.message}` }); res.writeHead(502); res.end(); });
    req.pipe(out);
  });
  inner.on("upgrade", (req, socket) => { log.push({ at: now(), what: "ws-refused", line: `UPGRADE wss://${req.headers.host}${req.url} marked=${req.headers["x-rp-pass"] === state.mark}` }); socket.end("HTTP/1.1 403 no\r\n\r\n"); });
  const outer = http.createServer((req, res) => { log.push({ at: now(), what: "plain-http", line: `${req.method} ${req.url}` }); req.resume(); res.writeHead(403); res.end(); });
  outer.on("connect", (req, socket: net.Socket) => {
    const [host, port] = req.url!.split(":");
    log.push({ at: now(), what: "tunnel", line: `CONNECT ${req.url}` });
    if (!opts.allow.includes(host!) || port !== "443") { log.push({ at: now(), what: "refused-host", line: `CONNECT ${req.url}` }); return void socket.end("HTTP/1.1 403 no\r\n\r\n"); }
    socket.write("HTTP/1.1 200 ok\r\n\r\n");
    const secure = new tls.TLSSocket(socket, { isServer: true, key: read("leaf.key"), cert: Buffer.concat([leaf(host!), read("engine-ca.pem")]), ALPNProtocols: ["http/1.1"] });
    secure.on("error", (e) => log.push({ at: now(), what: "upstream-error", line: `browser-side TLS for ${host}: ${e.message.slice(0, 80)}` }));
    inner.emit("connection", secure);
  });
  await new Promise<void>((r) => outer.listen(0, "127.0.0.1", r));
  const port = (outer.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, log, state, close: () => new Promise((r) => { outer.closeAllConnections(); inner.closeAllConnections(); outer.close(r); }) };
}

/** A browser whose only way out is the proxy: it resolves no names itself and trusts the proxy's key alone. */
export async function isolatedBrowser(proxyUrl: string, extra: string[] = [], trust: "spki" | "ignore" | "none" = "spki"): Promise<Browser> {
  const spki = fs.readFileSync(path.join(CERTS, "leaf.spki"), "utf8").trim();
  return chromium.launch({
    proxy: { server: proxyUrl, bypass: "<-loopback>" },
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", ...(trust === "spki" ? [`--ignore-certificate-errors-spki-list=${spki}`] : trust === "ignore" ? ["--ignore-certificate-errors"] : []), ...extra],
  });
}
export const newMark = () => crypto.randomBytes(16).toString("hex");
