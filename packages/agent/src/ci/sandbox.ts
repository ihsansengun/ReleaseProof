import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hostEnv } from "../hostenv.ts";
import type { Manifest } from "../schema.ts";

const run = promisify(execFile);
// Every docker call passes an argument array: nothing from a manifest is ever
// interpreted by a shell on the host.
// The docker client also gets a minimal environment: it has no use for the
// engine's credentials, and a container's environment is only ever what the
// explicit --env arguments say.
const docker = (args: string[], timeout = 120_000) =>
  run("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024, env: hostEnv(process.env) });

export const IMAGE = "releaseproof-app";
const CONTAINER = "releaseproof-app";
const NETWORK = "releaseproof-net";
// The network's bridge gets a fixed name so a firewall rule can refer to it.
const BRIDGE = "rpsandbox0";
// New connections arriving on the sandbox bridge and addressed to this machine
// are dropped. Replies to connections the engine opened are not "new", so the
// engine can still talk to the application.
const HOST_RULE = ["INPUT", "-i", BRIDGE, "-m", "conntrack", "--ctstate", "NEW,INVALID", "-j", "DROP"];
const USER = "10001";

type Start = NonNullable<Manifest["start"]>;

/** Builds the application image. Install and build commands run inside the build, never on the host. */
export async function buildImage(options: {
  contextDir: string;
  dockerfile: string;
  start: Start;
  sha: string;
}): Promise<void> {
  await docker(
    [
      "build",
      "--file", options.dockerfile,
      "--build-arg", `RP_INSTALL=${options.start.install ?? ""}`,
      "--build-arg", `RP_BUILD=${options.start.build ?? ""}`,
      "--build-arg", `RP_RUN=${options.start.run}`,
      "--label", `releaseproof.sha=${options.sha}`,
      "--tag", IMAGE,
      options.contextDir,
    ],
    15 * 60_000,
  );
}

export type Isolation = {
  /** Names of the variables the application process can see. */
  environment: string[];
  unexpectedEnvironment: string[];
  /** What the container engine says the container was started with. Does not rely on anything inside the image. */
  configuration: string[];
  outboundNetwork: "blocked" | "REACHABLE";
  /** Addresses the trusted-side network test got an answer from. Empty when blocked. */
  reached: string[];
  rootFilesystem: "read-only" | "WRITABLE";
  user: string;
  ok: boolean;
};

const BASE_ENV = ["PATH", "HOSTNAME", "HOME", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "RP_RUN"];

/**
 * Starts the application image with no route out, no way to gain privileges,
 * a read-only filesystem apart from /tmp, and bounded memory, CPU and process
 * count. Its environment holds only what the manifest lists plus the commit.
 */
export async function startSandbox(options: { start: Start; sha: string }): Promise<{ baseUrl: string }> {
  const { start, sha } = options;
  await stopSandbox();
  // An internal network has no gateway to the outside world. Depending on the
  // container engine's version it can still reach this machine's own address
  // on the bridge, so that is closed separately.
  await docker(["network", "create", "--internal", "--opt", `com.docker.network.bridge.name=${BRIDGE}`, NETWORK]);
  const rule = await trusted("iptables", ["-I", HOST_RULE[0]!, "1", ...HOST_RULE.slice(1)]);
  if (!rule.ok) throw new Error(`The sandbox network could not be closed off from this machine: ${rule.out.split("\n")[0]!.slice(0, 160)}`);
  const env = { ...start.env, ...(start.commitEnv ? { [start.commitEnv]: sha } : {}) };
  await docker([
    "run", "--detach", "--name", CONTAINER,
    "--network", NETWORK,
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "1g", "--memory-swap", "1g", "--cpus", "1.5",
    "--user", `${USER}:${USER}`,
    ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    IMAGE,
  ]);
  const { stdout } = await docker([
    "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", CONTAINER,
  ]);
  const address = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error("The sandbox container has no address.");
  const baseUrl = `http://${address}:${start.port}`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000), redirect: "manual" }).then(
      () => true,
      () => false,
    );
    if (up) return { baseUrl };
    if (Date.now() > deadline) {
      const logs = await docker(["logs", "--tail", "30", CONTAINER]).then(
        (r) => r.stdout + r.stderr,
        () => "",
      );
      throw new Error(`The application did not start listening on port ${start.port} within 60 s.\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Runs a program that belongs to the trusted side, with a minimal environment. */
async function trusted(command: string, args: string[], timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const [file, argv] = root ? [command, args] : ["sudo", ["-n", command, ...args]];
  return run(file, argv, { timeout, env: hostEnv(process.env) }).then(
    (r) => ({ ok: true, out: r.stdout.trim() }),
    (e: { stdout?: string; stderr?: string }) => ({ ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() }),
  );
}

/** This machine's addresses as a container might reach them: the sandbox bridge and the default bridge. */
async function hostAddressesFor(): Promise<string[]> {
  const gateway = (name: string) =>
    docker(["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]).then(
      (r) => r.stdout.trim().split(/\s+/).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
      () => [] as string[],
    );
  const sandbox = await gateway(NETWORK);
  return sandbox.length === 0 ? [] : [...sandbox, ...(await gateway("bridge"))];
}

/** Reads the fields of /proc/<pid>/status that say who a process is and what it may do. */
export function processFacts(status: string): { uid: string; capabilities: string; noNewPrivileges: boolean } {
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1]?.trim() ?? "";
  return {
    uid: field("Uid").split(/\s+/)[1] ?? "",
    capabilities: field("CapEff"),
    noNewPrivileges: field("NoNewPrivs") === "1",
  };
}

const NETWORK_PROBE = `
const tries = ["https://example.com", "http://1.1.1.1", "http://169.254.169.254/", "http://168.63.129.16/", ...process.argv.slice(1)];
Promise.all(tries.map((u) => fetch(u, { signal: AbortSignal.timeout(4000), redirect: "manual" }).then(() => u, () => null)))
  .then((r) => console.log(JSON.stringify(r.filter(Boolean))));
`;

/**
 * Checks the sandbox from the trusted side only. Nothing here runs a program
 * from the application image or believes anything the container says:
 *
 *   settings      what the container engine reports it started
 *   process       the kernel's record of the application's main process
 *   network       this engine's own Node, placed in the container's network
 *                 namespace, tries to reach the outside
 *   filesystem    the engine is asked to write into the container's root
 *
 * Any check that cannot be carried out counts as a failure.
 */
export async function probeIsolation(start: Start): Promise<Isolation> {
  const configuration = await inspectConfiguration(start);
  const inspected = await docker(["inspect", CONTAINER]).then(
    (r) => JSON.parse(r.stdout)[0] as { State?: { Pid?: number; Running?: boolean }; Config?: { Env?: string[] } },
    () => ({}) as { State?: { Pid?: number; Running?: boolean }; Config?: { Env?: string[] } },
  );
  const pid = inspected.State?.Running ? (inspected.State.Pid ?? 0) : 0;
  if (!pid) configuration.push("the container's main process could not be identified");

  const environment = (inspected.Config?.Env ?? []).map((entry) => entry.split("=")[0]!).sort();
  const allowed = new Set([...BASE_ENV, ...Object.keys(start.env), ...(start.commitEnv ? [start.commitEnv] : [])]);
  const unexpectedEnvironment = environment.filter((name) => !allowed.has(name));

  // The kernel's view of the process, read on the host.
  const facts = pid ? processFacts(await readFile(`/proc/${pid}/status`, "utf8").catch(() => "")) : { uid: "", capabilities: "", noNewPrivileges: false };
  if (pid && !/^0+$/.test(facts.capabilities)) configuration.push(`the application process holds capabilities (${facts.capabilities || "unreadable"})`);
  if (pid && !facts.noNewPrivileges) configuration.push("the application process may gain privileges");

  // Outbound network, tried with this engine's own Node inside the container's network namespace.
  // "Outside" includes this machine: a listener is opened here for the length
  // of the test, and the probe tries it on every address the container could
  // use for the host (the sandbox bridge and the engine's default bridge).
  let outboundNetwork: Isolation["outboundNetwork"] = "REACHABLE";
  let reached: string[] = [];
  if (pid) {
    const listener = createServer((_request, response) => response.end("host"));
    await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", resolve));
    const port = (listener.address() as AddressInfo).port;
    const hostAddresses = await hostAddressesFor();
    if (hostAddresses.length === 0) configuration.push("this machine's address on the sandbox network could not be determined");
    const attempt = await trusted("nsenter", [
      "--target", String(pid), "--net", process.execPath, "-e", NETWORK_PROBE,
      ...hostAddresses.map((address) => `http://${address}:${port}/`),
    ]);
    listener.close();
    try {
      if (attempt.ok) reached = (JSON.parse(attempt.out) as string[]).map((url) => String(url).slice(0, 60));
      if (attempt.ok && reached.length === 0) outboundNetwork = "blocked";
    } catch {
      // unreadable result: stays REACHABLE, which fails the check
    }
    if (!attempt.ok) configuration.push("the network could not be tested from the trusted side");
  }

  // Root filesystem: ask the engine to put a file there. A read-only root refuses.
  const marker = path.join(tmpdir(), `releaseproof-probe-${process.pid}`);
  await writeFile(marker, "probe");
  const copy = await docker(["cp", marker, `${CONTAINER}:/releaseproof-probe`], 30_000).then(
    () => "WRITABLE" as const,
    (e: { stderr?: string }) => (/read-only/i.test(e.stderr ?? "") ? ("read-only" as const) : ("WRITABLE" as const)),
  );
  await rm(marker, { force: true });
  const rootFilesystem = copy;

  const user = facts.uid;
  return {
    environment,
    unexpectedEnvironment,
    configuration,
    outboundNetwork,
    reached,
    rootFilesystem,
    user,
    ok:
      configuration.length === 0 &&
      unexpectedEnvironment.length === 0 &&
      outboundNetwork === "blocked" &&
      rootFilesystem === "read-only" &&
      user !== "" &&
      user !== "0",
  };
}

/**
 * Checks the running container's settings as the container engine reports
 * them. Returns the problems found, empty if none.
 */
export function configurationProblems(
  inspected: {
    Config?: { Env?: string[]; User?: string };
    HostConfig?: {
      ReadonlyRootfs?: boolean;
      Privileged?: boolean;
      CapDrop?: string[] | null;
      CapAdd?: string[] | null;
      SecurityOpt?: string[] | null;
      NetworkMode?: string;
      Binds?: string[] | null;
      PidsLimit?: number | null;
      Memory?: number;
      PidMode?: string;
      IpcMode?: string;
    };
    Mounts?: { Type?: string; Destination?: string }[];
    NetworkSettings?: { Networks?: Record<string, unknown> };
  },
  network: { Internal?: boolean },
  allowedEnv: Set<string>,
  imageEnv: Set<string>,
): string[] {
  const problems: string[] = [];
  const host = inspected.HostConfig ?? {};
  if (host.ReadonlyRootfs !== true) problems.push("root filesystem is not read-only");
  if (host.Privileged) problems.push("container is privileged");
  if (!(host.CapDrop ?? []).some((c) => c.toUpperCase() === "ALL")) problems.push("capabilities are not all dropped");
  if ((host.CapAdd ?? []).length > 0) problems.push("capabilities were added");
  if (!(host.SecurityOpt ?? []).some((o) => o.startsWith("no-new-privileges"))) problems.push("privilege escalation is not disabled");
  if (host.NetworkMode !== NETWORK) problems.push("container is not on the isolated network");
  const networks = Object.keys(inspected.NetworkSettings?.Networks ?? {});
  if (networks.length !== 1 || networks[0] !== NETWORK) problems.push("container is attached to another network");
  if (network.Internal !== true) problems.push("the network has a route out");
  if ((host.Binds ?? []).length > 0) problems.push("host paths are mounted");
  if ((inspected.Mounts ?? []).some((m) => m.Type !== "tmpfs")) problems.push("a volume or host path is mounted");
  if (!host.PidsLimit || host.PidsLimit <= 0) problems.push("no process limit");
  if (!host.Memory || host.Memory <= 0) problems.push("no memory limit");
  if (host.PidMode === "host" || host.IpcMode === "host") problems.push("host namespaces are shared");
  const user = inspected.Config?.User ?? "";
  if (user === "" || user.split(":")[0] === "0" || user.split(":")[0] === "root") problems.push("container runs as root");
  for (const entry of inspected.Config?.Env ?? []) {
    const name = entry.split("=")[0]!;
    if (!allowedEnv.has(name) && !imageEnv.has(name)) problems.push(`unexpected environment variable ${name}`);
  }
  return problems;
}

async function inspectConfiguration(start: Start): Promise<string[]> {
  try {
    const container = JSON.parse((await docker(["inspect", CONTAINER])).stdout)[0];
    const network = await docker(["network", "inspect", NETWORK]).then(
      (r) => JSON.parse(r.stdout)[0] as { Internal?: boolean },
      () => ({}) as { Internal?: boolean },
    );
    const image = JSON.parse((await docker(["image", "inspect", IMAGE])).stdout)[0];
    const imageEnv = new Set<string>(((image?.Config?.Env ?? []) as string[]).map((e) => e.split("=")[0]!));
    const allowed = new Set([...Object.keys(start.env), ...(start.commitEnv ? [start.commitEnv] : [])]);
    // Variables baked into the image were put there by the build, which never
    // sees a secret; they are reported by name in `environment` all the same.
    return configurationProblems(container, network, allowed, imageEnv);
  } catch (error) {
    return [`container configuration could not be read: ${(error as Error).message.split("\n")[0]!.slice(0, 120)}`];
  }
}

export async function sandboxLogs(lines = 200): Promise<string> {
  return docker(["logs", "--tail", String(lines), CONTAINER]).then(
    (r) => r.stdout + r.stderr,
    () => "",
  );
}

export async function stopSandbox(): Promise<void> {
  await docker(["rm", "--force", CONTAINER]).catch(() => {});
  await docker(["network", "rm", NETWORK]).catch(() => {});
  // Remove every copy of the firewall rule; "-D" fails once none is left.
  for (let i = 0; i < 5 && (await trusted("iptables", ["-D", ...HOST_RULE])).ok; i++);
}
