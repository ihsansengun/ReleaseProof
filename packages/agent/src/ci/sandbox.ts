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
    const up = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).then(
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
    outboundNetwork,
    rootFilesystem,
    user,
    ok: unexpectedEnvironment.length === 0 && outboundNetwork === "blocked" && rootFilesystem === "read-only" && user !== "0",
  };
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
