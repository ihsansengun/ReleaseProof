/**
 * A browser that can reach nothing but the network checkpoint. Design:
 * docs/design/NETWORK-CHECKPOINT.md, "The browser's side".
 *
 * NOT USED BY ANY RUN, AND NOT BY THE CHECK RUNNER. Nothing here is called
 * when a run starts, is carried out or is reported, and no verdict depends on
 * it. A test would notice an ordinary use of it; it is a tripwire, not a lock.
 *
 * A browser can send what goes through no proxy (measured: WebRTC sends
 * packets straight to an address a page chooses, whatever the browser is told
 * about proxies). So the browser is not asked to stay in: it is started in a
 * network namespace of its own, which the operating system makes with one
 * interface, the loopback, and nothing else. On that loopback one door
 * listens and hands every connection to the checkpoint's socket outside.
 * There is no other way out to find.
 *
 * **If that cannot be done, no browser is started** (owner's rule, 23
 * November 2026). The engine does not take the namespace on trust either.
 * What was made is written down from inside it before the browser starts,
 * and read here; and then the browser is asked for its processes and the
 * kernel is asked, from outside, which namespace each one is in. Unless
 * every one of them is in a namespace other than the engine's, with the
 * loopback and nothing else, the browser is ended and the answer is a
 * refusal.
 *
 * What this does not do: it does not confine the browser's files or its
 * processes, only its network. See the design note.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

/** Why no isolated browser was started. A fixed list. */
export const ISOLATION_REFUSALS = [
  /** Network namespaces are a Linux matter. */
  "not-linux",
  /** The operating system would not make a namespace, with the rights this process has. */
  "namespace-refused",
  /** Inside the namespace the loopback could not be raised: neither tool for it is there. */
  "loopback-not-raised",
  /** Inside the namespace there was an interface besides the loopback, or they could not be listed. */
  "other-interfaces",
  /** The door to the checkpoint could not be opened inside the namespace. */
  "door-not-opened",
  /** The browser did not start, or nothing was written down about its namespace. */
  "browser-not-started",
  /** What was written down does not show a namespace other than the engine's own with only a loopback. */
  "not-isolated",
] as const;
export type IsolationRefusal = (typeof ISOLATION_REFUSALS)[number];

export class IsolationRefused extends Error {
  constructor(readonly reason: IsolationRefusal) {
    super(`no isolated browser: ${reason}`);
  }
}

export type IsolatedBrowserOptions = {
  /** The path of the socket the checkpoint listens on, when it is opened to listen on a path. */
  checkpointSocket: string;
  /** The checkpoint's `keyPin`: the one key the browser accepts in place of a verified certificate. */
  keyPin: string;
};

export type IsolatedBrowser = {
  readonly browser: Browser;
  /** The namespace every process of the browser was found in, as the kernel names it. Never the engine's own. */
  readonly namespace: string;
  /** Ends the browser and everything in its namespace, and removes what was written for it. */
  close(): Promise<void>;
};

/** The port of the door on the namespace's own loopback. Nothing outside the namespace can see it. */
const DOOR_PORT = 3128;
/** How long a browser may take to start. One that takes longer is one that did not start. */
const START_MS = 30_000;
const INSIDE = fileURLToPath(new URL("./isolated-inside.mjs", import.meta.url));

/**
 * How a namespace can be made here. First as a user namespace's own root: what runs inside then has no rights
 * over the machine's own network, and cannot step back into it. Only where that is not allowed, as this process
 * is. Undefined: not at all.
 */
export function namespaceCommand(): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  for (const command of [["unshare", "--user", "--map-root-user", "--net"], ["unshare", "--net"]]) {
    if (spawnSync(command[0]!, [...command.slice(1), "true"], { stdio: "ignore", timeout: 10_000 }).status === 0) return command;
  }
  return undefined;
}

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const namespaceOf = (pid: number | "self") => readlink(`/proc/${pid}/ns/net`).catch(() => undefined);

/**
 * Starts a browser in a network namespace of its own, whose only way out is
 * the checkpoint. Throws `IsolationRefused`, and nothing else, having started
 * nothing or ended what it started, if that cannot be done and shown.
 */
export async function launchIsolatedBrowser(options: IsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (process.platform !== "linux") throw new IsolationRefused("not-linux");
  // What it was handed is looked at first: the same answer on every machine, whatever that machine allows.
  if (typeof options.keyPin !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(options.keyPin)) throw new IsolationRefused("browser-not-started");
  // The door leads to a socket on the file system, named in full, that is there.
  const socket = options.checkpointSocket;
  if (typeof socket !== "string" || !path.isAbsolute(socket) || socket.includes("\0") || !(await stat(socket).then((found) => found.isSocket(), () => false))) throw new IsolationRefused("door-not-opened");
  const command = namespaceCommand();
  if (command === undefined) throw new IsolationRefused("namespace-refused");
  const own = await namespaceOf("self");
  if (own === undefined) throw new IsolationRefused("not-isolated");

  let directory: string | undefined;
  let browser: Browser | undefined;
  const undo = async () => {
    await browser?.close().catch(() => {});
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  try {
    directory = await mkdtemp(path.join(tmpdir(), "rp-isolated-"));
    const report = path.join(directory, "report.json");
    const starter = path.join(directory, "browser");
    // What Playwright starts in place of the browser: the namespace, then the part that runs inside it, then the browser.
    await writeFile(starter, `#!/bin/sh\nexec ${[...command, "--", process.execPath, INSIDE, report, String(DOOR_PORT), socket, chromium.executablePath()].map(quoted).join(" ")} "$@"\n`, { mode: 0o700 });
    /** What was written down inside, if it is something written down. */
    const written = async (): Promise<Record<string, unknown> | undefined> => {
      try {
        const found: unknown = JSON.parse(await readFile(report, "utf8"));
        return typeof found === "object" && found !== null && !Array.isArray(found) ? (found as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    try {
      browser = await chromium.launch({
        executablePath: starter,
        timeout: START_MS,
        proxy: { server: `http://127.0.0.1:${DOOR_PORT}`, bypass: "<-loopback>" },
        // The browser resolves no name itself, and accepts the checkpoint's key and no other in place of verification.
        args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--ignore-certificate-errors-spki-list=${options.keyPin}`],
      });
    } catch {
      const said = (await written())?.refused;
      throw new IsolationRefused((ISOLATION_REFUSALS as readonly unknown[]).includes(said) ? (said as IsolationRefusal) : said === "interfaces-not-read" ? "other-interfaces" : "browser-not-started");
    }
    // What was written down inside, before the browser was started: a namespace other than the engine's, with
    // the loopback and nothing else.
    const found = await written();
    if (found === undefined) throw new IsolationRefused("browser-not-started");
    const { namespace, interfaces } = found;
    if (typeof namespace !== "string" || !/^net:\[\d+\]$/.test(namespace) || namespace === own || !Array.isArray(interfaces) || interfaces.length !== 1 || interfaces[0] !== "lo") throw new IsolationRefused("not-isolated");
    // And not taken on that word alone. The browser is asked for its processes, and the kernel is asked, from
    // here, which namespace each of them is in: every one in the namespace that was written down.
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    await session.detach().catch(() => {});
    const where = await Promise.all(processInfo.map((one) => namespaceOf(one.id)));
    if (where.length === 0 || where.some((one) => one !== namespace)) throw new IsolationRefused("not-isolated");

    const [started, made] = [browser, directory];
    return {
      browser: started,
      namespace,
      close: async () => {
        await started.close().catch(() => {});
        await rm(made, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await undo();
    throw error instanceof IsolationRefused ? error : new IsolationRefused(browser === undefined ? "browser-not-started" : "not-isolated");
  }
}
