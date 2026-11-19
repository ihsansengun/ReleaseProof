import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configurationProblems } from "../src/ci/sandbox.ts";
import { browserEnv } from "../src/execute/run.ts";
import { buildContext, resolveDoc } from "../src/ingest/context.ts";
import { Manifest, type PullRequest, type Ticket } from "../src/schema.ts";

test("a listed document that is a symbolic link, or lies outside the application, is never read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rp-docs-"));
  const app = path.join(dir, "app");
  await mkdir(path.join(app, "docs"), { recursive: true });
  await writeFile(path.join(dir, "secret.txt"), "RUNNER-SECRET");
  await writeFile(path.join(app, "README.md"), "Real documentation.");
  await symlink(path.join(dir, "secret.txt"), path.join(app, "NOTES.md"));
  await symlink(dir, path.join(app, "docs", "up"));
  await symlink("/proc/self/environ", path.join(app, "ENV.md"));
  await writeFile(path.join(app, "releaseproof.yml"), "x");

  assert.ok("file" in (await resolveDoc(app, "README.md")));
  for (const hostile of ["NOTES.md", "ENV.md", "docs/up/secret.txt", "../secret.txt", "/proc/self/environ", "docs", "missing.md", "."]) {
    assert.ok("refused" in (await resolveDoc(app, hostile)), hostile);
  }

  const manifest = Manifest.parse({ baseUrl: "http://localhost:1", docs: ["README.md", "NOTES.md", "ENV.md", "docs/up/secret.txt", "../secret.txt"] });
  const context = await buildContext(
    { key: "X-1" } as Ticket,
    { files: [] } as unknown as PullRequest,
    manifest,
    path.join(app, "releaseproof.yml"),
  );
  assert.deepEqual(context.docs.map((d) => d.path), ["README.md"]);
  assert.doesNotMatch(JSON.stringify(context), /RUNNER-SECRET|PATH=/);
  assert.equal(context.omitted.length, 4);
});

test("the browser is started without the engine's credentials", () => {
  const env = browserEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    LANG: "C.UTF-8",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghs_secret",
    ACTIONS_RUNTIME_TOKEN: "x",
    HTTPS_PROXY: "http://user:pass@proxy",
    JIRA_API_TOKEN: "y",
    XDG_RUNTIME_DIR: "/run/user/1",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "XDG_RUNTIME_DIR"]);
});

test("the container's settings are checked as the engine reports them", () => {
  const good = {
    Config: { Env: ["PATH=/usr/bin", "NODE_VERSION=22", "PORT=3000", "GIT_SHA=abc"], User: "10001:10001" },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: "releaseproof-net",
      Binds: null,
      PidsLimit: 256,
      Memory: 1073741824,
      PidMode: "",
      IpcMode: "private",
    },
    Mounts: [],
    NetworkSettings: { Networks: { "releaseproof-net": {} } },
  };
  const allowed = new Set(["PORT", "GIT_SHA"]);
  const image = new Set(["PATH", "NODE_VERSION"]);
  assert.deepEqual(configurationProblems(good, { Internal: true }, allowed, image), []);

  const broken: [string, (c: typeof good) => unknown, RegExp][] = [
    ["writable root", (c) => (c.HostConfig.ReadonlyRootfs = false), /not read-only/],
    ["privileged", (c) => (c.HostConfig.Privileged = true), /privileged/],
    ["capabilities kept", (c) => (c.HostConfig.CapDrop = []), /not all dropped/],
    ["bridge network", (c) => (c.HostConfig.NetworkMode = "bridge"), /isolated network/],
    ["second network", (c) => ((c.NetworkSettings.Networks as Record<string, unknown>).bridge = {}), /another network/],
    ["host mount", (c) => ((c.Mounts as unknown[]) = [{ Type: "bind", Destination: "/host" }]), /mounted/],
    ["root user", (c) => (c.Config.User = "0:0"), /root/],
    ["no user", (c) => (c.Config.User = ""), /root/],
    ["leaked variable", (c) => c.Config.Env.push("ANTHROPIC_API_KEY=sk"), /ANTHROPIC_API_KEY/],
    ["no process limit", (c) => (c.HostConfig.PidsLimit = 0), /process limit/],
  ];
  for (const [name, breakIt, expected] of broken) {
    const copy = structuredClone(good);
    breakIt(copy);
    assert.match(configurationProblems(copy, { Internal: true }, allowed, image).join("; "), expected, name);
  }
  assert.match(configurationProblems(good, { Internal: false }, allowed, image).join("; "), /route out/);
});
