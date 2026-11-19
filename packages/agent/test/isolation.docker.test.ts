// Integration tests against a real container engine. They need Docker and a
// locally built `releaseproof-app` image, and are skipped where either is
// missing. They start containers; they never touch the network outside.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { IMAGE, probeIsolation, startSandbox, stopSandbox } from "../src/ci/sandbox.ts";
import { browserEnv } from "../src/execute/run.ts";
import { hostEnv, PRIVILEGED } from "../src/hostenv.ts";

const SECRET = "sk-ant-DUMMY-SECRET-must-not-leak-4f1c";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const haveDocker = (() => {
  try {
    docker("image", "inspect", IMAGE);
    return true;
  } catch {
    return false;
  }
})();
const start = { run: "node apps/timeoff/server.mjs", port: 3100, env: { PORT: "3100", TEST_MODE: "1" }, commitEnv: "GIT_SHA" };

/** Every process on this machine whose environment contains the text, by command line. */
function processesHolding(text: string): string[] {
  const found: string[] = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").includes(text)) {
        found.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 80));
      }
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

test("a secret in the engine's environment reaches neither the browser nor anything it starts", async () => {
  process.env.ANTHROPIC_API_KEY = SECRET;
  process.env.GITHUB_TOKEN = SECRET;
  process.env.RP_TEST_PRIVATE_TOKEN = SECRET;
  // Control: the scanner does find the secret in a child that inherits everything.
  const control = spawn("sleep", ["30"]);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(processesHolding(SECRET).some((c) => c.startsWith("sleep")), "control process should hold the secret");
  control.kill();

  assert.ok(Object.keys(browserEnv(process.env)).every((name) => !PRIVILEGED.test(name)));
  const browser = await chromium.launch({ env: browserEnv(process.env) });
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>untrusted page</h1>");
    await new Promise((r) => setTimeout(r, 300));
    const holders = processesHolding(SECRET).filter((c) => /chrom|headless/i.test(c));
    assert.deepEqual(holders, [], "no browser process may hold the secret");
    assert.ok(readdirSync("/proc").some((pid) => {
      try {
        return /chrom|headless/i.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      } catch {
        return false;
      }
    }), "a browser process should be running while we look");
  } finally {
    await browser.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.RP_TEST_PRIVATE_TOKEN;
  }
});

test("a secret in the engine's environment does not reach the application container", { skip: !haveDocker }, async () => {
  process.env.ANTHROPIC_API_KEY = SECRET;
  process.env.GITHUB_TOKEN = SECRET;
  try {
    await startSandbox({ start, sha: "a".repeat(40) });
    const isolation = await probeIsolation(start);
    assert.equal(isolation.ok, true, JSON.stringify(isolation));
    assert.ok(isolation.environment.every((name) => !PRIVILEGED.test(name)), isolation.environment.join(" "));
    // The engine's record of the container, and the kernel's record of every process in it.
    assert.doesNotMatch(docker("inspect", "releaseproof-app"), new RegExp(SECRET));
    const pids = docker("top", "releaseproof-app", "-eo", "pid").split("\n").slice(1).map((p) => p.trim());
    assert.ok(pids.length > 0);
    for (const pid of pids) assert.doesNotMatch(readFileSync(`/proc/${pid}/environ`, "utf8"), new RegExp(SECRET), `pid ${pid}`);
    assert.deepEqual(processesHolding(SECRET).filter((c) => /server\.mjs|docker/.test(c)), []);
  } finally {
    await stopSandbox();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
  }
});

test("the probe catches a weakened sandbox even when the image's own programs lie", { skip: !haveDocker }, async () => {
  // An image whose env, id, sh and node all claim a perfect sandbox.
  const dir = mkdtempSync(path.join(tmpdir(), "rp-liar-"));
  writeFileSync(path.join(dir, "liar"), "#!/bin/dash\necho blocked\n");
  writeFileSync(
    path.join(dir, "Dockerfile"),
    [
      `FROM ${IMAGE}`,
      "USER 0",
      "COPY liar /liar",
      "RUN chmod +x /liar && cp /liar /usr/bin/env && cp /liar /usr/bin/id && cp /liar /usr/bin/touch",
      "CMD [\"/usr/local/bin/node\", \"apps/timeoff/server.mjs\"]",
    ].join("\n"),
  );
  docker("build", "-q", "-t", "releaseproof-liar", dir);
  await stopSandbox();
  try {
    // Started the way a broken or tampered launcher might: default bridge, writable root, root user, a leaked secret.
    docker("run", "--detach", "--name", "releaseproof-app", "--env", "PORT=3100", "--env", "TEST_MODE=1", "--env", `ANTHROPIC_API_KEY=${SECRET}`, "releaseproof-liar");
    await new Promise((r) => setTimeout(r, 1500));
    const isolation = await probeIsolation(start);
    assert.equal(isolation.ok, false);
    assert.equal(isolation.rootFilesystem, "WRITABLE");
    assert.equal(isolation.user, "0");
    assert.deepEqual(isolation.unexpectedEnvironment, ["ANTHROPIC_API_KEY"]);
    const problems = isolation.configuration.join("; ");
    for (const expected of [/not read-only/, /not all dropped/, /isolated network/, /root/, /privilege/, /process limit/]) assert.match(problems, expected);
  } finally {
    await stopSandbox();
    try {
      docker("image", "rm", "releaseproof-liar");
    } catch {
      // best effort
    }
  }
});

test("the allow-list passes nothing that looks like a credential", () => {
  const env = hostEnv({
    PATH: "/usr/bin",
    HOME: "/root",
    ANTHROPIC_API_KEY: SECRET,
    GITHUB_TOKEN: SECRET,
    GH_TOKEN: SECRET,
    ACTIONS_RUNTIME_TOKEN: SECRET,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SECRET,
    JIRA_API_TOKEN: SECRET,
    HTTPS_PROXY: `http://user:${SECRET}@proxy`,
    NODE_OPTIONS: "--require /tmp/evil.js",
    LD_PRELOAD: "/tmp/evil.so",
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  assert.deepEqual(Object.keys(env).sort(), ["DOCKER_HOST", "HOME", "PATH"]);
  assert.doesNotMatch(JSON.stringify(env), new RegExp(SECRET));
});
