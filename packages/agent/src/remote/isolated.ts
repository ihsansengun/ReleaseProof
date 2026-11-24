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
 * November 2026). The engine does not take the namespace on trust either:
 * what was made is written down from inside it before the browser starts,
 * and read here. A namespace that is the engine's own, or has any interface
 * but the loopback, is refused and the browser is ended.
 *
 * What this does not do: it does not confine the browser's files or its
 * processes, only its network. See the design note.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
  /** The namespace the browser is in, as the kernel names it. Never the engine's own. */
  readonly namespace: string;
  /** Ends the browser and everything in its namespace, and removes what was written for it. */
  close(): Promise<void>;
};

/** The port of the door on the namespace's own loopback. Nothing outside the namespace can see it. */
const DOOR_PORT = 3128;
const INSIDE = fileURLToPath(new URL("./isolated-inside.mjs", import.meta.url));

/** How a namespace can be made here: as this process is, or as a user namespace's own root. Undefined: not at all. */
export function namespaceCommand(): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  for (const command of [["unshare", "--net"], ["unshare", "--user", "--map-root-user", "--net"]]) {
    if (spawnSync(command[0]!, [...command.slice(1), "true"], { stdio: "ignore", timeout: 10_000 }).status === 0) return command;
  }
  return undefined;
}

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Starts a browser in a network namespace of its own, whose only way out is
 * the checkpoint. Throws `IsolationRefused`, having started nothing or ended
 * what it started, if that cannot be done and shown.
 */
export async function launchIsolatedBrowser(options: IsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (process.platform !== "linux") throw new IsolationRefused("not-linux");
  const command = namespaceCommand();
  if (command === undefined) throw new IsolationRefused("namespace-refused");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(options.keyPin)) throw new IsolationRefused("browser-not-started");
  const own = await readlink("/proc/self/ns/net").catch(() => undefined);
  if (own === undefined) throw new IsolationRefused("not-isolated");

  const directory = await mkdtemp(path.join(tmpdir(), "rp-isolated-"));
  const report = path.join(directory, "report.json");
  const starter = path.join(directory, "browser");
  // What Playwright starts in place of the browser: the namespace, then the part that runs inside it, then the browser.
  await writeFile(starter, `#!/bin/sh\nexec ${[...command, "--", process.execPath, INSIDE, report, String(DOOR_PORT), options.checkpointSocket, chromium.executablePath()].map(quoted).join(" ")} "$@"\n`, { mode: 0o700 });
  const remove = () => rm(directory, { recursive: true, force: true });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath: starter,
      proxy: { server: `http://127.0.0.1:${DOOR_PORT}`, bypass: "<-loopback>" },
      // The browser resolves no name itself, and accepts the checkpoint's key and no other in place of verification.
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--ignore-certificate-errors-spki-list=${options.keyPin}`],
    });
  } catch {
    const said = await readFile(report, "utf8").then((text) => JSON.parse(text) as { refused?: string }, () => undefined);
    await remove();
    throw new IsolationRefused((ISOLATION_REFUSALS as readonly string[]).includes(said?.refused ?? "") ? (said!.refused as IsolationRefusal) : said?.refused === "interfaces-not-read" ? "other-interfaces" : "browser-not-started");
  }
  // Not taken on trust: what was written down inside, before the browser was started.
  const found = await readFile(report, "utf8").then((text) => JSON.parse(text) as { namespace?: unknown; interfaces?: unknown }, () => undefined);
  const isolated = found !== undefined && typeof found.namespace === "string" && /^net:\[\d+\]$/.test(found.namespace) && found.namespace !== own && Array.isArray(found.interfaces) && found.interfaces.length === 1 && found.interfaces[0] === "lo";
  if (!isolated) {
    await browser.close().catch(() => {});
    await remove();
    throw new IsolationRefused(found === undefined ? "browser-not-started" : "not-isolated");
  }
  const started = browser;
  return {
    browser: started,
    namespace: found.namespace as string,
    close: async () => {
      await started.close().catch(() => {});
      await remove();
    },
  };
}
