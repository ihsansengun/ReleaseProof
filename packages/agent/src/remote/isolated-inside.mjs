// Runs INSIDE the network namespace made for one browser, started by `isolated.ts` through `unshare`. Plain
// JavaScript, run by node itself. NOT USED BY ANY RUN: see isolated.ts.
//
// It raises the loopback interface, makes sure that is the only interface there is, opens the one door (a
// listener on the loopback that hands every connection to the checkpoint's socket outside), goes through the
// door once itself, writes down what it found for the engine to read, and only then starts the browser, as its
// own child. The browser ends when this program does what it can to end it: on a signal, and when the engine
// that started it is gone. Whatever it cannot do, it says in one word and stops: the browser is not started.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import net from "node:net";

const [reportPath, doorPort, checkpointSocket, browserPath, ...browserArguments] = process.argv.slice(2);
const stop = (why) => {
  try {
    writeFileSync(reportPath, JSON.stringify({ refused: why }));
  } catch {}
  process.exit(70);
};

/** The interfaces of this namespace, and whether each is up, as the kernel lists them for this process. */
const interfaces = () =>
  readFileSync("/proc/net/dev", "utf8")
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim())
    .filter((name) => name !== "");

// Raise the loopback: with the tool for it, or by asking the kernel directly where there is none.
const RAISE = 'import fcntl,socket,struct\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\nf=struct.unpack("16sH14s",fcntl.ioctl(s,0x8913,struct.pack("16sH14s",b"lo",0,b"")))[1]\nfcntl.ioctl(s,0x8914,struct.pack("16sH14s",b"lo",f|1,b""))\n';
const raised = [
  ["ip", ["link", "set", "lo", "up"]],
  ["python3", ["-I", "-c", RAISE]],
  // A tool that does not come back is a tool that failed.
].some(([tool, tooled]) => spawnSync(tool, tooled, { stdio: "ignore", timeout: 5_000, killSignal: "SIGKILL" }).status === 0);
if (!raised) stop("loopback-not-raised");
let listed;
try {
  listed = interfaces();
} catch {
  stop("interfaces-not-read");
}
// Nothing but the loopback. Anything else is a way out that nobody looked at.
if (listed.length !== 1 || listed[0] !== "lo") stop("other-interfaces");

const door = net.createServer((inside) => {
  const outside = net.connect({ path: checkpointSocket });
  inside.on("error", () => outside.destroy());
  outside.on("error", () => inside.destroy());
  inside.pipe(outside);
  outside.pipe(inside);
});
door.on("error", () => stop("door-not-opened"));
/** One connection, made and ended. Resolves to whether it stood within three seconds. */
const reaches = (where) =>
  new Promise((resolve) => {
    const socket = net.connect(where);
    const done = (stood) => (socket.destroy(), clearTimeout(waiting), resolve(stood));
    const waiting = setTimeout(() => done(false), 3_000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

door.listen(Number(doorPort), "127.0.0.1", async () => {
  // Not taken for done because a tool said so: the loopback carries a connection, and the checkpoint is there.
  if (!(await reaches({ host: "127.0.0.1", port: Number(doorPort) }))) stop("loopback-not-raised");
  if (!(await reaches({ path: checkpointSocket }))) stop("door-not-opened");
  let namespace;
  try {
    namespace = readlinkSync("/proc/self/ns/net");
  } catch {
    stop("namespace-not-read");
  }
  writeFileSync(reportPath, JSON.stringify({ namespace, interfaces: listed }));
  // The browser, with what it was given to speak to the engine through (descriptors 3 and 4) passed on as they are.
  const browser = spawn(browserPath, browserArguments, { stdio: ["ignore", "inherit", "inherit", 3, 4] });
  browser.on("error", () => process.exit(71));
  browser.on("exit", (code, signal) => process.exit(signal ? 72 : (code ?? 0)));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => browser.kill("SIGKILL"));
  // When whoever started this is gone, so is the browser: nothing is left to run by itself in the namespace.
  const startedBy = process.ppid;
  setInterval(() => {
    if (process.ppid !== startedBy) browser.kill("SIGKILL");
  }, 500).unref();
});
