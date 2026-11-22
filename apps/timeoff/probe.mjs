// Adversarial test fixture for ReleaseProof's CI sandbox. NOT part of the app.
// Meant to run only inside the sandbox container: it reports what the
// process can see and reach, and pushes against the container's limits.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";

const say = (name, result) => console.log(`PROBE ${name}: ${result}`);

async function reach(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return `REACHED status ${r.status}`;
  } catch (e) {
    return `no (${e.cause?.code ?? e.name})`;
  }
}

function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("CONNECTED");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve("no (timeout)");
    });
    socket.on("error", (e) => resolve(`no (${e.code})`));
  });
}

export async function probe() {
  // Only ever run where the sandbox says it is: a read-only root filesystem.
  try {
    writeFileSync("/app/.sandbox-check", "x");
    say("skipped", "root filesystem is writable, so this is not the sandbox");
    return;
  } catch (e) {
    if (e.code !== "EROFS") {
      say("skipped", `not the sandbox (${e.code})`);
      return;
    }
  }

  const names = Object.keys(process.env).sort();
  say("env names", names.join(" "));
  const sensitive = names.filter((n) => /KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|GITHUB|ACTIONS|RUNNER|AWS|AZURE/i.test(n));
  say("env sensitive-looking", sensitive.length ? sensitive.map((n) => `${n}(${process.env[n].length} chars)`).join(" ") : "none");

  say("internet https://example.com", await reach("https://example.com"));
  say("internet by address http://1.1.1.1", await reach("http://1.1.1.1"));
  say("cloud metadata 169.254.169.254", await reach("http://169.254.169.254/latest/meta-data/"));
  say("azure wireserver 168.63.129.16", await reach("http://168.63.129.16/machine?comp=goalstate"));
  try {
    say("dns github.com", (await lookup("github.com")).address);
  } catch (e) {
    say("dns github.com", `no (${e.code})`);
  }

  // The host side of this container's network, and the default docker bridge.
  let own = "";
  try {
    own = spawnSync("hostname", ["-i"]).stdout.toString().trim();
  } catch {}
  say("own address", own || "unknown");
  const gateways = new Set(["172.17.0.1"]);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(own)) gateways.add(own.replace(/\.\d+$/, ".1"));
  for (const host of gateways) for (const port of [22, 2375]) say(`host ${host}:${port}`, await connect(host, port));
  say("docker socket present", existsSync("/var/run/docker.sock"));

  for (const file of ["/etc/probe-write", "/home/probe-write", "/usr/local/bin/probe-write", "/proc/sys/kernel/hostname", "/tmp/probe-write"]) {
    try {
      writeFileSync(file, "x");
      say(`write ${file}`, "WRITTEN");
    } catch (e) {
      say(`write ${file}`, `no (${e.code})`);
    }
  }
  say("user", `${process.getuid()}:${process.getgid()}`);
  try {
    const caps = readFileSync("/proc/self/status", "utf8").split("\n").filter((l) => /^Cap(Eff|Prm|Bnd)/.test(l));
    say("capabilities", caps.join(" ").replace(/\t/g, ""));
  } catch {}

  // Process limit: start sleepers until refused, then stop them.
  const children = [];
  let refused = "not refused within 400";
  for (let i = 0; i < 400; i++) {
    const child = spawn("sleep", ["20"]);
    const failed = await new Promise((resolve) => {
      child.once("error", (e) => resolve(e.code));
      child.once("spawn", () => resolve(null));
    });
    if (failed) {
      refused = `refused after ${i} (${failed})`;
      break;
    }
    children.push(child);
  }
  for (const child of children) child.kill("SIGKILL");
  say("process limit", refused);

  // Memory limit: a child allocates until something stops it.
  const hog = spawnSync(
    process.execPath,
    ["--max-old-space-size=4096", "-e", "const a=[];for(let i=0;i<64;i++){a.push(Buffer.alloc(64*1024*1024,1));} console.log('allocated 4 GiB')"],
    { timeout: 10000 },
  );
  say("memory limit", hog.signal ? `child killed by ${hog.signal}` : `child exit ${hog.status} ${hog.stdout.toString().trim()}`);

  // Lines a CI runner might treat as commands if it read this log raw.
  console.log("::add-mask::PROBE-MASK-TEST");
  console.log("::error title=injected::PROBE this annotation should not exist");
  console.log("::set-output name=produced::false");
  console.log("##[error]PROBE fake error line");
  console.log("\u001b[31mPROBE ansi\u001b[0m");
  say("done", "ok");
}
