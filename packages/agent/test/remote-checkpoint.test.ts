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
import { CHECKPOINT_LIMITS, CHECKPOINT_MARK_HEADER, CHECKPOINT_OUTCOMES, CheckpointRefused, certificateFor, openCheckpoint, type Checkpoint, type CheckpointNote } from "../src/remote/checkpoint.ts";

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
      // An answer cut off in the middle is not an answer.
      response.on("error", reject);
      response.on("close", () => reject(new Error("the answer was cut off")));
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
  // From 2050 a certificate writes its years in full.
  assert.equal(new Date(new X509Certificate(certificateFor("shop.example", key, 1000, new Date("2051-03-01T00:00:00Z"))).validFrom).toISOString(), "2051-02-28T23:55:00.000Z");
  // Two for one name are two certificates; a name with anything but a name in it gets none.
  assert.notEqual(new X509Certificate(certificateFor("shop.example", key, 1000)).serialNumber, certificate.serialNumber);
  // The longest label and the longest name there are.
  for (const name of [`${"a".repeat(63)}.example`, `${"a.".repeat(126)}a`, "localhost", "xn--bcher-kva.example"]) assert.ok(new X509Certificate(certificateFor(name, key, 1000)).checkHost(name), name);
  for (const name of ["", "Shop.example", "*.example", "shop.example\nDNS:other", "shop example", "-a", "a".repeat(254), "shop.example.", "a..b", "a.-b", "a-.b", "127.0.0.1", "999.1.1.1", "[::1]", `${"a".repeat(64)}.example`, `${"a.".repeat(126)}aa`]) assert.throws(() => certificateFor(name, key, 1000), CheckpointRefused, JSON.stringify(name));
});

test("origins: one to eight, each spelled as a browser spells an origin, none twice", async () => {
  for (const origins of [[], ["shop.example"], ["ftp://shop.example"], ["https://shop.example/"], ["https://shop.example/path"], ["https://Shop.example"], ["https://user@shop.example"], ["https://shop.example:443"], ["http://shop.example:80"], ["https://a.example", "https://a.example"], ["https://shop.example."], ["https://-a.example"], ["https://[::1]"], ["https://127.0.0.1"], ["http://[::1]:8080"], ["http://127.0.0.1:0"], ["https://shop.example:0"], Array.from({ length: 9 }, (_, index) => `https://h${index}.example`)]) {
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
      // Kept as "other": the name asked for is the asker's text, and is not kept.
      assert.equal(outcomes(checkpoint).at(-1), "refused-origin GET other/x");
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
    assert.equal(Object.values(checkpoint.counts()).reduce((sum, n) => sum + n, 0), checkpoint.notes().length);
    assert.deepEqual(Object.keys(checkpoint.counts()).sort(), [...CHECKPOINT_OUTCOMES].sort());
    // What is handed out is a copy: changing it changes nothing here.
    (checkpoint.notes() as CheckpointNote[]).length = 0;
    assert.ok(checkpoint.notes().length > 0);
    // A long path is not kept whole; an origin that is not on the list is not kept as given.
    await viaProxy(checkpoint, "GET", `${origin}/${"p".repeat(3_000)}`);
    assert.equal(checkpoint.notes().at(-1)!.path.length, CHECKPOINT_LIMITS.path);
    await viaProxy(checkpoint, "GET", `http://${"a".repeat(200)}.secret-in-a-name.example/x`);
    assert.equal(checkpoint.notes().at(-1)!.origin, "other");
    assert.ok(!JSON.stringify(checkpoint.notes()).includes("secret-in-a-name"));
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

  test("inside a tunnel, a request that gives a whole address is not a request for the tunnel's origin", async () => {
    const before = app.seen.length;
    for (const target of ["https://shop.example/whole", "http://shop.example/whole", "https://bank.example/whole", "shop.example/whole"]) {
      const opened = await tunnel(checkpoint, "shop.example:443");
      const secure = tls.connect({ socket: opened.socket, servername: "shop.example", rejectUnauthorized: false });
      const back = await new Promise<string>((resolve) => {
        let text = "";
        secure.on("data", (chunk) => (text += chunk));
        secure.on("close", () => resolve(text));
        secure.on("error", () => resolve(text));
        secure.on("secureConnect", () => secure.write(`GET ${target} HTTP/1.1\r\nHost: shop.example\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`));
      });
      // Refused as malformed; or, where it is not even a request, the connection is ended with nothing said.
      if (target.includes("://")) {
        assert.match(back, /^HTTP\/1\.1 400/, target);
        assert.equal(outcomes(checkpoint).at(-1), `refused-malformed GET ${origin}/`);
      } else assert.equal(back, "", target);
    }
    assert.equal(app.seen.length, before);
  });

  test("an https application that never answers is a failure the browser is told of; a tunnel in a tunnel is refused and counted", async () => {
    const silent = https.createServer({ key: appKey.export({ type: "pkcs8", format: "pem" }), cert: app.certificate }, () => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const forSilent = await openCheckpoint({ origins: [origin], upstreamCa: app.certificate, upstreamAddress: () => ({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port }), shorter: { upstreamMs: 300 } });
    assert.equal((await viaTunnel(forSilent, "GET", `${origin}/quiet`, { [CHECKPOINT_MARK_HEADER]: forSilent.mark })).status, 502);
    assert.deepEqual(outcomes(forSilent), [`forwarded GET ${origin}/quiet`, `upstream-failed GET ${origin}/quiet`]);
    const opened = await tunnel(forSilent, "shop.example:443");
    const secure = tls.connect({ socket: opened.socket, servername: "shop.example", rejectUnauthorized: false });
    const back = await new Promise<string>((resolve) => {
      let text = "";
      secure.on("data", (chunk) => (text += chunk));
      secure.on("close", () => resolve(text));
      secure.on("error", () => resolve(text));
      secure.on("secureConnect", () => secure.write("CONNECT shop.example:443 HTTP/1.1\r\nHost: shop.example:443\r\n\r\n"));
    });
    assert.match(back, /^HTTP\/1\.1 403/);
    assert.equal(outcomes(forSilent).at(-1), `refused-malformed CONNECT ${origin}/`);
    await forSilent.close();
    await new Promise<void>((resolve) => (silent.closeAllConnections(), silent.close(() => resolve())));
  });

  test("an old version of TLS is spoken on neither side", async () => {
    const opened = await tunnel(checkpoint, "shop.example:443");
    const old = await new Promise<string>((resolve) => {
      const secure = tls.connect({ socket: opened.socket, servername: "shop.example", rejectUnauthorized: false, minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0" });
      secure.on("secureConnect", () => (secure.destroy(), resolve("spoken")));
      secure.on("error", () => resolve("refused"));
      secure.on("close", () => resolve("refused"));
    });
    assert.equal(old, "refused");
    // An application that speaks nothing newer is not spoken to.
    const seen: string[] = [];
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const certificate = pem(certificateFor("old.example", key, 60_000));
    const server = https.createServer({ key: key.export({ type: "pkcs8", format: "pem" }), cert: certificate, minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0" }, (request, response) => (seen.push(request.url!), response.end("old")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const forOld = await openCheckpoint({ origins: ["https://old.example"], upstreamCa: certificate, upstreamAddress: () => ({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port }) });
    assert.equal((await viaTunnel(forOld, "GET", "https://old.example/x", { [CHECKPOINT_MARK_HEADER]: forOld.mark })).status, 502);
    assert.deepEqual(seen, []);
    assert.deepEqual(outcomes(forOld), ["upstream-failed GET https://old.example/x"]);
    await forOld.close();
    await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  });

  test("closing ends a tunnel that is open, and no tunnel is opened afterwards", async () => {
    const forClosing = await openCheckpoint({ origins: [origin], upstreamCa: app.certificate, upstreamAddress: () => ({ host: "127.0.0.1", port: app.port }) });
    const opened = await tunnel(forClosing, "shop.example:443");
    const secure = tls.connect({ socket: opened.socket, servername: "shop.example", rejectUnauthorized: false });
    await new Promise<void>((resolve) => secure.once("secureConnect", () => resolve()));
    const ended = new Promise<void>((resolve) => (secure.on("close", () => resolve()), secure.on("error", () => resolve())));
    await forClosing.close();
    await ended;
    await assert.rejects(tunnel(forClosing, "shop.example:443"));
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

// ---- a hostile application, and a stranger on the loopback ---------------------------

/** An application that answers whatever it is asked with exactly these bytes, or with nothing. */
async function rawApp(bytes: string | null): Promise<{ port: number; got: string[]; sockets: Set<net.Socket>; close: () => Promise<void> }> {
  const got: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (chunk) => (got.push(chunk.toString("latin1")), bytes === null ? undefined : socket.write(bytes)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, got, sockets, close: () => new Promise((resolve) => (sockets.forEach((socket) => socket.destroy()), server.close(() => resolve()))) };
}
const sendRaw = (checkpoint: Checkpoint, text: string, then: (socket: net.Socket) => void = () => {}) =>
  new Promise<string>((resolve) => {
    const socket = net.connect(Number(new URL(checkpoint.url!).port), "127.0.0.1", () => (socket.write(text), then(socket)));
    let back = "";
    socket.on("data", (chunk) => (back += chunk));
    socket.on("error", () => {});
    socket.on("close", () => resolve(back));
  });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("what a hostile application, or a stranger on the loopback, can do to the checkpoint", () => {
  test("an answer that is not an answer is a failure, and the engine lives", async () => {
    for (const bytes of ["HTTP/1.1 099 X\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 000 X\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 600 X\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 999 X\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n", "HTTP/1.1 100 Continue\r\n\r\n", "not an answer at all\r\n\r\n", ""]) {
      const app = await rawApp(bytes === "" ? null : bytes);
      const origin = `http://127.0.0.1:${app.port}`;
      const checkpoint = await openCheckpoint({ origins: [origin], shorter: { upstreamMs: 400 } });
      const started = Date.now();
      const got = await viaProxy(checkpoint, "POST", `${origin}/transfer`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark }, "x=1");
      assert.equal(got.status, 502, JSON.stringify(bytes));
      assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms: ${JSON.stringify(bytes)}`);
      // The application had the request, and that is on record, with the failure.
      assert.equal(app.got.length, 1);
      assert.deepEqual(outcomes(checkpoint), [`forwarded POST ${origin}/transfer`, `upstream-failed POST ${origin}/transfer`], JSON.stringify(bytes));
      assert.deepEqual([checkpoint.counts().forwarded, checkpoint.counts()["upstream-failed"]], [1, 1]);
      await checkpoint.close();
      await app.close();
    }
  });

  test("a connection reset at any point ends that connection and nothing else", async () => {
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const host = `Host: 127.0.0.1:${app.port}\r\n`;
    const starts = [
      `GET ${origin}/s HTTP/1.1\r\n${host}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `GET http://x/s HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `POST ${origin}/big HTTP/1.1\r\n${host}Content-Length: 1000000\r\n\r\npartial`,
      `POST ${origin}/big HTTP/1.1\r\n${host}${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\nContent-Length: 1000000\r\n\r\npartial`,
      `CONNECT 127.0.0.1:${app.port} HTTP/1.1\r\n\r\n`,
      `GET ${origin}/slow HTTP/1.1\r\n${host}${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`,
    ];
    for (let round = 0; round < 20; round += 1) await Promise.all(starts.map((text) => sendRaw(checkpoint, text, (socket) => setTimeout(() => socket.resetAndDestroy(), round % 4))));
    await pause(300);
    assert.equal((await viaProxy(checkpoint, "GET", `${origin}/after`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 200);
    await checkpoint.close();
    await app.close();
  });

  test("an application that says nothing is given up on in time; a connection that says little does not last", async () => {
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin], shorter: { upstreamMs: 300, connectionMs: 700 } });
    const started = Date.now();
    assert.equal((await viaProxy(checkpoint, "GET", `${origin}/hangs`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 502);
    assert.ok(Date.now() - started >= 250 && Date.now() - started < 2_000, `${Date.now() - started} ms`);
    assert.deepEqual(outcomes(checkpoint), [`forwarded GET ${origin}/hangs`, `upstream-failed GET ${origin}/hangs`]);
    // A header sent a byte at a time: the connection is ended all the same.
    const slow = Date.now();
    let dripping: NodeJS.Timeout | undefined;
    await sendRaw(checkpoint, `GET ${origin}/drip HTTP/1.1\r\nX-A: `, (socket) => (dripping = setInterval(() => socket.write("a"), 100)));
    clearInterval(dripping);
    assert.ok(Date.now() - slow < 2_500, `a slow connection lasted ${Date.now() - slow} ms`);
    // An answer begun and not gone on with is ended after the same silence, not left for the connection's whole time.
    const half = await rawApp("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly this much");
    const halfOrigin = `http://127.0.0.1:${half.port}`;
    const forHalf = await openCheckpoint({ origins: [halfOrigin], shorter: { upstreamMs: 300, connectionMs: 20_000 } });
    const begun = Date.now();
    await viaProxy(forHalf, "GET", `${halfOrigin}/half`, { [CHECKPOINT_MARK_HEADER]: forHalf.mark }).catch(() => undefined);
    assert.ok(Date.now() - begun < 3_000, `an answer left half said lasted ${Date.now() - begun} ms`);
    await forHalf.close();
    await half.close();
    await checkpoint.close();
    await app.close();
  });

  test("closing ends the application's side too, and nothing is counted afterwards", async () => {
    const app = await rawApp(null);
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const waiting = viaProxy(checkpoint, "GET", `${origin}/x`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark }).then(() => "answered", () => "cut");
    await pause(150);
    assert.equal(app.sockets.size, 1);
    const before = checkpoint.counts();
    await checkpoint.close();
    await pause(150);
    assert.equal(await waiting, "cut");
    assert.equal(app.sockets.size, 0, "the connection to the application outlived the checkpoint");
    assert.deepEqual(checkpoint.counts(), before);
    await app.close();
  });

  test("what the notes cannot hold is still counted", async () => {
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const extra = 40;
    const line = (index: number) => `GET ${origin}/flood${index} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n\r\n`;
    for (let sent = 0; sent < CHECKPOINT_LIMITS.notes + extra; sent += 100) await Promise.all(Array.from({ length: Math.min(100, CHECKPOINT_LIMITS.notes + extra - sent) }, (_, index) => sendRaw(checkpoint, line(sent + index))));
    assert.equal(checkpoint.notes().length, CHECKPOINT_LIMITS.notes);
    assert.equal(checkpoint.counts()["refused-unmarked"], CHECKPOINT_LIMITS.notes + extra);
    // Something sent after the notes are full is not noted, and is counted.
    await viaProxy(checkpoint, "POST", `${origin}/left`, {}, "x");
    await viaProxy(checkpoint, "POST", `${origin}/pay`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark }, "x");
    assert.equal(checkpoint.notes().length, CHECKPOINT_LIMITS.notes);
    assert.equal(checkpoint.counts()["refused-unmarked"], CHECKPOINT_LIMITS.notes + extra + 1);
    assert.equal(checkpoint.counts().forwarded, 1);
    assert.equal(app.seen.length, 1);
    await checkpoint.close();
    await app.close();
  });

  test("what is said about one connection is not passed on, in either direction", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((request, response) => (seen.push(request.headers), response.writeHead(200, { connection: "close, x-up-only", "x-up-only": "1", "x-kept": "1", "proxy-authenticate": "Basic" }).end("ok")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const got = await viaProxy(checkpoint, "GET", `${origin}/x`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, connection: "x-down-only, keep-alive", "x-down-only": "1", "x-passed": "1", "proxy-authorization": "Basic abc", te: "trailers" });
    assert.equal(got.status, 200);
    assert.deepEqual([seen[0]!["x-down-only"], seen[0]!["proxy-authorization"], seen[0]!.te, seen[0]!["x-passed"]], [undefined, undefined, undefined, "1"]);
    const more = await sendRaw(checkpoint, `GET ${origin}/y HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\nKeep-Alive: timeout=5\r\nTrailer: x-t\r\nX-Passed: 2\r\nConnection: close\r\n\r\n`);
    assert.match(more, /^HTTP\/1\.1 200/);
    assert.deepEqual([seen[1]!["keep-alive"], seen[1]!.trailer, seen[1]!["x-passed"]], [undefined, undefined, "2"]);
    assert.deepEqual([got.headers["x-up-only"], got.headers["proxy-authenticate"], got.headers["x-kept"]], [undefined, undefined, "1"]);
    await checkpoint.close();
    await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  });

  test("a released request cannot ask for its length or its addressee to be dropped on the way", async () => {
    // Sent on without its length, a body would be read by the application as a second request, released by nobody.
    const app = await rawApp("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const second = "POST /transfer-everything HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n";
    for (const names of ["content-length", "Content-Length", "close, content-length", "transfer-encoding", "host", CHECKPOINT_MARK_HEADER]) {
      const back = await sendRaw(checkpoint, `DELETE ${origin}/item/1 HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\nConnection: ${names}\r\nContent-Length: ${second.length}\r\n\r\n${second}`);
      assert.match(back, /^HTTP\/1\.1 400/, names);
      assert.equal(outcomes(checkpoint).at(-1), `refused-malformed DELETE ${origin}/item/1`);
    }
    assert.deepEqual(app.got, [], "something reached the application");
    assert.equal(checkpoint.counts().forwarded, 0);
    // With its length, the same request is one request to the application, body and all.
    const whole = await sendRaw(checkpoint, `DELETE ${origin}/item/1 HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\nConnection: close\r\nContent-Length: ${second.length}\r\n\r\n${second}`);
    assert.match(whole, /^HTTP\/1\.1 200/);
    assert.equal(app.got.length, 1);
    assert.match(app.got[0]!, /^DELETE \/item\/1 HTTP\/1\.1\r\n/);
    assert.match(app.got[0]!, /content-length: \d+|transfer-encoding: chunked/i);
    assert.equal(checkpoint.counts().forwarded, 1);
    await checkpoint.close();
    await app.close();
  });

  test("no more connections than the limit, and one that is turned away does not keep its place", async () => {
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const port = Number(new URL(checkpoint.url!).port);
    // Turned away, with every asker keeping its half open: none of them keeps a place, so the next request is served.
    const turnedAway = await Promise.all(
      Array.from({ length: CHECKPOINT_LIMITS.connections }, () => new Promise<net.Socket>((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => socket.write("CONNECT elsewhere.example:443 HTTP/1.1\r\n\r\n"));
        socket.on("data", () => {});
        socket.on("error", () => resolve(socket));
        socket.on("end", () => resolve(socket));
      })),
    );
    assert.equal(checkpoint.counts()["refused-origin"], CHECKPOINT_LIMITS.connections);
    assert.equal((await viaProxy(checkpoint, "GET", `${origin}/next`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 200);
    turnedAway.forEach((socket) => socket.destroy());
    // The limit: idle connections up to it are held; one more is ended at once; and none of it stops the count.
    const idle = await Promise.all(Array.from({ length: CHECKPOINT_LIMITS.connections }, () => new Promise<net.Socket>((resolve) => { const socket = net.connect(port, "127.0.0.1", () => resolve(socket)); socket.on("error", () => {}); })));
    await pause(200);
    const extra = await Promise.race([sendRaw(checkpoint, `GET ${origin}/over HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n${CHECKPOINT_MARK_HEADER}: ${checkpoint.mark}\r\n\r\n`), pause(2_000).then(() => "held")]);
    assert.equal(extra, "", "a connection beyond the limit was served or held");
    idle.forEach((socket) => socket.destroy());
    await pause(200);
    assert.equal((await viaProxy(checkpoint, "GET", `${origin}/after`, { [CHECKPOINT_MARK_HEADER]: checkpoint.mark })).status, 200);
    // What is handed out of the counts is a copy that cannot be changed.
    const counts = checkpoint.counts();
    assert.throws(() => ((counts as Record<string, number>).forwarded = 99), TypeError);
    assert.equal(checkpoint.counts().forwarded, 2);
    await checkpoint.close();
    await app.close();
  });

  test("the query of a request is not kept anywhere in memory, though its path is", async () => {
    // In a process of its own, with a look at everything it holds. The marks are made of bytes there, never of a
    // text, so that a text of them found afterwards is one the checkpoint kept.
    const app = await plainApp();
    const module = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "remote", "checkpoint.ts");
    const script = `
      import net from "node:net"; import v8 from "node:v8"; import { randomBytes } from "node:crypto";
      const { openCheckpoint, CHECKPOINT_MARK_HEADER } = await import(${JSON.stringify(module)});
      const origin = "http://127.0.0.1:${app.port}";
      const checkpoint = await openCheckpoint({ origins: [origin] });
      const port = Number(new URL(checkpoint.url).port);
      const letters = () => Buffer.from(randomBytes(24).map((byte) => 97 + (byte % 26)));
      const inPath = [], inQuery = [], inCookie = [];
      for (let round = 0; round < 12; round += 1) {
        const [a, b, c] = [letters(), letters(), letters()];
        inPath.push(a); inQuery.push(b); inCookie.push(c);
        const marked = round % 2 === 0 ? Buffer.from(CHECKPOINT_MARK_HEADER + ": " + checkpoint.mark + "\\r\\n") : Buffer.alloc(0);
        const bytes = Buffer.concat([Buffer.from("GET " + origin + "/p/"), a, Buffer.from("?token="), b, Buffer.from(" HTTP/1.1\\r\\nHost: 127.0.0.1:${app.port}\\r\\nCookie: sid="), c, Buffer.from("\\r\\n"), marked, Buffer.from("Connection: close\\r\\n\\r\\n")]);
        await new Promise((resolve) => { const s = net.connect(port, "127.0.0.1", () => s.write(bytes)); s.on("data", () => {}); s.on("error", () => {}); s.on("close", resolve); });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      globalThis.gc(); globalThis.gc();
      const chunks = []; for await (const chunk of v8.getHeapSnapshot()) chunks.push(chunk);
      const heap = Buffer.concat(chunks);
      const found = (list) => list.filter((needle) => heap.includes(needle)).length;
      process.stdout.write(JSON.stringify({ notes: checkpoint.notes().length, path: found(inPath), query: found(inQuery), cookie: found(inCookie) }));
      await checkpoint.close();
    `;
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", script], { timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message} ${stderr}`)) : resolve(stdout))));
    // The paths are found (so the looking works); no query and no cookie is.
    assert.deepEqual(JSON.parse(out), { notes: 12, path: 12, query: 0, cookie: 0 });
    await app.close();
  });

  test("it listens on the loopback address only, with a mark of 256 bits, and a socket path only its owner may use", async () => {
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const checkpoint = await openCheckpoint({ origins: [origin] });
    const second = await openCheckpoint({ origins: [origin] });
    assert.match(checkpoint.url!, /^http:\/\/127\.0\.0\.1:\d+$/);
    const { networkInterfaces, tmpdir } = await import("node:os");
    const elsewhere = Object.values(networkInterfaces()).flat().find((address) => address && address.family === "IPv4" && !address.internal)?.address;
    if (elsewhere !== undefined) {
      const reached = await new Promise<boolean>((resolve) => {
        const socket = net.connect(Number(new URL(checkpoint.url!).port), elsewhere, () => (socket.destroy(), resolve(true)));
        socket.on("error", () => resolve(false));
      });
      assert.equal(reached, false, `reachable at ${elsewhere}`);
    }
    for (const mark of [checkpoint.mark, second.mark]) {
      assert.match(mark, /^[0-9a-f]{64}$/);
      assert.ok(new Set(mark.match(/../g)).size >= 16, "a mark with little in it");
    }
    assert.notEqual(checkpoint.mark, second.mark);
    assert.notEqual(checkpoint.keyPin, second.keyPin);
    const { mkdtemp, stat } = await import("node:fs/promises");
    const socketPath = path.join(await mkdtemp(path.join(tmpdir(), "rp-checkpoint-")), "door.sock");
    const bySocket = await openCheckpoint({ origins: [origin], listen: { path: socketPath } });
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    for (const one of [checkpoint, second, bySocket]) await one.close();
    await app.close();
  });

  test("it prints nothing, whatever it is sent", async () => {
    // In a process of its own, so that everything printed there is the checkpoint's doing (or Node's on its behalf).
    const app = await plainApp();
    const origin = `http://127.0.0.1:${app.port}`;
    const module = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "remote", "checkpoint.ts");
    const script = `
      import http from "node:http"; import net from "node:net";
      const { openCheckpoint, CHECKPOINT_MARK_HEADER } = await import(${JSON.stringify(module)});
      const origin = ${JSON.stringify(origin)};
      const checkpoint = await openCheckpoint({ origins: [origin, "https://shop.example"], upstreamAddress: () => ({ host: "127.0.0.1", port: ${app.port} }), shorter: { upstreamMs: 500 } });
      const proxy = new URL(checkpoint.url);
      const ask = (method, url, headers, body) => new Promise((resolve) => { const r = http.request({ host: proxy.hostname, port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (a) => (a.resume(), a.on("end", resolve))); r.on("error", resolve); r.end(body); });
      const raw = (text) => new Promise((resolve) => { const s = net.connect(Number(proxy.port), "127.0.0.1", () => s.write(text)); s.on("data", () => {}); s.on("error", () => {}); s.on("close", resolve); setTimeout(() => s.destroy(), 800); });
      await ask("POST", origin + "/a?t=tok-secret", { [CHECKPOINT_MARK_HEADER]: checkpoint.mark, cookie: "sid=tok-secret" }, "password=tok-secret");
      await ask("POST", origin + "/b?t=tok-secret", { cookie: "sid=tok-secret" }, "password=tok-secret");
      await ask("GET", "http://elsewhere.example/tok-secret", {});
      await raw("garbage\\r\\n\\r\\n");
      await raw("CONNECT shop.example:443 HTTP/1.1\\r\\n\\r\\nnot a greeting");
      await raw("GET " + origin + "/s HTTP/1.1\\r\\nHost: x\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n");
      const counts = checkpoint.counts();
      await checkpoint.close();
      if (counts.forwarded !== 1 || counts["refused-unmarked"] !== 1 || counts["refused-origin"] !== 1) process.exit(3);
    `;
    const { execFile } = await import("node:child_process");
    const ran = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000 }, (error, out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err })));
    assert.deepEqual(ran, { code: 0, out: "", err: "" });
    await app.close();
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
    // The browser sends it when it gets round to it: waited for, up to a limit, and then a moment more for
    // anything that would have gone on to the application.
    for (let waited = 0; waited < 10_000 && !outcomes(checkpoint).includes(`refused-unmarked POST ${origin}/left`); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 300));
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
  const tests = path.join(root, "packages", "agent", "test", "remote-checkpoint.test.ts");
  const beside = [path.join(path.dirname(source), "isolated.ts"), path.join(path.dirname(source), "isolated-inside.mjs"), path.join(path.dirname(tests), "remote-isolated.test.ts")];
  const text = await readFile(source, "utf8");
  const exported = [...text.matchAll(/^export\s+(?:async\s+)?[a-z]+\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!).sort();
  assert.equal(exported.length, [...text.matchAll(/^export\b/gm)].length, "every export of the checkpoint is one this test can name");
  assert.deepEqual(exported, ["CHECKPOINT_LIMITS", "CHECKPOINT_MARK_HEADER", "CHECKPOINT_OUTCOMES", "Checkpoint", "CheckpointNote", "CheckpointOptions", "CheckpointOutcome", "CheckpointRefused", "certificateFor", "openCheckpoint"]);
  // No code or configuration anywhere so much as spells its name: hidden directories, and files named like its
  // tests, included. (Only what git keeps and what is installed are left out.)
  let files = 0;
  for (const file of await readdir(root, { recursive: true })) {
    const parts = file.split(path.sep);
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|sh)$/.test(file) || parts.includes("node_modules") || parts[0] === ".git") continue;
    files += 1;
    const full = path.join(root, file);
    if (full !== source && full !== tests && !beside.includes(full)) assert.doesNotMatch(await readFile(full, "utf8"), /checkpoint/i, `${file} refers to the checkpoint`);
  }
  // The browser that is to stand behind it speaks of it and is handed its socket's path, and does not use it:
  // only that part's tests open one.
  for (const file of beside.slice(0, 2)) assert.doesNotMatch(await readFile(file, "utf8"), /\bimport\b[^;]*checkpoint|\brequire\([^)]*checkpoint|["'`][^"'`\n]*checkpoint[^"'`\n]*\.[cm]?[jt]s["'`]|["'`]\.{1,2}\/[^"'`\n]*checkpoint|openCheckpoint|CHECKPOINT_/i, `${path.basename(file)} uses the checkpoint`);
  assert.ok(files > 20);
  // It writes nothing and prints nothing. By its text: the one thing it does to a file is restrict its socket.
  assert.doesNotMatch(text, /console|process\.std|writeFile|appendFile|createWriteStream|\bimport\(/);
  assert.deepEqual([...text.matchAll(/from "(node:[a-z/]+)"/g)].map((match) => match[1]).sort(), ["node:crypto", "node:fs/promises", "node:http", "node:https", "node:net", "node:tls"]);
  assert.match(text, /^import \{ chmod \} from "node:fs\/promises";$/m);
});
