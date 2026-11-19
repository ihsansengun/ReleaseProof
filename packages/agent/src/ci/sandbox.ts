import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Manifest } from "../schema.ts";

const run = promisify(execFile);
// Every docker call passes an argument array: nothing from a manifest is ever
// interpreted by a shell on the host.
const docker = (args: string[], timeout = 120_000) => run("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024 });

export const IMAGE = "releaseproof-app";
const CONTAINER = "releaseproof-app";
const NETWORK = "releaseproof-net";
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
  // An internal network has no gateway to the outside world.
  await docker(["network", "create", "--internal", NETWORK]);
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

/** Asks the running container what it can see and reach. Run on every CI run, not assumed. */
export async function probeIsolation(start: Start): Promise<Isolation> {
  const exec = (args: string[]) =>
    docker(["exec", CONTAINER, ...args], 30_000).then(
      (r) => r.stdout.trim(),
      (e: { stdout?: string }) => (e.stdout ?? "").trim(),
    );
  const configuration = await inspectConfiguration(start);
  const environment = (await exec(["env"]))
    .split("\n")
    .map((line) => line.split("=")[0]!)
    .filter(Boolean)
    .sort();
  const allowed = new Set([...BASE_ENV, ...Object.keys(start.env), ...(start.commitEnv ? [start.commitEnv] : [])]);
  const unexpectedEnvironment = environment.filter((name) => !allowed.has(name));
  const network = await exec([
    "node", "-e",
    "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('REACHABLE'),()=>console.log('blocked'))",
  ]);
  const filesystem = await exec(["sh", "-c", "touch /app/.probe 2>/dev/null && echo WRITABLE || echo read-only"]);
  const user = await exec(["id", "-u"]);
  const outboundNetwork = network === "blocked" ? "blocked" : "REACHABLE";
  const rootFilesystem = filesystem === "read-only" ? "read-only" : "WRITABLE";
  return {
    environment,
    unexpectedEnvironment,
    configuration,
    outboundNetwork,
    rootFilesystem,
    user,
    ok: configuration.length === 0 && unexpectedEnvironment.length === 0 && outboundNetwork === "blocked" && rootFilesystem === "read-only" && user !== "0",
  };
}

/**
 * Checks the running container's settings as the container engine reports
 * them. The in-container probe runs programs from the untrusted image, which
 * could lie; this does not. Returns the problems found, empty if none.
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
    const network = JSON.parse((await docker(["network", "inspect", NETWORK])).stdout)[0];
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
}
