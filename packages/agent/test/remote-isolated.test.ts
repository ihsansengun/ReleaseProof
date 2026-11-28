// RPAI-33: a browser that can reach nothing but the network checkpoint. Nothing here is used by a run or by the
// check runner, and a test below holds a tripwire on that. Applications are made here; no model is involved.
//
// Whether a network namespace can be made depends on the machine. Where it can, these tests show the browser
// cannot get out. Where it cannot, they show that no browser is started, and say so.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// Everything written while these tests run goes under one directory of their own, so that what is counted there
// is theirs and not other work on the machine; it is removed at the end.
const ownTemporary = mkdtempSync(path.join(tmpdir(), "rpt-"));
process.env.TMPDIR = ownTemporary;
const made: string[] = [ownTemporary];
const temporary = (name: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), name));
  made.push(directory);
  return directory;
};
after(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })));
/** A socket on the file system that something listens on: what a launcher is to be handed. */
async function listeningSocket(directory = temporary("rp-door-"), name = "checkpoint.sock") {
  const server = net.createServer((socket) => socket.destroy());
  const file = path.join(directory, name);
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return { path: file, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
/** Processes started from this one, however far down, whose command line has this in it. Other work on the machine is not counted. */
const descendants = (marked: string) => {
  const parents = new Map<number, number>();
  const commands = new Map<number, string>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      commands.set(Number(entry), readFileSync(`/proc/${entry}/cmdline`, "utf8"));
    } catch {}
  }
  const mine = (pid: number): boolean => {
    for (let at = parents.get(pid), hops = 0; at !== undefined && at > 1 && hops < 64; at = parents.get(at), hops += 1) if (at === process.pid) return true;
    return false;
  };
  return [...commands].filter(([pid, command]) => command.includes(marked) && mine(pid)).length;
};
/** Browsers started from here that are running. */
const browsers = () => descendants("--remote-debugging-pipe");
/** Where a tool is, looked for along the path as it was when the tests began (a shell would answer for its own built-ins). */
const which = (tool: string) => (process.env.PATH ?? "").split(":").map((directory) => path.join(directory, tool)).find((file) => existsSync(file))!;
/** The programs that run inside namespaces made from here. */
const leftovers = () => String(descendants("isolated-inside.mjs"));
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

  test("either way a namespace can be made here, the browser is in one; and a path with anything in it is only a path", async () => {
    // A path that a shell would take for more than a path, if it were handed over carelessly.
    const awkward = temporary("rp-door-");
    // (No slash can be in a name, so what it would run leaves its mark wherever it runs: here.)
    const marker = path.join(process.cwd(), "rp-ran");
    const door = path.join(mkdtempSync(path.join(awkward, "a' b $(touch rp-ran) `touch rp-ran`; touch rp-ran #")), "c.sock");
    const forThis = await openCheckpoint({ origins: [origin], listen: { path: door } });
    const real = which("unshare");
    const only = (wanted: boolean) => {
      // The real tool, refusing one of the two ways it can be asked.
      const directory = temporary("rp-only-");
      writeFileSync(path.join(directory, "unshare"), `#!/bin/sh\ncase " $* " in *" --user "*) user=1;; *) user=0;; esac\n[ "$user" = "${wanted ? 1 : 0}" ] || exit 1\nexec ${real} "$@"\n`);
      chmodSync(path.join(directory, "unshare"), 0o755);
      return [directory, ...(process.env.PATH ?? "").split(":")].join(":");
    };
    const path0 = process.env.PATH;
    const tried: string[] = [];
    try {
      for (const wanted of [true, false]) {
        process.env.PATH = only(wanted);
        const command = namespaceCommand();
        if (command === undefined) continue;
        assert.equal(command.includes("--user"), wanted);
        tried.push(wanted ? "user namespace" : "as the process is");
        const one = await launchIsolatedBrowser({ checkpointSocket: door, keyPin: forThis.keyPin });
        try {
          assert.notEqual(one.namespace, readlinkSync("/proc/self/ns/net"));
          const context = await one.browser.newContext();
          const here = await context.newPage();
          const session = await context.newCDPSession(here);
          session.on("Fetch.requestPaused", (event) => void session.send("Fetch.continueRequest", { requestId: event.requestId, headers: Object.entries({ ...event.request.headers, [CHECKPOINT_MARK_HEADER]: forThis.mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}));
          await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
          assert.equal((await here.goto(`${origin}/page`))?.status(), 200);
          const fresh = await canary();
          for (const at of fresh.at) await here.evaluate(escapes(at));
          await pause(300);
          fresh.close();
          assert.deepEqual(fresh.counted, { datagrams: 0, connections: 0 }, `out of the namespace made ${tried.at(-1)}`);
        } finally {
          await one.close();
        }
      }
    } finally {
      process.env.PATH = path0;
    }
    assert.ok(tried.length >= 1);
    // Where both ways are open, the one that leaves the browser without rights over the machine's network is taken.
    if (tried.length === 2) assert.ok(namespaceCommand()!.includes("--user"));
    assert.equal(existsSync(marker), false, "part of a path was run as a command");
    await forThis.close();
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
  let door: Awaited<ReturnType<typeof listeningSocket>>;
  before(async () => void (door = await listeningSocket()));
  after(() => door.close());
  const PIN = `${"A".repeat(43)}=`;
  const refused = async (reason: readonly string[], options: { checkpointSocket?: unknown; keyPin?: unknown } = {}) => {
    const [processes, directories, running] = [leftovers(), isolatedDirectories(), browsers()];
    await assert.rejects(launchIsolatedBrowser({ checkpointSocket: door.path, keyPin: PIN, ...options } as Parameters<typeof launchIsolatedBrowser>[0]), (error: unknown) => {
      assert.ok(error instanceof IsolationRefused, String(error));
      assert.ok(reason.includes(error.reason) && (ISOLATION_REFUSALS as readonly string[]).includes(error.reason), `refused as ${error.reason}, not as ${reason.join(" or ")}`);
      return true;
    });
    await pause(300);
    assert.equal(leftovers(), processes, "a process was left behind");
    assert.equal(browsers(), running, "a browser was left running");
    assert.equal(isolatedDirectories(), directories, "something written was left behind");
  };
  /** Something that answers to the tool's name, makes no namespace, and does this in place of what it was asked to. */
  const impostor = (body: string) => {
    const directory = temporary("rp-fake-");
    // $1.. after "--": node, the inside program, the report's path, the port, the socket, the browser, its arguments.
    writeFileSync(path.join(directory, "unshare"), `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\n[ "$#" -eq 0 ] && exit 0\n${body}\n`);
    chmodSync(path.join(directory, "unshare"), 0o755);
    return [directory, ...(path0 ?? "").split(":")];
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
    await withPath(impostor('exec "$@"'), async () => refused(["other-interfaces", "not-isolated", "door-not-opened", "loopback-not-raised"]));
  });

  test("what is written down is not believed: the browser's own processes are looked at", async () => {
    // The worst an impostor can do short of making a namespace: it writes down exactly what the engine hopes to
    // read, and starts the browser where the engine is. The browser's processes are found in the engine's own
    // namespace, and it is ended.
    const forged = (written: string) => impostor(`report="$3"; shift 5; printf '%s' '${written}' > "$report"; exec "$@"`);
    await withPath(forged('{"namespace":"net:[1]","interfaces":["lo"]}'), async () => refused(["not-isolated"]));
    // The same with the name of the engine's own namespace, with an interface too many, and with a name that is none.
    await withPath(forged(`{"namespace":"${readlinkSync("/proc/self/ns/net")}","interfaces":["lo"]}`), async () => refused(["not-isolated"]));
    await withPath(forged('{"namespace":"net:[1]","interfaces":["lo","eth0"]}'), async () => refused(["not-isolated"]));
    await withPath(forged('{"namespace":"somewhere","interfaces":["lo"]}'), async () => refused(["not-isolated"]));
    // What is written down is nothing, or not what is expected: a refusal like any other, and the browser is ended.
    for (const written of ["", "null", "[]", "{", '"text"', "{}"]) await withPath(forged(written), async () => refused(["not-isolated", "browser-not-started"]));
  });

  test("a tool that does not come back is given up on, in time", { skip: can ? false : "needs a namespace" }, async () => {
    const slow = temporary("rp-slow-");
    writeFileSync(path.join(slow, "ip"), "#!/bin/sh\nsleep 120\n");
    chmodSync(path.join(slow, "ip"), 0o755);
    for (const tool of ["unshare", "true", "sleep"]) symlinkSync(which(tool), path.join(slow, tool));
    const began = Date.now();
    await withPath([slow], async () => refused(["loopback-not-raised"]));
    assert.ok(Date.now() - began < 20_000, `took ${Date.now() - began} ms`);
  });

  test("the door leads to a socket that is there, named in full", async () => {
    const plain = path.join(temporary("rp-file-"), "not-a-socket");
    writeFileSync(plain, "");
    for (const checkpointSocket of ["/nonexistent/checkpoint.sock", "", "3128", "checkpoint.sock", plain, `${door.path}\0x`, undefined, 3128]) await refused(["door-not-opened"], { checkpointSocket });
  });

  test("inside the namespace the loopback cannot be raised", { skip: can ? false : "needs a namespace" }, async () => {
    // Only the tool that makes the namespace is on the path: neither of the two that raise the loopback.
    const bare = temporary("rp-bare-");
    symlinkSync(which("unshare"), path.join(bare, "unshare"));
    symlinkSync(which("true"), path.join(bare, "true"));
    await withPath([bare], async () => refused(["loopback-not-raised"]));
  });

  test("a socket that nothing listens on any more is no door", { skip: can ? false : "needs a namespace" }, async () => {
    const gone = await listeningSocket();
    await gone.close();
    writeFileSync(gone.path, "");
    await refused(["door-not-opened"], { checkpointSocket: gone.path });
    // One that is a socket and has nobody behind it (whoever listened was killed): found out from inside the
    // namespace, by going through the door once, before the browser is started.
    const dead = path.join(temporary("rp-dead-"), "dead.sock");
    const listener = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(dead)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => listener.stdout.once("data", () => resolve()));
    listener.kill("SIGKILL");
    await new Promise<void>((resolve) => listener.once("exit", () => resolve()));
    assert.ok(existsSync(dead));
    await refused(["door-not-opened"], { checkpointSocket: dead });
  });

  test("a pin that is not a pin is not handed to a browser", async () => {
    for (const keyPin of ["", "not a pin", `${PIN} --no-proxy-server`, `${PIN},${"B".repeat(43)}=`, `${PIN}\n`, undefined, 7]) await refused(["browser-not-started"], { keyPin });
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
