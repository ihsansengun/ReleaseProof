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

test("a hostile result file cannot change where or what the report stage publishes", async () => {
  const { readFile } = await import("node:fs/promises");
  const { render, ReportInput } = await import("../src/ci/report.ts");
  const run = JSON.parse(await readFile(new URL("../../../eval/recordings/NWG-342.json", import.meta.url), "utf8"));
  const sha = "b".repeat(40);
  const base = { status: "completed", repo: "acme/widgets", pr: 1, headSha: sha, run };

  // Fields that decide where the report goes are validated, not displayed.
  for (const bad of [
    { ...base, repo: "acme/widgets/../../other/repo" },
    { ...base, repo: "acme/widgets?x=1" },
    { ...base, headSha: "main" },
    { ...base, headSha: `${sha}/../x` },
    { ...base, pr: "1/comments/../../../issues/2" },
    { ...base, pr: -1 },
    { ...base, status: "passed" },
    { ...base, run: { ...run, results: "all passed" } },
    { ...base, run: { ...run, executionMode: "autonomous-and-green" } },
  ]) {
    assert.equal(ReportInput.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }

  // Everything displayed is neutralised and bounded, whatever its size.
  const hostile = structuredClone(run);
  const payload = '</details><script>alert(1)</script> @octocat [x](https://evil.example) ![i](https://evil.example/p.png) <!-- releaseproof-report --> | a |\n\n# Ready: all passed\n';
  hostile.ticketKey = payload;
  hostile.driver = payload;
  hostile.stopped = payload;
  hostile.analysis.requirements[0].text = payload.repeat(2000);
  hostile.analysis.requirements[0].quote = payload;
  hostile.analysis.ambiguities = Array.from({ length: 500 }, (_, i) => ({ id: `Q${i}`, question: payload }));
  hostile.results[0].title = payload;
  hostile.results[0].reason = payload;
  hostile.results[0].verdict = "failed";
  hostile.results[0].assertionResults[0].pass = false;
  hostile.results[0].assertionResults[0].actual = payload;
  hostile.plan.scenarios[0].scenario.title = payload;
  hostile.plan.scenarios.at(-1).blockedReason = payload;
  hostile.confirmations = { [hostile.results[0].scenarioId]: payload };
  hostile.usage = {
    byStage: { [payload]: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, toolCalls: 1, usd: 1 } },
    total: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, toolCalls: 1, usd: 1 },
    estimatedUsd: 1,
    minutes: 1,
    limits: { maxUsd: 1, maxMinutes: 1 },
    apiErrors: [{ stage: payload, error: payload }],
  };
  hostile.executionMode = "autonomous";
  const out = render(ReportInput.parse({ ...base, run: hostile, isolation: { environment: [payload], outboundNetwork: payload, rootFilesystem: payload, user: payload, ok: true } }), "https://evil.example/actions/runs/1");
  assert.equal(out.conclusion, "failure");
  assert.ok(out.body.length <= 60_100);
  assert.doesNotMatch(out.body, /<script|<\/details><script|@octocat|\]\(https:\/\/evil|!\[i\]\(|evil\.example\/actions/);
  assert.equal(out.body.match(/<!-- releaseproof-report -->/g)?.length, 1);
  assert.doesNotMatch(out.body, /^# Ready/m);
  assert.doesNotMatch(out.title, /[<>\n]/);
});
