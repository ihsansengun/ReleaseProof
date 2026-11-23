// RPAI-33: the network checkpoint, by itself. Nothing here is used by a run or by the check runner, and a test
// below holds it so. Applications, certificates and keys are made here for the tests; no model is involved.
import assert from "node:assert/strict";
import { X509Certificate, createPublicKey, generateKeyPairSync, createHash, type KeyObject } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { CHECKPOINT_LIMITS, CHECKPOINT_MARK_HEADER, CHECKPOINT_OUTCOMES, CheckpointRefused, certificateFor, openCheckpoint, type Checkpoint } from "../src/remote/checkpoint.ts";

// ---- applications to stand behind the checkpoint ----------------------------------

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type App = { port: number; seen: Seen[]; close: () => Promise<void> };
const answer = (seen: Seen[]) => (request: http.IncomingMessage, response: http.ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1");
    seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
    if (request.url === "/moved") return void response.writeHead(303, { location: "/landed" }).end();
    if (request.url === "/slow") return void setTimeout(() => response.writeHead(200).end("late"), 150);
    if (request.url === "/hangs") return;
    if (request.url === "/page") return void response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><p id="which">through the checkpoint</p>`);
    response.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] }).end(`${request.method} ${request.url} ${body.length}`);
  });
};
async function plainApp(): Promise<App> {
  const seen: Seen[] = [];
  const server = http.createServer(answer(seen));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, seen, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}
// An authority of the tests' own, standing for the public ones, and an application certified by it under a name.
const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const appKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const pem = (certificate: Buffer) => `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
async function secureApp(name: string, key: KeyObject = appKey): Promise<App & { certificate: string }> {
  const seen: Seen[] = [];
  // Self-signed under its own key; the checkpoint is told to verify against exactly this certificate.
  const certificate = pem(certificateFor(name, key, 60 * 60_000));
  const server = https.createServer({ key: key.export({ type: "pkcs8", format: "pem" }), cert: certificate }, answer(seen));
  server.on("upgrade", (request, socket) => (seen.push({ method: "UPGRADE", url: request.url!, headers: request.headers, body: "" }), socket.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, seen, certificate, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

// ---- a browser's side of it, by hand -----------------------------------------------

type Got = { status: number; body: string; headers: http.IncomingHttpHeaders };
/** A request for an http origin, as a browser sends it to a proxy. */
function viaProxy(checkpoint: Checkpoint, method: string, url: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Got> {
  const proxy = new URL(checkpoint.url!);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("latin1"), headers: response.headers }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
/** A tunnel to an https origin, and what the checkpoint says to the asking. */
function tunnel(checkpoint: Checkpoint, authority: string): Promise<{ status: number; socket: net.Socket }> {
  const proxy = new URL(checkpoint.url!);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: authority, agent: false });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode!, socket }));
    request.on("error", reject);
    request.end();
  });
}
/** A request for an https origin through a tunnel, trusting only the checkpoint's pinned key. */
async function viaTunnel(checkpoint: Checkpoint, method: string, url: string, headers: Record<string, string> = {}, body?: string, hostHeader?: string): Promise<Got & { pin: string }> {
  const target = new URL(url);
  const { status, socket } = await tunnel(checkpoint, `${target.hostname}:${target.port || 443}`);
  if (status !== 200) return (socket.destroy(), { status, body: "", headers: {}, pin: "" });
  // The browser's side of the connection the checkpoint ends: any certificate is taken, and its key is noted.
  const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
  await new Promise<void>((resolve, reject) => (secure.once("secureConnect", () => resolve()), secure.once("error", reject)));
  const pin = createHash("sha256").update(secure.getPeerX509Certificate()!.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return new Promise((resolve, reject) => {
    const request = http.request({ createConnection: () => secure, method, path: `${target.pathname}${target.search}`, headers: { host: hostHeader ?? target.host, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => (socket.destroy(), resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("latin1"), headers: response.headers, pin })));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const outcomes = (checkpoint: Checkpoint) => checkpoint.notes().map((note) => `${note.outcome} ${note.method} ${note.origin}${note.path}${note.query ? "?" : ""}`);

// ---- the certificate --------------------------------------------------------------

test("a certificate made here is for one name, for a server, under the one key, and not an authority", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const now = new Date("2026-11-23T12:00:00Z");
  const certificate = new X509Certificate(certificateFor("shop.example", key, CHECKPOINT_LIMITS.certificateMs, now));
  assert.equal(certificate.subject, "CN=shop.example");
  assert.equal(certificate.subjectAltName, "DNS:shop.example");
  assert.equal(certificate.ca, false);
  assert.ok(certificate.verify(createPublicKey(key)), "signed by its own key");
  assert.ok(certificate.checkHost("shop.example"));
  assert.equal(certificate.checkHost("other.example"), undefined);
  assert.equal(new Date(certificate.validFrom).toISOString(), "2026-11-23T11:55:00.000Z");
  assert.equal(new Date(certificate.validTo).toISOString(), "2026-11-24T12:00:00.000Z");
  assert.deepEqual(certificate.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  assert.equal(new X509Certificate(certificateFor("127.0.0.1", key, 1000)).subjectAltName, "IP Address:127.0.0.1");
  // Two for one name are two certificates; a name with anything but a name in it gets none.
  assert.notEqual(new X509Certificate(certificateFor("shop.example", key, 1000)).serialNumber, certificate.serialNumber);
  for (const name of ["", "Shop.example", "*.example", "shop.example\nDNS:other", "shop example", "-a", "a".repeat(254)]) assert.throws(() => certificateFor(name, key, 1000), CheckpointRefused, JSON.stringify(name));
});

test("origins: one to eight, each spelled as a browser spells an origin, none twice", async () => {
  for (const origins of [[], ["shop.example"], ["ftp://shop.example"], ["https://shop.example/"], ["https://shop.example/path"], ["https://Shop.example"], ["https://user@shop.example"], ["https://shop.example:443"], ["http://shop.example:80"], ["https://a.example", "https://a.example"], Array.from({ length: 9 }, (_, index) => `https://h${index}.example`)]) {
    await assert.rejects(openCheckpoint({ origins }), CheckpointRefused, JSON.stringify(origins));
  }
});

// ---- http ---------------------------------------------------------------------------

describe("the checkpoint in front of an http application", () => {
  let app: App, other: App, checkpoint: Checkpoint, origin: string;
  before(async () => {
    app = await plainApp();
    other = await plainApp();
    origin = `http://127.0.0.1:${app.port}`;
    checkpoint = await openCheckpoint({ origins: [origin] });
  });
  after(async () => {
    await checkpoint.close();
    await app.close();
    await other.close();
  });

  test("a released request is forwarded as it is, without the mark; its answer comes back as it is", async () => {
    const body = "card=4242&note=" + "x".repeat(300_000);
    const got = await viaProxy(checkpoint, "POST", `${origin}/pay?step=2`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, "content-type": "application/x-www-form-urlencoded", cookie: "sid=abc", "proxy-connection": "keep-alive" }, body);
    assert.equal(got.status, 200);
    assert.equal(got.body, `POST /pay?step=2 ${body.length}`);
    assert.deepEqual(got.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
    const seen = app.seen.at(-1)!;
    assert.equal(seen.body, body);
    assert.equal(seen.headers.cookie, "sid=abc");
    assert.equal(seen.headers.host, `127.0.0.1:${app.port}`);
    assert.equal(seen.headers[CHECKPOINT_MARK_HEADER], undefined, "the mark reached the application");
    assert.equal(seen.headers["proxy-connection"], undefined);
    assert.ok(!JSON.stringify(seen.headers).includes(checkpoint.mark));
    assert.equal(outcomes(checkpoint).at(-1), `forwarded POST ${origin}/pay?`);
  });

  test("a redirect is handed back, not followed", async () => {
    const got = await viaProxy(checkpoint, "POST", `${origin}/moved`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark });
    assert.equal(got.status, 303);
    assert.equal(got.headers.location, "/landed");
    assert.ok(!app.seen.some((seen) => seen.url === "/landed"));
  });

  test("what does not bear the mark does not reach the application", async () => {
    const wrong = checkpoint.mark.replace(/.$/, (last) => (last === "0" ? "1" : "0"));
    const marks: (Record<string, string> | undefined)[] = [undefined, { [CHECKPOINT_MARK_HEADER]: "" }, { [CHECKPOINT_MARK_HEADER]: wrong }, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark.slice(0, -1) }, { [CHECKPOINT_MARK_HEADER]: `${checkpoint.mark}0` }, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark.toUpperCase() === checkpoint.mark ? "x" : checkpoint.mark.toUpperCase() }, { [CHECKPOINT_MARK_HEADER]: `${checkpoint.mark}, ${checkpoint.mark}` }, { "x-releaseproof-release": checkpoint.mark }];
    for (const headers of marks) {
      const before = app.seen.length;
      const got = await viaProxy(checkpoint, "POST", `${origin}/unmarked`, headers, "password=hunter2");
      assert.equal(got.status, 403, JSON.stringify(headers));
      assert.equal(got.body, "");
      assert.equal(app.seen.length, before, `reached the application: ${JSON.stringify(headers)}`);
      assert.equal(outcomes(checkpoint).at(-1), `refused-unmarked POST ${origin}/unmarked`);
    }
    // The mark given twice, as two header lines: not the mark.
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(new URL(checkpoint.url!).port), "127.0.0.1", () => socket.write(`GET ${origin}/twice HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`));
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
    });
    assert.match(raw, /^HTTP\/1\.1 403/);
    assert.ok(!app.seen.some((seen) => seen.url === "/twice"));
  });

  test("an origin that is not on the list is not reached, marked or not", async () => {
    for (const url of [`http://127.0.0.1:${other.port}/x`, `http://localhost:${app.port}/x`, `http://elsewhere.example/x`]) {
      const got = await viaProxy(checkpoint, "GET", url, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark });
      assert.equal(got.status, 403, url);
      assert.match(outcomes(checkpoint).at(-1)!, /^refused-origin GET /);
    }
    assert.equal(other.seen.length, 0);
    assert.ok(!app.seen.some((seen) => seen.url === "/x"));
  });

  test("a request that names one origin and asks another, or is not one made of a proxy, is refused", async () => {
    const mismatch = await viaProxy(checkpoint, "GET", `${origin}/named`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, host: `127.0.0.1:${other.port}` });
    assert.equal(mismatch.status, 400);
    assert.equal(outcomes(checkpoint).at(-1), `refused-malformed GET ${origin}/named`);
    for (const line of ["GET /straight HTTP/1.1", "GET https://127.0.0.1/x HTTP/1.1", "GET http:// HTTP/1.1"]) {
      const raw = await new Promise<string>((resolve) => {
        const socket = net.connect(Number(new URL(checkpoint.url!).port), "127.0.0.1", () => socket.write(`${line}\r\nHost: 127.0.0.1:${app.port}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`));
        let text = "";
        socket.on("data", (chunk) => (text += chunk));
        socket.on("close", () => resolve(text));
      });
      assert.match(raw, /^HTTP\/1\.1 400/, line);
    }
    assert.ok(!app.seen.some((seen) => seen.url === "/named" || seen.url === "/straight"));
    assert.equal(other.seen.length, 0);
  });

  test("a socket is not let through, and a tunnel to an http origin is not opened", async () => {
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(new URL(checkpoint.url!).port), "127.0.0.1", () => socket.write(`GET ${origin}/socket HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`));
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
    });
    assert.match(raw, /^HTTP\/1\.1 403/);
    assert.match(outcomes(checkpoint).at(-1)!, /^refused-upgrade GET /);
    const opened = await tunnel(checkpoint, `127.0.0.1:${app.port}`);
    opened.socket.destroy();
    assert.equal(opened.status, 403);
    assert.ok(!app.seen.some((seen) => seen.url === "/socket"));
  });

  test("an application that cannot be reached, or does not answer, is a failure that is noted", async () => {
    const gone = await plainApp();
    const goneOrigin = `http://127.0.0.1:${gone.port}`;
    const forGone = await openCheckpoint({ origins: [goneOrigin] });
    await gone.close();
    const got = await viaProxy(forGone, "GET", `${goneOrigin}/x`, { [CHECKPOINT_MARK_HEADER]: forGone.mark });
    assert.equal(got.status, 502);
    assert.deepEqual(outcomes(forGone), [`upstream-failed GET ${goneOrigin}/x`]);
    await forGone.close();
  });

  test("what is kept: how each request was dealt with, its method, origin and path, and nothing else", async () => {
    const secret = "tok-5f3a9c-do-not-keep";
    await viaProxy(checkpoint, "POST", `${origin}/login?token=${secret}`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, cookie: `sid=${secret}`, authorization: `Bearer ${secret}` }, `password=${secret}`);
    await viaProxy(checkpoint, "POST", `${origin}/login?token=${secret}`, { cookie: `sid=${secret}` }, `password=${secret}`);
    const kept = JSON.stringify(checkpoint.notes());
    assert.ok(!kept.includes(secret), "a secret was kept");
    assert.ok(!kept.includes(checkpoint.mark), "the mark was kept");
    for (const note of checkpoint.notes()) {
      assert.deepEqual(Object.keys(note).sort(), ["method", "origin", "outcome", "path", "query"]);
      assert.ok((CHECKPOINT_OUTCOMES as readonly string[]).includes(note.outcome));
      assert.ok(!note.path.includes("?"));
      assert.throws(() => ((note as { path: string }).path = "/changed"), TypeError);
    }
    assert.deepEqual(checkpoint.notes().slice(-2).map((note) => [note.outcome, note.path, note.query]), [["forwarded", "/login", true], ["refused-unmarked", "/login", true]]);
    assert.equal(checkpoint.count(), checkpoint.notes().length);
    // A method or a path that is not plain text is not kept as it came.
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(new URL(checkpoint.url!).port), "127.0.0.1", () => socket.write(`get ${origin}/caf\u00e9 HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n\r\n`));
      socket.on("data", () => {});
      socket.on("close", () => resolve());
    });
    assert.ok(checkpoint.notes().every((note) => /^[\x21-\x7e]*$/.test(note.path) && /^([A-Z]{1,16}|\?)$/.test(note.method)));
  });
});

// ---- https --------------------------------------------------------------------------

describe("the checkpoint in front of an https application", () => {
  let app: App & { certificate: string }, impostor: App & { certificate: string }, checkpoint: Checkpoint;
  const origin = "https://shop.example";
  before(async () => {
    app = await secureApp("shop.example");
    // The same name under another key: an application the checkpoint must not take for the real one.
    impostor = await secureApp("bank.example", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
    const address: Record<string, number> = { "https://shop.example": app.port, "https://bank.example": impostor.port, "https://other.example": app.port };
    checkpoint = await openCheckpoint({ origins: [origin, "https://bank.example"], upstreamCa: app.certificate, upstreamAddress: (name) => (name in address ? { host: "127.0.0.1", port: address[name]! } : undefined) });
  });
  after(async () => {
    await checkpoint.close();
    await app.close();
    await impostor.close();
  });

  test("the browser's connection is ended under the checkpoint's one key, and a released request is forwarded", async () => {
    const got = await viaTunnel(checkpoint, "POST", `${origin}/pay?step=2`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, cookie: "sid=abc" }, "card=4242");
    assert.equal(got.status, 200);
    assert.equal(got.body, "POST /pay?step=2 9");
    assert.equal(got.pin, checkpoint.keyPin, "the certificate shown is not under the pinned key");
    const seen = app.seen.at(-1)!;
    assert.equal(seen.body, "card=4242");
    assert.equal(seen.headers.host, "shop.example");
    assert.equal(seen.headers.cookie, "sid=abc");
    assert.equal(seen.headers[CHECKPOINT_MARK_HEADER], undefined);
    assert.equal(outcomes(checkpoint).at(-1), `forwarded POST ${origin}/pay?`);
  });

  test("unmarked, and a socket, do not reach the application", async () => {
    const before = app.seen.length;
    assert.equal((await viaTunnel(checkpoint, "POST", `${origin}/leave`, {}, "x")).status, 403);
    assert.equal(outcomes(checkpoint).at(-1), `refused-unmarked POST ${origin}/leave`);
    assert.equal((await viaTunnel(checkpoint, "GET", `${origin}/socket`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, connection: "Upgrade", upgrade: "websocket" }).catch(() => ({ status: 403 }))).status, 403);
    assert.equal(outcomes(checkpoint).at(-1), `refused-upgrade GET ${origin}/socket`);
    assert.equal(app.seen.length, before);
  });

  test("an application whose certificate does not verify is not spoken to", async () => {
    const got = await viaTunnel(checkpoint, "POST", "https://bank.example/pay", { [CHECKPOINT_MARK_HEADER]: checkpoint.mark }, "card=4242");
    assert.equal(got.status, 502);
    assert.equal(impostor.seen.length, 0, "a request was sent to an application that was not verified");
    assert.equal(outcomes(checkpoint).at(-1), "upstream-failed POST https://bank.example/pay");
  });

  test("a tunnel is opened only to an origin on the list, at its own port", async () => {
    for (const authority of ["other.example:443", "shop.example:8443", "shop.example:80", `127.0.0.1:${app.port}`, "SHOP.example:443", "shop.example", "shop.example:443/x", "shop.example:443 x"]) {
      const opened = await tunnel(checkpoint, authority).catch(() => ({ status: 400, socket: undefined }));
      opened.socket?.destroy();
      assert.notEqual(opened.status, 200, authority);
    }
    // Inside a tunnel for one name, a request that names another is not forwarded under either.
    const before = app.seen.length;
    assert.equal((await viaTunnel(checkpoint, "GET", `${origin}/named`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark }, undefined, "bank.example")).status, 400);
    assert.equal(outcomes(checkpoint).at(-1), `refused-malformed GET ${origin}/named`);
    assert.equal(app.seen.length, before);
    // Plain http to the name of an https origin is another origin.
    assert.equal((await viaProxy(checkpoint, "GET", "http://shop.example/x", { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 403);
    assert.equal(app.seen.length, before);
  });

  test("bytes that are not a TLS greeting, or not a request, end a connection and nothing else", async () => {
    const opened = await tunnel(checkpoint, "shop.example:443");
    await new Promise<void>((resolve) => {
      opened.socket.on("close", () => resolve());
      opened.socket.on("error", () => {});
      opened.socket.write("this is not a greeting\r\n\r\n");
      setTimeout(() => (opened.socket.destroy(), resolve()), 500);
    });
    assert.equal((await viaTunnel(checkpoint, "GET", `${origin}/after`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 200);
  });
});

// ---- closing ------------------------------------------------------------------------

test("a closed checkpoint forwards nothing, ends what was open, and gives its mark to nobody", async () => {
  const app = await plainApp();
  const origin = `http://127.0.0.1:${app.port}`;
  const checkpoint = await openCheckpoint({ origins: [origin] });
  const mark = checkpoint.mark;
  const hanging = viaProxy(checkpoint, "GET", `${origin}/hangs`, { [CHECKPOINT_MARK_HEADER]: mark }).then(() => "answered", () => "cut");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await checkpoint.close();
  assert.equal(await hanging, "cut");
  await assert.rejects(viaProxy(checkpoint, "GET", `${origin}/later`, { [CHECKPOINT_MARK_HEADER]: mark }));
  assert.throws(() => checkpoint.mark, CheckpointRefused);
  assert.ok(!app.seen.some((seen) => seen.url === "/later"));
  await checkpoint.close();
  await app.close();
});

test("a checkpoint can listen on a socket path instead of a port", async () => {
  const app = await plainApp();
  const origin = `http://127.0.0.1:${app.port}`;
  const socketPath = path.join(await (await import("node:fs/promises")).mkdtemp(path.join((await import("node:os")).tmpdir(), "rp-checkpoint-")), "door.sock");
  const checkpoint = await openCheckpoint({ origins: [origin], listen: { path: socketPath } });
  assert.equal(checkpoint.url, undefined);
  const got = await new Promise<number>((resolve, reject) => http.request({ socketPath, method: "GET", path: `${origin}/by-socket`, headers: { host: `127.0.0.1:${app.port}`, [CHECKPOINT_MARK_HEADER]: checkpoint.mark }, agent: false }, (response) => (response.resume(), resolve(response.statusCode!))).on("error", reject).end());
  assert.equal(got, 200);
  await checkpoint.close();
  await app.close();
});

// ---- a real browser -----------------------------------------------------------------

describe("a browser that trusts the checkpoint's key and nothing else", () => {
  let browser: Browser, app: App & { certificate: string }, checkpoint: Checkpoint;
  const origin = "https://shop.example";
  before(async () => {
    app = await secureApp("shop.example");
    checkpoint = await openCheckpoint({ origins: [origin], upstreamCa: app.certificate, upstreamAddress: () => ({ host: "127.0.0.1", port: app.port }) });
    browser = await chromium.launch({ proxy: { server: checkpoint.url!, bypass: "<-loopback>" }, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--ignore-certificate-errors-spki-list=${checkpoint.keyPin}`] });
  });
  after(async () => {
    await browser.close();
    await checkpoint.close();
    await app.close();
  });

  test("a page the engine releases loads as a secure page; what the engine did not release is refused", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => void session.send("Fetch.continueRequest", { requestId: event.requestId, headers: Object.entries({ ...event.request.headers, [CHECKPOINT_MARK_HEADER]: checkpoint.mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}));
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    const answered = await page.goto(`${origin}/page`);
    assert.equal(answered?.status(), 200);
    assert.equal(await page.locator("#which").textContent(), "through the checkpoint");
    assert.equal(await page.evaluate("isSecureContext && location.origin"), origin);
    // A write the engine releases arrives; one sent as the page is left was never held, so it is refused.
    assert.equal(await page.evaluate(`fetch("/order", { method: "POST", body: "n=1" }).then((r) => r.status)`), 200);
    await page.evaluate(`addEventListener("pagehide", () => navigator.sendBeacon("/left", "x"))`);
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(app.seen.some((seen) => seen.method === "POST" && seen.url === "/order"));
    assert.ok(!app.seen.some((seen) => seen.url === "/left"), "what the page sent as it was left reached the application");
    assert.ok(outcomes(checkpoint).includes(`refused-unmarked POST ${origin}/left`));
    assert.ok(app.seen.every((seen) => seen.headers[CHECKPOINT_MARK_HEADER] === undefined));
    await context.close();
  });

  test("a browser that does not hold the pin does not accept the checkpoint's certificate", async () => {
    const stranger = await chromium.launch({ proxy: { server: checkpoint.url!, bypass: "<-loopback>" }, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
    try {
      const page = await stranger.newPage();
      await assert.rejects(page.goto(`${origin}/page`), /ERR_CERT/);
    } finally {
      await stranger.close();
    }
  });
});

// ---- used by nothing ----------------------------------------------------------------

test("the checkpoint is used by nothing: not by a run, and not by the check runner", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const source = path.join(root, "packages", "agent", "src", "remote", "checkpoint.ts");
  const text = await readFile(source, "utf8");
  const exported = [...text.matchAll(/^export\s+(?:async\s+)?[a-z]+\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!).sort();
  assert.equal(exported.length, [...text.matchAll(/^export\b/gm)].length, "every export of the checkpoint is one this test can name");
  assert.deepEqual(exported, ["CHECKPOINT_LIMITS", "CHECKPOINT_MARK_HEADER", "CHECKPOINT_OUTCOMES", "Checkpoint", "CheckpointNote", "CheckpointOptions", "CheckpointOutcome", "CheckpointRefused", "certificateFor", "openCheckpoint"]);
  const refers = new RegExp(`/checkpoint(\\.[cm]?[jt]s)?["'\`]|\\b(?:${exported.join("|")})\\b`);
  let files = 0;
  for (const file of await readdir(root, { recursive: true })) {
    const parts = file.split(path.sep);
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file) || parts.includes("node_modules") || parts.some((part) => part.startsWith("."))) continue;
    files += 1;
    const full = path.join(root, file);
    if (full !== source && !file.endsWith("remote-checkpoint.test.ts")) assert.doesNotMatch(await readFile(full, "utf8"), refers, `${file} refers to the checkpoint`);
  }
  assert.ok(files > 20);
  // It writes nothing and prints nothing: what it sees is in memory for as long as it lives.
  assert.doesNotMatch(text, /console\.|process\.std|node:fs|writeFile|appendFile/);
});
