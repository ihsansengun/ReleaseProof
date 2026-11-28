// RPAI-33: a browser that can reach nothing but the network checkpoint. Nothing here is used by a run or by the
// check runner, and a test below holds a tripwire on that. Applications are made here; no model is involved.
//
// Whether a network namespace can be made depends on the machine. Where it can, these tests show the browser
// cannot get out. Where it cannot, they show that no browser is started, and say so.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// Where the tests are run to show isolation and for nothing else, not being able to make a namespace is a failure
// and not a reason to pass over them; and the namespace is to be the kind that has no rights over the machine.
const required = process.env.RELEASEPROOF_REQUIRE_ISOLATION === "1";
test("where isolation is to be shown, it can be: a namespace can be made, as an ordinary user's own", { skip: required ? false : "not asked for here" }, () => {
  assert.ok(can, "this machine does not let a network namespace be made, and these tests were run to show isolation");
  assert.ok(namespaceCommand()!.includes("--user"), "the namespace would be made with rights over the machine");
  assert.notEqual(process.getuid?.(), 0, "these tests are not to be run as the administrator");
});
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

  test("a path with anything in it is only a path; and there is one way of making a namespace, not two", async () => {
    // A path that a shell would take for more than a path, if it were handed over carelessly.
    // (No slash can be in a name, so what it would run leaves its mark wherever it runs: here.)
    const awkward = temporary("rp-door-");
    const marker = path.join(process.cwd(), "rp-ran");
    const door = path.join(mkdtempSync(path.join(awkward, "a' b $(touch rp-ran) `touch rp-ran`; touch rp-ran #")), "c.sock");
    const forThis = await openCheckpoint({ origins: [origin], listen: { path: door } });
    try {
      const one = await launchIsolatedBrowser({ checkpointSocket: door, keyPin: forThis.keyPin });
      try {
        const context = await one.browser.newContext();
        const here = await context.newPage();
        const session = await context.newCDPSession(here);
        session.on("Fetch.requestPaused", (event) => void session.send("Fetch.continueRequest", { requestId: event.requestId, headers: Object.entries({ ...event.request.headers, [CHECKPOINT_MARK_HEADER]: forThis.mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}));
        await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        assert.equal((await here.goto(`${origin}/page`))?.status(), 200);
      } finally {
        await one.close();
      }
      assert.equal(existsSync(marker), false, "part of a path was run as a command");
      // The namespace is made as a user namespace's own administrator. Where the machine allows only the other
      // way (as its own administrator, from where a process could step back out), none is made.
      assert.deepEqual(namespaceCommand(), ["unshare", "--user", "--map-root-user", "--net"]);
      const real = which("unshare");
      const otherWayOnly = temporary("rp-only-");
      writeFileSync(path.join(otherWayOnly, "unshare"), `#!/bin/sh\ncase " $* " in *" --user "*) exit 1;; esac\nexec ${real} "$@"\n`);
      chmodSync(path.join(otherWayOnly, "unshare"), 0o755);
      const path0 = process.env.PATH;
      process.env.PATH = [otherWayOnly, ...(path0 ?? "").split(":")].join(":");
      try {
        assert.equal(namespaceCommand(), undefined);
        await assert.rejects(launchIsolatedBrowser({ checkpointSocket: door, keyPin: forThis.keyPin }), (error: unknown) => error instanceof IsolationRefused && error.reason === "namespace-refused");
      } finally {
        process.env.PATH = path0;
      }
    } finally {
      await forThis.close().catch(() => {});
    }
  });

  test("a socket path as long as one can be is used; one byte longer is refused", async () => {
    // The longest path is 107 bytes. One of 108 would be cut short without a word by what opens it, and lead to
    // whatever is at the shortened path: so it is refused, though a socket is really there.
    const base = temporary("rp-len-");
    const padded = (total: number) => path.join(base, "s".repeat(total - Buffer.byteLength(base) - 1));
    const [fits, tooLong] = [padded(107), padded(108)];
    assert.deepEqual([Buffer.byteLength(fits), Buffer.byteLength(tooLong)], [107, 108]);
    const forThis = await openCheckpoint({ origins: [origin], listen: { path: fits } });
    // The one too long is opened by a short name from its own directory, so that it is really at the long path.
    const long = net.createServer((socket) => socket.destroy());
    const before = process.cwd();
    process.chdir(base);
    try {
      await new Promise<void>((resolve) => long.listen(path.basename(tooLong), resolve));
    } finally {
      process.chdir(before);
    }
    try {
      assert.ok(existsSync(tooLong));
      const one = await launchIsolatedBrowser({ checkpointSocket: fits, keyPin: forThis.keyPin });
      await one.close();
      await assert.rejects(launchIsolatedBrowser({ checkpointSocket: tooLong, keyPin: forThis.keyPin }), (error: unknown) => error instanceof IsolationRefused && error.reason === "door-not-opened");
    } finally {
      await forThis.close().catch(() => {});
      await new Promise<void>((resolve) => long.close(() => resolve()));
    }
  });

  test("a browser that stops dead is given up on in time, and nothing of it is left", async () => {
    const inNamespace = (namespace: string) => readdirSync("/proc").filter((entry) => { try { return /^\d+$/.test(entry) && readlinkSync(`/proc/${entry}/ns/net`) === namespace; } catch { return false; } });
    const namespaces = () => new Set(readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map((entry) => { try { return readlinkSync(`/proc/${entry}/ns/net`); } catch { return ""; } }));
    const door = await listeningSocket();
    const [directories, running] = [isolatedDirectories(), browsers()];

    // Stopped dead after it has started: every process in its namespace, the browser's helpers and its crash
    // reporters included. Ending it is to take a set time and leave nothing.
    const one = await launchIsolatedBrowser({ checkpointSocket: door.path, keyPin: `${"A".repeat(43)}=` });
    const stopped = inNamespace(one.namespace);
    assert.ok(stopped.length >= 3, `only ${stopped.length} processes were found in the browser's namespace`);
    for (const pid of stopped) process.kill(Number(pid), "SIGSTOP");
    const began = Date.now();
    await one.close();
    assert.ok(Date.now() - began < 15_000, `ending a stopped browser took ${Date.now() - began} ms`);
    await pause(300);
    assert.deepEqual(inNamespace(one.namespace), [], "something of a stopped browser was left");

    // Stopped dead as it starts: what answers to the tool's name makes a real namespace and starts everything as
    // asked, but for the browser, in whose place it puts a program that stops itself the moment it is started.
    // The launch is to end in a refusal, in time, with nothing left running in that namespace.
    const real = which("unshare");
    const freezing = temporary("rp-freeze-");
    writeFileSync(path.join(freezing, "stops"), "#!/bin/sh\nkill -STOP $$\n");
    chmodSync(path.join(freezing, "stops"), 0o755);
    writeFileSync(
      path.join(freezing, "unshare"),
      `#!/bin/sh
case " $* " in *" true "*) exec ${real} "$@";; esac
for argument in "$@"; do
  shift
  case "$argument" in */chrome) set -- "$@" "${path.join(freezing, "stops")}";; *) set -- "$@" "$argument";; esac
done
exec ${real} "$@"
`,
    );
    chmodSync(path.join(freezing, "unshare"), 0o755);
    const path0 = process.env.PATH;
    const before = namespaces();
    process.env.PATH = [freezing, ...(path0 ?? "").split(":")].join(":");
    const started = Date.now();
    try {
      await assert.rejects(launchIsolatedBrowser({ checkpointSocket: door.path, keyPin: `${"A".repeat(43)}=`, shorter: { startMs: 3_000 } }), IsolationRefused);
    } finally {
      process.env.PATH = path0;
    }
    assert.ok(Date.now() - started < 25_000, `refusing a browser that stopped as it started took ${Date.now() - started} ms`);
    await pause(500);
    assert.deepEqual([...namespaces()].filter((found) => !before.has(found)), [], "a namespace with something in it was left");
    assert.equal(browsers(), running, "a browser was left running");
    assert.equal(isolatedDirectories(), directories, "something written was left behind");
    await door.close();
  });

  test("a browser is ended once: what later bears its namespace's name is another's, and is left alone", async () => {
    // The kernel gives the name of a namespace that is gone to the next one made, within a fraction of a second.
    // Something unrelated is started again and again until it has been given the name the browser's namespace
    // had; ending the browser a second time must not touch it.
    const door = await listeningSocket();
    const one = await launchIsolatedBrowser({ checkpointSocket: door.path, keyPin: `${"A".repeat(43)}=` });
    const name = one.namespace;
    // While the browser lives, the engine has hold of the namespace itself, so that its name cannot become
    // another's before everything in it has been ended; afterwards it has let go.
    const holds = () => readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === name; } catch { return false; } }).length;
    assert.equal(holds(), 1, "the engine has no hold on the browser's namespace");
    const first = one.close();
    assert.equal(one.close(), first, "a second ending is a second piece of work");
    await first;
    assert.equal(holds(), 0, "the engine kept hold of a namespace it had ended");
    let bystander: ReturnType<typeof spawn> | undefined;
    for (let tries = 0; tries < 40 && bystander === undefined; tries += 1) {
      const candidate = spawn("unshare", ["--user", "--map-root-user", "--net", "sleep", "60"], { stdio: "ignore" });
      await pause(150);
      const got = candidate.pid === undefined ? "" : (() => { try { return readlinkSync(`/proc/${candidate.pid}/ns/net`); } catch { return ""; } })();
      if (got === name) bystander = candidate;
      else (candidate.kill("SIGKILL"), await pause(50));
    }
    try {
      // Whatever the kernel did with the name: a second ending signals nothing at all.
      const signal = process.kill;
      let signalled = 0;
      process.kill = ((...given: Parameters<typeof process.kill>) => ((signalled += 1), signal.apply(process, given))) as typeof process.kill;
      try {
        await one.close();
        await one.close();
      } finally {
        process.kill = signal;
      }
      assert.equal(signalled, 0, "ending a browser a second time signalled a process");
      await pause(300);
      // Where the name did come round again (it nearly always does), its new bearer is still running.
      if (bystander !== undefined) assert.equal(bystander.exitCode ?? bystander.signalCode, null, "ending a browser again ended something that had been given its namespace's name");
      else console.log("# the kernel did not hand the name out again in 40 tries: the second ending was made, with nothing to harm");
    } finally {
      bystander?.kill("SIGKILL");
      await door.close();
    }
  });

  test("when the engine is gone, so is the browser", async () => {
    // An engine of its own, which starts an isolated browser, says where it is, and is then killed outright.
    const door = await listeningSocket();
    const module = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "remote", "isolated.ts");
    const script = `const { launchIsolatedBrowser } = await import(${JSON.stringify(module)}); const one = await launchIsolatedBrowser({ checkpointSocket: ${JSON.stringify(door.path)}, keyPin: "${"A".repeat(43)}=" }); process.stdout.write(one.namespace + "\\n"); setInterval(() => {}, 1000);`;
    const engine = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const namespace = await new Promise<string>((resolve, reject) => {
      let text = "";
      engine.stdout.on("data", (chunk) => ((text += chunk), text.includes("\n") && resolve(text.trim())));
      engine.once("exit", () => reject(new Error("the engine ended before it started a browser")));
      setTimeout(() => reject(new Error("no browser within 30 s")), 30_000).unref();
    });
    assert.match(namespace, /^net:\[\d+\]$/);
    const inIt = () => readdirSync("/proc").filter((entry) => { try { return /^\d+$/.test(entry) && readlinkSync(`/proc/${entry}/ns/net`) === namespace; } catch { return false; } }).length;
    assert.ok(inIt() > 0, "nothing was in the namespace to begin with");
    engine.kill("SIGKILL");
    let left = inIt();
    for (let waited = 0; waited < 5_000 && left > 0; waited += 100) (await pause(100), (left = inIt()));
    assert.equal(left, 0, "something went on running in the namespace after the engine was killed");
    await door.close();
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
    // A path longer than a socket's can be is cut short without a word by what opens it, and would lead to
    // whatever is at the shortened path. A socket really at the long path (reached by a short name) is refused.
    const deep = path.join(temporary("rp-long-"), "d".repeat(100));
    mkdirSync(deep);
    const before = process.cwd();
    process.chdir(deep);
    const long = net.createServer();
    try {
      await new Promise<void>((resolve) => long.listen("s.sock", resolve));
    } finally {
      process.chdir(before);
    }
    const longPath = path.join(deep, "s.sock");
    assert.ok(Buffer.byteLength(longPath) > 107 && existsSync(longPath), "the socket is there, at a path too long to be opened by");
    await refused(["door-not-opened"], { checkpointSocket: longPath });
    await new Promise<void>((resolve) => long.close(() => resolve()));
    // What is handed over is not even something with a pin and a path in it.
    for (const nothing of [undefined, null, "text", 7]) await assert.rejects(launchIsolatedBrowser(nothing as never), IsolationRefused, String(nothing));
    // Or something that cannot be read at all, or reads differently the second time: read once, and a refusal.
    const throwing = [{ get keyPin(): string { throw new RangeError("no"); }, checkpointSocket: door.path }, { keyPin: PIN, get checkpointSocket(): string { throw "no"; } }, new Proxy({}, { get() { throw new Error("no"); } })];
    for (const one of throwing) await assert.rejects(launchIsolatedBrowser(one as never), IsolationRefused);
    let reads = 0;
    const changing = { checkpointSocket: door.path, get keyPin() { reads += 1; return reads === 1 ? PIN : "x --no-proxy-server"; } };
    await launchIsolatedBrowser(changing as never).then((one) => one.close(), () => {});
    assert.equal(reads, 1, "the pin was read again after it was looked at");
  });

  test("a tool that says it raised the loopback and did not is not believed", { skip: can ? false : "needs a namespace" }, async () => {
    const lying = temporary("rp-lying-");
    writeFileSync(path.join(lying, "ip"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(lying, "ip"), 0o755);
    await withPath([lying, ...(path0 ?? "").split(":")], async () => refused(["loopback-not-raised"]));
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
