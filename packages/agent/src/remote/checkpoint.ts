/**
 * The network checkpoint: a forwarding proxy the engine owns, through which a
 * check's browser is to reach the application. Design:
 * docs/design/NETWORK-CHECKPOINT.md. Research behind it:
 * docs/research/rpai-33-network-boundary/.
 *
 * NOT USED BY ANY RUN, AND NOT BY THE CHECK RUNNER. Nothing here is called
 * when a run starts, is carried out or is reported, and no verdict depends on
 * it. A test holds that so.
 *
 * One rule: **nothing reaches the application unless the engine released
 * it.** The engine holds every request of the page before it is sent, and
 * marks the ones it lets go with a secret made for this one checkpoint. The
 * checkpoint forwards a request only if it bears that mark, to an origin on
 * its list, and takes the mark off first. Everything else is refused, and
 * counted: what a page sends as it is left, what a popup, a service worker or
 * a socket sends, what the browser sends by itself.
 *
 * For an `https` origin the checkpoint ends the browser's connection with a
 * certificate of its own, under a key made for this one checkpoint and held
 * only in memory, and opens its own connection to the application, whose
 * certificate it verifies itself. The browser is told to accept that one key
 * (by its pin, `keyPin`); it is never put in a trust store. Under the pin
 * the browser accepts any certificate with that key, whatever name is on it:
 * the key is the checkpoint's alone, so that is the same thing.
 *
 * What it keeps, in memory and nowhere else: a count of how requests were
 * dealt with, and for each request that it could read, the method, the
 * origin (one from its list, or the word `other`) and the path without its
 * query. **No query, no header, no body and no cookie is kept, and nothing at
 * all is written or printed.** A path can itself carry something secret (a
 * reset link): whoever reads the notes must treat a path as such, and as
 * text a page chose.
 *
 * It is one part of a boundary, not the boundary. A browser can send what
 * does not go through any proxy (measured: WebRTC). That is closed by the
 * operating system, not here: see the design note.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { chmod } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import tls from "node:tls";

/** The header that carries the mark from the engine to the checkpoint. It goes no further. */
export const CHECKPOINT_MARK_HEADER = "x-releaseproof-released";

export const CHECKPOINT_LIMITS = Object.freeze({
  /** The most origins a checkpoint serves. */
  origins: 8,
  /** How long the application may take to begin its answer, and how long a connection may say nothing. */
  upstreamMs: 30_000,
  /** How long one connection of the browser's may last, whatever is said on it. */
  connectionMs: 10 * 60_000,
  /** The most connections the browser may have open to the checkpoint at once. */
  connections: 256,
  /** How long a certificate made here is good for. A checkpoint lives for one check. */
  certificateMs: 24 * 60 * 60 * 1000,
  /** The most that is noted one by one. Beyond it the counts go on and the notes do not. */
  notes: 2_000,
  /** The longest path that is kept. */
  path: 512,
});

/** How a request was dealt with. A fixed list: a note never holds free text of the checkpoint's own. */
export const CHECKPOINT_OUTCOMES = [
  /** It bore the mark, was for an origin on the list, and was sent to the application, which may have acted on it. */
  "forwarded",
  /** It did not bear the mark. The application has not seen it. */
  "refused-unmarked",
  /** It was for an origin that is not on the list. */
  "refused-origin",
  /** A socket was asked for (`Upgrade`). None is let through. */
  "refused-upgrade",
  /** It was not a request a browser makes of a proxy, or named one origin and asked another. */
  "refused-malformed",
  /**
   * The application could not be reached, its certificate did not verify, it did not answer in time, or it
   * answered with what is not an answer. If the request had been sent by then, it is also counted as forwarded.
   */
  "upstream-failed",
] as const;
export type CheckpointOutcome = (typeof CHECKPOINT_OUTCOMES)[number];

/**
 * One request, as the checkpoint keeps it. `origin` is one from the list, or `other`. `path` has no query;
 * `query` says only whether there was one. The path is text a page chose and may hold something secret.
 */
export type CheckpointNote = { outcome: CheckpointOutcome; method: string; origin: string; path: string; query: boolean };

export type CheckpointOptions = {
  /** The origins a check may reach: `https://name` or `http://name:port`, exactly as a browser spells them. */
  origins: readonly string[];
  /** Where to listen: a port on the loopback address (0 for any), or the path of a socket. Default: any port. */
  listen?: { port: number } | { path: string };
  /** Authorities to verify applications against, in place of the system's. For tests with certificates made there. */
  upstreamCa?: string | Buffer | (string | Buffer)[];
  /** Where a name is, in place of asking. For tests: the names they use are nowhere. */
  upstreamAddress?: (origin: string) => { host: string; port: number } | undefined;
  /** Shorter times than `CHECKPOINT_LIMITS`, for tests that wait for them. Never longer. */
  shorter?: { upstreamMs?: number; connectionMs?: number };
};

export type Checkpoint = {
  /** Where the browser is to send everything: `http://127.0.0.1:port`, or undefined when listening on a socket. */
  readonly url: string | undefined;
  /** The mark. Whoever holds it can have a request forwarded: it is for the engine alone, and never for a page. */
  readonly mark: string;
  /** The key the browser is to accept: the SHA-256 of the checkpoint's public key, in base64. */
  readonly keyPin: string;
  /** Requests dealt with so far, in the order they were dealt with, up to the limit of notes. */
  notes(): readonly CheckpointNote[];
  /** How many times each outcome has come about. These go on when the notes are full. */
  counts(): Readonly<Record<CheckpointOutcome, number>>;
  /** Ends every connection, the application's side included, and lets go of the key and the mark. */
  close(): Promise<void>;
};

export class CheckpointRefused extends Error {}

/** A name a certificate is made for: labels of letters, digits and inner hyphens, and not an address. */
const NAME = /^(?=.{1,253}$)(?!\d+(\.\d+){3}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** An origin as a browser spells it, or a reason it is not one. */
function originOf(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CheckpointRefused("an origin is not an address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CheckpointRefused("an origin is neither http nor https");
  if (url.origin !== text || url.username !== "" || url.password !== "") throw new CheckpointRefused("an origin is not spelled as a browser spells it");
  if (url.port === "0") throw new CheckpointRefused("an origin has no port 0");
  // A name, or for http a plain address as tests and local applications have. No address in brackets, no trailing dot.
  const plainAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
  if (!NAME.test(url.hostname) && !(url.protocol === "http:" && plainAddress)) throw new CheckpointRefused("an origin's name is not one the checkpoint serves");
  return url.origin;
}

const REFUSAL = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
/** What is said to a proxy or about one connection, and is not passed on; and whatever a `Connection` header names. */
const hopByHop = (headers: http.IncomingHttpHeaders, more: string[]): string[] => [
  ...more,
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
  ...String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== ""),
];

/**
 * Opens a checkpoint for one check. Throws `CheckpointRefused` if the origins
 * are not usable; nothing is listened on then.
 */
export async function openCheckpoint(options: CheckpointOptions): Promise<Checkpoint> {
  if (options.origins.length === 0 || options.origins.length > CHECKPOINT_LIMITS.origins) throw new CheckpointRefused("between one and eight origins");
  const origins = new Set(options.origins.map(originOf));
  if (origins.size !== options.origins.length) throw new CheckpointRefused("an origin is listed twice");
  const upstreamMs = Math.min(options.shorter?.upstreamMs ?? CHECKPOINT_LIMITS.upstreamMs, CHECKPOINT_LIMITS.upstreamMs);
  const connectionMs = Math.min(options.shorter?.connectionMs ?? CHECKPOINT_LIMITS.connectionMs, CHECKPOINT_LIMITS.connectionMs);

  // Made here, kept here: the key the browser's connections are ended with, and the mark.
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const keyPin = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64");
  let mark: Buffer | undefined = Buffer.from(randomBytes(32).toString("hex"));
  // What the browser's connections are ended with, made now for every https origin: one that cannot be made is refused here.
  let ending: Map<string, tls.SecureContext> | undefined = new Map();
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol === "https:" && !ending.has(url.hostname)) ending.set(url.hostname, tls.createSecureContext({ key: key.export({ type: "pkcs8", format: "pem" }), cert: pem(certificateFor(url.hostname, key, CHECKPOINT_LIMITS.certificateMs)), minVersion: "TLSv1.2" }));
  }
  const kept: CheckpointNote[] = [];
  const counted = Object.fromEntries(CHECKPOINT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<CheckpointOutcome, number>;
  let closed = false;
  // Every connection the checkpoint has, to the browser and to applications, so that closing ends them all.
  const open = new Set<{ destroy(): unknown }>();
  const hold = <T extends { destroy(): unknown; once(event: "close", listener: () => void): unknown }>(thing: T): T => {
    open.add(thing);
    thing.once("close", () => open.delete(thing));
    return thing;
  };

  const note = (outcome: CheckpointOutcome, method: string, origin: string, target: string) => {
    if (closed) return;
    counted[outcome] += 1;
    if (kept.length >= CHECKPOINT_LIMITS.notes) return;
    const at = target.indexOf("?");
    const path = at === -1 ? target : target.slice(0, at);
    // The path only, and not all of a long one. An origin that is not on the list is not kept as it was given:
    // it is text of the asker's choosing. A method or a path that is not plain text is not kept as it came.
    kept.push(Object.freeze({ outcome, method: /^[A-Z]{1,16}$/.test(method) ? method : "?", origin: origins.has(origin) ? origin : "other", path: /^[\x21-\x7e]*$/.test(path) ? path.slice(0, CHECKPOINT_LIMITS.path) : "?", query: at !== -1 }));
  };

  const marked = (request: http.IncomingMessage): boolean => {
    const given = request.headers[CHECKPOINT_MARK_HEADER];
    if (typeof given !== "string" || mark === undefined) return false;
    const bytes = Buffer.from(given);
    return bytes.length === mark.length && timingSafeEqual(bytes, mark);
  };

  const refuse = (response: http.ServerResponse, status = 403) => {
    if (response.headersSent) return void response.destroy();
    response.writeHead(status, { connection: "close", "content-length": "0" });
    response.end();
  };

  /** Sends a released request to the application and its answer back, as they are. Nothing of either is kept. */
  const forward = (origin: string, request: http.IncomingMessage, response: http.ServerResponse, target: string) => {
    const url = new URL(origin);
    const secure = url.protocol === "https:";
    const where = options.upstreamAddress?.(origin) ?? { host: url.hostname, port: url.port === "" ? (secure ? 443 : 80) : Number(url.port) };
    const method = request.method ?? "?";
    const headers: http.OutgoingHttpHeaders = { ...request.headers };
    // The mark goes no further; neither does what is said to a proxy and not to the application.
    for (const name of hopByHop(request.headers, [CHECKPOINT_MARK_HEADER, "proxy-authorization"])) delete headers[name];
    headers.host = url.host;
    let settled = false;
    const failed = () => {
      if (settled) return;
      settled = true;
      note("upstream-failed", method, origin, target);
      out.destroy();
      refuse(response, 502);
    };
    const send = secure ? https.request : http.request;
    const out = hold(send({ host: where.host, port: where.port, path: target, method, headers, agent: false, timeout: upstreamMs, ...(secure ? { servername: url.hostname, ca: options.upstreamCa, rejectUnauthorized: true, minVersion: "TLSv1.2" as const } : {}) }));
    // From the moment the connection stands (verified, for https) the application may have the request.
    out.on("socket", (socket) =>
      socket.once(secure ? "secureConnect" : "connect", () => {
        note("forwarded", method, origin, target);
      }),
    );
    out.on("response", (answer) => {
      if (settled) return void answer.destroy();
      try {
        const status = answer.statusCode ?? 0;
        // An answer is a final one. Anything else is the application not answering.
        if (!Number.isInteger(status) || status < 200 || status > 599) return void failed();
        const back = { ...answer.headers };
        for (const name of hopByHop(answer.headers, ["proxy-authenticate"])) delete back[name];
        settled = true;
        response.writeHead(status, back);
        answer.on("error", () => response.destroy());
        answer.pipe(response);
      } catch {
        settled = false;
        failed();
      }
    });
    // A change of protocol, or an end with no answer, is not an answer either.
    out.on("upgrade", (_answer, socket) => (socket.destroy(), failed()));
    out.on("timeout", failed);
    out.on("error", failed);
    out.on("close", () => {
      if (!settled) failed();
    });
    request.on("error", () => out.destroy());
    response.on("close", () => out.destroy());
    request.pipe(out);
  };

  /** A request for `origin`, read from the browser: forwarded if it is released, refused if not. */
  const deal = (origin: string, request: http.IncomingMessage, response: http.ServerResponse, target: string) => {
    const method = request.method ?? "?";
    request.on("error", () => response.destroy());
    response.on("error", () => response.destroy());
    if (closed) return void (request.resume(), refuse(response));
    if (!target.startsWith("/")) return void (note("refused-malformed", method, origin, "/"), request.resume(), refuse(response, 400));
    if (!origins.has(origin)) return void (note("refused-origin", method, origin, target), request.resume(), refuse(response));
    // The name the request gives for itself is the one it was sent to, or it is not forwarded under either.
    if (request.headers.host !== new URL(origin).host) return void (note("refused-malformed", method, origin, target), request.resume(), refuse(response, 400));
    if (!marked(request)) return void (note("refused-unmarked", method, origin, target), request.resume(), refuse(response));
    try {
      forward(origin, request, response, target);
    } catch {
      note("upstream-failed", method, origin, target);
      request.resume();
      refuse(response, 502);
    }
  };

  // What the browser says inside a connection the checkpoint has ended for it: requests for one https origin.
  const tunnelled = new WeakMap<net.Socket, string>();
  const inner = http.createServer((request, response) => {
    const origin = tunnelled.get(request.socket);
    if (origin === undefined) return void (request.resume(), refuse(response, 400));
    deal(origin, request, response, request.url ?? "");
  });
  inner.on("upgrade", (request, socket) => {
    socket.on("error", () => socket.destroy());
    const target = request.url ?? "/";
    note("refused-upgrade", request.method ?? "?", tunnelled.get(request.socket) ?? "other", target.startsWith("/") ? target : "/");
    socket.end(REFUSAL);
  });
  inner.on("clientError", (_error, socket) => socket.destroy());

  // What the browser says to the proxy itself: a request for an http origin, or a tunnel to an https one.
  const outer = http.createServer((request, response) => {
    let url: URL | undefined;
    try {
      url = /^http:\/\//i.test(request.url ?? "") ? new URL(request.url!) : undefined;
    } catch {
      url = undefined;
    }
    if (url === undefined) return void (note("refused-malformed", request.method ?? "?", "other", "/"), request.resume(), refuse(response, 400));
    deal(url.origin, request, response, `${url.pathname}${url.search}`);
  });
  outer.maxConnections = CHECKPOINT_LIMITS.connections;
  outer.on("connection", (socket) => {
    hold(socket);
    // However little is said on it and however slowly, a connection ends.
    const lifetime = setTimeout(() => socket.destroy(), connectionMs);
    socket.once("close", () => clearTimeout(lifetime));
  });
  outer.on("upgrade", (request, socket) => {
    socket.on("error", () => socket.destroy());
    note("refused-upgrade", request.method ?? "?", "other", "/");
    socket.end(REFUSAL);
  });
  outer.on("clientError", (_error, socket) => socket.destroy());
  outer.on("connect", (request, socket: net.Socket) => {
    socket.on("error", () => socket.destroy());
    try {
      const asked = /^([a-z0-9.-]+):(\d{1,5})$/.exec(request.url ?? "");
      const origin = asked ? `https://${asked[1]}${asked[2] === "443" ? "" : `:${asked[2]}`}` : "other";
      const context = asked ? ending?.get(asked[1]!) : undefined;
      if (closed || !asked || !origins.has(origin) || context === undefined) {
        note(asked ? "refused-origin" : "refused-malformed", "CONNECT", origin, "/");
        return void socket.end(REFUSAL);
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const ended = hold(new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] }));
      ended.on("error", () => ended.destroy());
      ended.setTimeout(upstreamMs, () => ended.destroy());
      tunnelled.set(ended, origin);
      inner.emit("connection", ended);
    } catch {
      socket.destroy();
    }
  });

  const listen = options.listen ?? { port: 0 };
  await new Promise<void>((resolve, reject) => {
    outer.once("error", reject);
    if ("path" in listen) outer.listen(listen.path, resolve);
    else outer.listen(listen.port, "127.0.0.1", resolve);
  });
  // A socket on the file system is for whoever started the checkpoint, and nobody else.
  if ("path" in listen) await chmod(listen.path, 0o600);
  const address = outer.address();

  return {
    url: address !== null && typeof address === "object" ? `http://127.0.0.1:${address.port}` : undefined,
    get mark() {
      if (mark === undefined) throw new CheckpointRefused("the checkpoint is closed");
      return mark.toString();
    },
    keyPin,
    notes: () => kept.slice(),
    counts: () => Object.freeze({ ...counted }),
    close: async () => {
      closed = true;
      mark = undefined;
      ending = undefined;
      await new Promise<void>((resolve) => {
        outer.close(() => resolve());
        outer.closeAllConnections();
        inner.closeAllConnections();
        for (const thing of [...open]) thing.destroy();
      });
    },
  };
}

// ---- a certificate, made here ----------------------------------------------------
//
// One self-signed certificate per name, all under the checkpoint's one key. The browser does not accept it by its
// signature or its name but by the key's pin, so no authority exists that could sign for anything else. Written
// out by hand (a few dozen lines of DER) so that the engine takes on no library and calls no program to make it.

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const oid = (...bytes: number[]) => der(0x06, Buffer.from(bytes));
const ECDSA_WITH_SHA256 = der(0x30, oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
/** A time as a certificate writes it: two digits of the year up to 2049, four from 2050. */
const time = (date: Date) => {
  const digits = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${digits.slice(2)}Z`)) : der(0x18, Buffer.from(`${digits}Z`));
};

/** A certificate for one name under one key, good from five minutes ago for `forMs`. DER. */
export function certificateFor(name: string, key: KeyObject, forMs: number, now = new Date()): Buffer {
  if (!NAME.test(name)) throw new CheckpointRefused("not a name a certificate is made for");
  const subject = der(0x30, der(0x31, der(0x30, oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(name)))));
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  // The one name it is good for, for a server, and not an authority.
  const extensions = der(
    0xa3,
    der(
      0x30,
      der(0x30, oid(0x55, 0x1d, 0x11), der(0x04, der(0x30, der(0x82, Buffer.from(name))))),
      der(0x30, oid(0x55, 0x1d, 0x13), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
      der(0x30, oid(0x55, 0x1d, 0x25), der(0x04, der(0x30, oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)))),
    ),
  );
  const body = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, serial),
    ECDSA_WITH_SHA256,
    subject,
    der(0x30, time(new Date(now.getTime() - 5 * 60_000)), time(new Date(now.getTime() + forMs))),
    subject,
    createPublicKey(key).export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", body, { key, dsaEncoding: "der" });
  return der(0x30, body, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0x00]), signature));
}

const pem = (certificate: Buffer) => `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
