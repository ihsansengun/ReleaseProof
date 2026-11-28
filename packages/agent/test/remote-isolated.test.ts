// RPAI-33: a browser that can reach nothing but the network checkpoint. Nothing here is used by a run or by the
// check runner, and a test below holds a tripwire on that. Applications are made here; no model is involved.
//
// Whether a network namespace can be made depends on the machine. Where it can, these tests show the browser
// cannot get out. Where it cannot, they show that no browser is started, and say so.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { CHECKPOINT_MARK_HEADER, openCheckpoint, type Checkpoint } from "../src/remote/checkpoint.ts";
import { ISOLATION_REFUSALS, IsolationRefused, launchIsolatedBrowser, namespaceCommand, type IsolatedBrowser } from "../src/remote/isolated.ts";

const can = namespaceCommand() !== undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const temporary = (name: string) => mkdtempSync(path.join(tmpdir(), name));
/** Where a tool is, looked for along the path as it was when the tests began (a shell would answer for its own built-ins). */
const which = (tool: string) => (process.env.PATH ?? "").split(":").map((directory) => path.join(directory, tool)).find((file) => existsSync(file))!;
/** The processes that belong to isolated browsers started from here, by what they were started with. */
const leftovers = () =>
  String(
    readdirSync("/proc").filter((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      try {
        return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes("isolated-inside.mjs");
      } catch {
        return false;
      }
    }).length,
  );
const isolatedDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith("rp-isolated-")).length;

/** Something outside the namespace that counts whatever arrives at it without going through the checkpoint. */
async function canary() {
  const addresses = ["127.0.0.1", ...Object.values(networkInterfaces()).flat().filter((address) => address && address.family === "IPv4" && !address.internal).map((address) => address!.address)];
  const counted = { datagrams: 0, connections: 0 };
  const closers: (() => void)[] = [];
  const at: { address: string; udp: number; tcp: number }[] = [];
  for (const address of addresses) {
    const udp = dgram.createSocket("udp4");
    udp.on("message", () => (counted.datagrams += 1));
    await new Promise<void>((resolve) => udp.bind(0, address, resolve));
    const tcp = net.createServer((socket) => ((counted.connections += 1), socket.destroy()));
    await new Promise<void>((resolve) => tcp.listen(0, address, resolve));
    at.push({ address, udp: udp.address().port, tcp: (tcp.address() as net.AddressInfo).port });
    closers.push(() => (udp.close(), tcp.close()));
  }
  return { at, counted, close: () => closers.forEach((close) => close()) };
}
/** Everything a page can try in order to send something that does not go through a proxy. */
const escapes = (at: { address: string; udp: number; tcp: number }) => `(async () => {
  const tried = [];
  for (const urls of ["stun:${at.address}:${at.udp}", "turn:${at.address}:${at.udp}", "turn:${at.address}:${at.tcp}?transport=tcp"]) {
    try {
      const peer = new RTCPeerConnection({ iceServers: [{ urls, username: "u", credential: "p" }] });
      peer.createDataChannel("x");
      await peer.setLocalDescription(await peer.createOffer());
      tried.push("webrtc");
    } catch (error) { tried.push("webrtc refused") }
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try { const transport = new WebTransport("https://${at.address}:${at.udp}/"); transport.ready.catch(() => {}); transport.closed.catch(() => {}); tried.push("webtransport") } catch (error) { tried.push("webtransport refused") }
  for (const url of ["http://${at.address}:${at.tcp}/x", "https://${at.address}:${at.tcp}/x"]) await fetch(url, { mode: "no-cors" }).then(() => tried.push("fetch answered"), () => tried.push("fetch failed"));
  await new Promise((resolve) => { const socket = new WebSocket("ws://${at.address}:${at.tcp}/"); socket.onopen = socket.onerror = resolve; setTimeout(resolve, 800) });
  await new Promise((resolve) => { const image = new Image(); image.onload = image.onerror = resolve; image.src = "http://${at.address}:${at.tcp}/p.png"; setTimeout(resolve, 800) });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return tried.join(",");
})()`;

describe("a browser in a network namespace of its own", { skip: can ? false : "this machine does not let a network namespace be made; see the refusal test" }, () => {
  let app: http.Server, origin: string, checkpoint: Checkpoint, isolated: IsolatedBrowser, page: Page, outside: Awaited<ReturnType<typeof canary>>;
  const seen: string[] = [];
  before(async () => {
    app = http.createServer((request, response) => (seen.push(`${request.method} ${request.url}`), response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><p id="which">through the door</p>`)));
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(app.address() as net.AddressInfo).port}`;
    const door = path.join(temporary("rp-door-"), "checkpoint.sock");
    checkpoint = await openCheckpoint({ origins: [origin], listen: { path: door } });
    outside = await canary();
    isolated = await launchIsolatedBrowser({ checkpointSocket: door, keyPin: checkpoint.keyPin });
    const context = await isolated.browser.newContext();
    page = await context.newPage();
    const session = await context.newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => void session.send("Fetch.continueRequest", { requestId: event.requestId, headers: event.request.url.startsWith(origin) ? Object.entries({ ...event.request.headers, [CHECKPOINT_MARK_HEADER]: checkpoint.mark }).map(([name, value]) => ({ name, value: String(value) })) : undefined }).catch(() => {}));
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  });
  after(async () => {
    await isolated?.close();
    await checkpoint?.close();
    outside?.close();
    await new Promise<void>((resolve) => (app.closeAllConnections(), app.close(() => resolve())));
  });

  test("it is in a namespace that is not the engine's, and reaches the application through the checkpoint", async () => {
    assert.match(isolated.namespace, /^net:\[\d+\]$/);
    assert.notEqual(isolated.namespace, readlinkSync("/proc/self/ns/net"));
    const answered = await page.goto(`${origin}/page`);
    assert.equal(answered?.status(), 200);
    assert.equal(await page.locator("#which").textContent(), "through the door");
    assert.ok(seen.includes("GET /page"));
    assert.equal(checkpoint.counts().forwarded >= 1, true);
  });

  test("nothing a page tries reaches anything outside without going through the checkpoint", async () => {
    await page.goto(`${origin}/page`);
    const before = { ...checkpoint.counts() };
    const reached = seen.length;
    for (const at of outside.at) {
      const tried = String(await page.evaluate(escapes(at)));
      assert.match(tried, /webrtc/, `nothing was tried against ${at.address}: ${tried}`);
    }
    await pause(500);
    assert.deepEqual(outside.counted, { datagrams: 0, connections: 0 }, "something left the namespace by another way than the door");
    // What went to the door was refused there: those addresses are not on the list.
    assert.ok(checkpoint.counts()["refused-origin"] > before["refused-origin"]);
    // The application heard of nothing but what the page itself is (the browser asks for its icon).
    assert.deepEqual(seen.slice(reached).filter((line) => line !== "GET /favicon.ico"), []);
  });

  test("the same attempts from a browser that is not isolated do arrive: the looking works", async () => {
    const ordinary: Browser = await chromium.launch();
    try {
      const ordinaryPage = await ordinary.newPage();
      await ordinaryPage.goto(`${origin}/plain`);
      const fresh = await canary();
      for (const at of fresh.at) await ordinaryPage.evaluate(escapes(at));
      await pause(500);
      fresh.close();
      assert.ok(fresh.counted.datagrams > 0, "no packet arrived even from an ordinary browser: this test would show nothing");
      assert.ok(fresh.counted.connections > 0);
    } finally {
      await ordinary.close();
    }
  });

  test("ending it ends everything in its namespace and leaves nothing written", async () => {
    const door = path.join(temporary("rp-door-"), "checkpoint.sock");
    const forThis = await openCheckpoint({ origins: [origin], listen: { path: door } });
    const [processesBefore, directoriesBefore] = [leftovers(), isolatedDirectories()];
    const second = await launchIsolatedBrowser({ checkpointSocket: door, keyPin: forThis.keyPin });
    assert.notEqual(second.namespace, isolated.namespace, "two browsers in one namespace");
    assert.equal(Number(leftovers()), Number(processesBefore) + 1);
    await second.close();
    await pause(300);
    assert.equal(leftovers(), processesBefore);
    assert.equal(isolatedDirectories(), directoriesBefore);
    await second.close();
    await forThis.close();
  });
});

describe("when the browser cannot be isolated, none is started", () => {
  const path0 = process.env.PATH;
  const withPath = async (entries: string[], body: () => Promise<void>) => {
    process.env.PATH = entries.join(":");
    try {
      await body();
    } finally {
      process.env.PATH = path0;
    }
  };
  const refused = async (reason: readonly string[]) => {
    const [processes, directories] = [leftovers(), isolatedDirectories()];
    await assert.rejects(launchIsolatedBrowser({ checkpointSocket: "/nonexistent/checkpoint.sock", keyPin: "A".repeat(43) + "=" }), (error: unknown) => {
      assert.ok(error instanceof IsolationRefused, String(error));
      assert.ok(reason.includes(error.reason) && (ISOLATION_REFUSALS as readonly string[]).includes(error.reason), `refused as ${error.reason}, not as ${reason.join(" or ")}`);
      return true;
    });
    await pause(200);
    assert.equal(leftovers(), processes, "a process was left behind");
    assert.equal(isolatedDirectories(), directories, "something written was left behind");
  };

  test("the machine does not let a namespace be made", async () => {
    // As on a machine without the tool, or without the right: nothing on the path makes one.
    const empty = temporary("rp-none-");
    await withPath([empty], async () => {
      assert.equal(namespaceCommand(), undefined);
      await refused(["namespace-refused"]);
    });
    // A tool that is there and says no.
    const refusing = temporary("rp-no-");
    writeFileSync(path.join(refusing, "unshare"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(refusing, "unshare"), 0o755);
    await withPath([refusing], async () => refused(["namespace-refused"]));
    if (!can) console.log("# this machine does not let a network namespace be made: only the refusals were tested here");
  });

  test("a namespace that is not one: the engine's own network, under another name", async () => {
    // Something that answers to the tool's name and makes nothing: what runs inside finds the machine's own
    // interfaces, or the engine finds its own namespace written down; or, without the right to touch the
    // machine's own loopback, it cannot go through the motion of raising it. Every one of these is a refusal,
    // and no browser is left running.
    const fake = temporary("rp-fake-");
    writeFileSync(path.join(fake, "unshare"), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\n[ "$#" -eq 0 ] && exit 0\nexec "$@"\n');
    chmodSync(path.join(fake, "unshare"), 0o755);
    await withPath([fake, ...(path0 ?? "").split(":")], async () => refused(["other-interfaces", "not-isolated", "door-not-opened", "loopback-not-raised"]));
  });

  test("inside the namespace the loopback cannot be raised", { skip: can ? false : "needs a namespace" }, async () => {
    // Only the tool that makes the namespace is on the path: neither of the two that raise the loopback.
    const bare = temporary("rp-bare-");
    symlinkSync(which("unshare"), path.join(bare, "unshare"));
    symlinkSync(which("true"), path.join(bare, "true"));
    await withPath([bare], async () => refused(["loopback-not-raised"]));
  });

  test("a pin that is not a pin is not handed to a browser", async () => {
    for (const keyPin of ["", "not a pin", `${"A".repeat(43)}= --no-proxy-server`, `${"A".repeat(43)}=,${"B".repeat(43)}=`]) {
      await assert.rejects(launchIsolatedBrowser({ checkpointSocket: "/nonexistent/checkpoint.sock", keyPin }), IsolationRefused, JSON.stringify(keyPin));
    }
  });
});

test("the isolated browser is used by nothing: not by a run, and not by the check runner", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const remote = path.join(root, "packages", "agent", "src", "remote");
  const own = [path.join(remote, "isolated.ts"), path.join(remote, "isolated-inside.mjs"), path.join(root, "packages", "agent", "test", "remote-isolated.test.ts"), path.join(root, "packages", "agent", "test", "remote-checkpoint.test.ts")];
  assert.ok(own.every((file) => existsSync(file)));
  let files = 0;
  for (const file of await readdir(root, { recursive: true })) {
    const parts = file.split(path.sep);
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|sh)$/.test(file) || parts.includes("node_modules") || parts[0] === ".git") continue;
    files += 1;
    const full = path.join(root, file);
    if (!own.includes(full)) assert.doesNotMatch(await readFile(full, "utf8"), /isolated(-inside)?\.(ts|mjs)|launchIsolatedBrowser|IsolationRefused|namespaceCommand/, `${file} refers to the isolated browser`);
  }
  assert.ok(files > 20);
});
