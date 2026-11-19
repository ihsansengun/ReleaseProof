// What an application that was not written for this system needs: no version
// endpoint, no test-data endpoints, its own image, somewhere to write, and a
// clean start for every scenario. Nothing here is specific to any one
// application.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildImage, checkInstance, IMAGE, instanceName, prepareSandbox, probeIsolation, startInstance, stopSandbox, writableMounts } from "../src/ci/sandbox.ts";
import { renderEnvironment } from "../src/ingest/context.ts";
import { briefing, SYSTEM } from "../src/execute/briefing.ts";
import { closeSession, openSession, runScenario } from "../src/execute/run.ts";
import { Manifest, type PlanDraft, type Scenario } from "../src/schema.ts";
import { SecretVault } from "../src/secrets.ts";
import { validatePlan } from "../src/validate.ts";

const SHA = "a".repeat(40);
// One assertion, never checked here: a scenario that is allowed to start ends "unverified", one that is not ends "blocked".
const scenario = (over: Partial<Scenario> = {}): Scenario => ({ id: "S1", title: "t", basis: "requirement", requirementIds: [], intent: "do it", fixtures: {}, assertions: [{ id: "A1", description: "d", kind: "present" }], ...over });

async function withServer<T>(work: (baseUrl: string, hits: string[]) => Promise<T>): Promise<T> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "text/html");
    response.end("<h1>Signed in as admin</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits);
  } finally {
    server.close();
  }
}

test("the manifest accepts an application's own Dockerfile, writable directories and existing accounts, and refuses unsafe ones", () => {
  const start = (extra: object) => Manifest.safeParse({ baseUrl: "http://localhost:1", start: { port: 8080, ...extra } });

  const own = start({ dockerfile: ".releaseproof/Dockerfile", writable: ["/data", "/var/lib/app-data"], instances: "per-scenario", env: { DATA_DIR: "/data" } });
  assert.ok(own.success);
  assert.equal(own.data.start!.instances, "per-scenario");
  // Existing manifests are unchanged: one shared application, nothing writable but /tmp.
  const classic = start({ run: "node server.mjs" });
  assert.ok(classic.success);
  assert.deepEqual([classic.data.start!.instances, classic.data.start!.writable], ["shared", []]);

  const refused: [string, object][] = [
    ["neither a command nor a Dockerfile", {}],
    ["both a command and a Dockerfile", { run: "x", dockerfile: "Dockerfile" }],
    ["build commands beside a Dockerfile", { dockerfile: "Dockerfile", install: "npm ci" }],
    ["a Dockerfile outside the application", { dockerfile: "../Dockerfile" }],
    ["a Dockerfile given as an absolute path", { dockerfile: "/etc/Dockerfile" }],
    ["a Dockerfile reached through ..", { dockerfile: "a/../../Dockerfile" }],
    ["the whole filesystem as writable", { run: "x", writable: ["/"] }],
    ["a relative writable path", { run: "x", writable: ["data"] }],
    ["a writable path with ..", { run: "x", writable: ["/data/../etc"] }],
    ["a writable path with mount options", { run: "x", writable: ["/data:exec"] }],
    ["a writable path with a space", { run: "x", writable: ["/data --privileged"] }],
    ["more writable paths than allowed", { run: "x", writable: ["/a", "/b", "/c", "/d", "/e", "/f"] }],
    ["an unknown instance mode", { run: "x", instances: "many" }],
  ];
  for (const [name, extra] of refused) assert.equal(start(extra).success, false, name);

  assert.ok(Manifest.safeParse({ baseUrl: "http://localhost:1", accounts: { admin: { description: "administrator", username: "admin", password: "admin" } } }).success);
  assert.equal(Manifest.safeParse({ baseUrl: "http://localhost:1", accounts: { "bad alias": { description: "d", username: "u", password: "p" } } }).success, false);
  assert.equal(Manifest.safeParse({ baseUrl: "http://localhost:1", accounts: { a: { description: "d", username: "u", password: "" } } }).success, false);

  // Each writable directory is an in-memory one of bounded size, owned by the sandbox user, where nothing can be executed.
  assert.deepEqual(writableMounts(["/data"]), ["--tmpfs", "/data:rw,size=128m,uid=10001,gid=10001,mode=0700,noexec,nosuid,nodev"]);
  // A scenario's label cannot inject anything into a container name.
  assert.equal(instanceName("3-agent-S1; rm -rf /"), "releaseproof-app-3-agent-s1--rm--rf--");
});

test("an existing account is offered to the planner and reaches the executor as a placeholder, without garbling ordinary text", async () => {
  const manifest = Manifest.parse({
    baseUrl: "http://localhost:1",
    accounts: { admin: { description: "the administrator that every new installation has", username: "admin", password: "admin" } },
    start: { dockerfile: "Dockerfile", port: 8080, instances: "per-scenario" },
  });
  const environment = renderEnvironment(manifest);
  assert.match(environment, /- admin: the administrator that every new installation has \(an account that already exists/);
  assert.match(environment, /Every scenario runs against its own freshly started application/);
  assert.doesNotMatch(environment, /password/i);

  // The planner may ask for it like any other test data; an unknown type is still refused.
  const draft = (type: string): PlanDraft => ({
    scenarios: [{ id: "S1", title: "t", basis: "requirement", requirementIds: [], riskIds: [], intent: "i", setup: " Create a second user. ", fixtures: [{ alias: "owner", type }], status: "blocked", blockedReason: "x", ambiguityIds: [], assertions: [] }],
  });
  const analysis = { featureSummary: "", requirements: [], ambiguities: [], risks: [] };
  const ok = validatePlan(draft("admin"), analysis, manifest, 5);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.plan.scenarios[0]!.scenario.fixtures, { owner: "admin" });
  assert.equal(ok.plan.scenarios[0]!.scenario.setup, "Create a second user.");
  assert.match(validatePlan(draft("superuser"), analysis, manifest, 5).problems.join("\n"), /needs a "superuser" fixture/);

  await withServer(async (baseUrl, hits) => {
    const dir = mkdtempSync(path.join(tmpdir(), "rp-onb-"));
    const open = await openSession({ scenario: scenario({ fixtures: { owner: "admin" } }), manifest: { ...manifest, baseUrl }, outDir: dir });
    try {
      assert.equal(open.session.outcome, undefined);
      assert.deepEqual(open.fixtures, { owner: { existingAccount: "the administrator that every new installation has", username: "admin", password: "{{secret:owner.password}}" } });
      // The tools can turn the placeholder back into the value at the moment of use.
      assert.equal(open.session.vault.resolve("{{secret:owner.password}}"), "admin");
      // A declared value is a word that also appears on pages; output is left readable.
      assert.equal(open.session.vault.scrub("Signed in as admin"), "Signed in as admin");
      // No request was made to create it.
      assert.ok(hits.every((h) => h.startsWith("GET ")), hits.join(", "));
    } finally {
      open.session.outcome = { kind: "completed", reason: "done" };
      await closeSession(open, { mode: "replay" });
    }
  });
  // Values that come back from a test-data endpoint are still scrubbed.
  const vault = new SecretVault();
  vault.maskFixtures({ user: { password: "hunter2-long-secret" } });
  assert.equal(vault.scrub("the page shows hunter2-long-secret"), "the page shows {{secret:user.password}}");
});

test("without a version endpoint a scenario runs only if the caller itself established the commit, and the result says how", async () => {
  const noEndpoint = Manifest.parse({ baseUrl: "http://localhost:1" });
  await withServer(async (baseUrl) => {
    const manifest = { ...noEndpoint, baseUrl };
    const run = (app?: { commitEstablished?: string }, m = manifest) =>
      runScenario({ scenario: scenario(), manifest: m, expectedSha: SHA, app, outDir: mkdtempSync(path.join(tmpdir(), "rp-onb-")), mode: { kind: "replay", steps: [] } });

    const unknown = await run();
    assert.equal(unknown.verdict, "blocked");
    assert.match(unknown.reason, /no version endpoint and nothing else establishes that it runs commit a{40}/);

    const established = await run({ commitEstablished: "this stage started the labelled image" });
    assert.equal(established.verdict, "unverified", established.reason);
    assert.equal(established.environment.commitEstablished, "this stage started the labelled image");
    assert.equal(established.environment.deployedSha, undefined);

    // An application that does have a version endpoint is still asked, and a wrong answer still blocks.
    const wrong = await run({ commitEstablished: "claimed" }, { ...manifest, version: { path: "/version" } });
    assert.equal(wrong.verdict, "blocked");
    assert.match(wrong.reason, /The environment runs commit unknown/);
    assert.equal(wrong.environment.commitEstablished, undefined);
  });
});

test("with an application per scenario, each run gets its own and gives it back, and one that cannot start is blocked", async () => {
  await withServer(async (baseUrl) => {
    const manifest = Manifest.parse({ baseUrl: "http://unused.invalid" });
    const events: string[] = [];
    const app = {
      commitEstablished: "x",
      instance: async (label: string) => {
        events.push(`start ${label}`);
        return { baseUrl, release: async () => void events.push(`stop ${label}`) };
      },
    };
    const run = (id: string, kind: "replay") =>
      runScenario({ scenario: scenario({ id }), manifest, expectedSha: SHA, app, outDir: mkdtempSync(path.join(tmpdir(), "rp-onb-")), mode: { kind, steps: [] } });
    const first = await run("S1", "replay");
    const second = await run("S2", "replay");
    assert.deepEqual(events, ["start replay-S1", "stop replay-S1", "start replay-S2", "stop replay-S2"]);
    // The scenario ran against the address it was given, not the manifest's.
    assert.equal(first.environment.baseUrl, baseUrl);
    assert.equal(second.environment.baseUrl, baseUrl);

    const failing = await runScenario({
      scenario: scenario(),
      manifest,
      app: { instance: async () => Promise.reject(new Error("an application container was not isolated as required")) },
      outDir: mkdtempSync(path.join(tmpdir(), "rp-onb-")),
      mode: { kind: "replay", steps: [] },
    });
    assert.equal(failing.verdict, "blocked");
    assert.match(failing.reason, /could not be started for this scenario: an application container was not isolated/);
    assert.equal(failing.steps.length, 0);
  });
});

test("preparation through the interface is briefed as preparation, and failing it means blocked", () => {
  const manifest = Manifest.parse({ baseUrl: "http://localhost:1" });
  const withSetup = briefing(scenario({ setup: "Create a second user and a private record." }), manifest, {});
  assert.match(withSetup, /Preparation \(create this first; it is not under test\):\nCreate a second user and a private record\.\n\nObjective:/);
  assert.doesNotMatch(briefing(scenario(), manifest, {}), /Preparation/);
  assert.match(SYSTEM, /If you cannot complete it, call finish with outcome "blocked"/);
});

// ---- with a real container engine -------------------------------------------

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const haveDocker = (() => {
  try {
    docker("image", "inspect", "alpine:3.24");
    return true;
  } catch {
    try {
      docker("pull", "--quiet", "alpine:3.24");
      return true;
    } catch {
      return false;
    }
  }
})();

/** The test server answers one request at a time and reopens its port in between, so a refused connection is retried. */
async function read(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await (await fetch(url, { signal: AbortSignal.timeout(2_000) })).text()).trim();
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

test("an image from the application's own Dockerfile runs under the sandbox's rules, once per scenario, with only the declared directory writable", { skip: !haveDocker }, async () => {
  // Not a Node application, and its Dockerfile asks for root and a wrong commit label.
  const dir = mkdtempSync(path.join(tmpdir(), "rp-own-"));
  writeFileSync(
    path.join(dir, "Dockerfile.test"),
    [
      "FROM alpine:3.24",
      `LABEL releaseproof.sha=${"f".repeat(40)}`,
      "USER root",
      // Serves the writable directory, after writing into it; fails to start if it cannot write.
      `CMD ["sh", "-c", "id -u > /data/index.html && while true; do { printf 'HTTP/1.0 200 OK\\r\\n\\r\\n'; cat /data/index.html; } | nc -l -p 8080; done"]`,
    ].join("\n"),
  );
  const start = { dockerfile: "Dockerfile.test", port: 8080, env: { DATA_DIR: "/data" }, writable: ["/data"], instances: "per-scenario" as const };
  // Other tests expect the image they built under this name. Building replaces
  // it, and an image left without a name may be deleted, so it is kept under another.
  const KEPT = `${IMAGE}-kept-by-test`;
  const previous = (() => {
    try {
      docker("tag", IMAGE, KEPT);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    await buildImage({ contextDir: dir, dockerfile: path.join(dir, "Dockerfile.test"), start, sha: SHA });
    // The label is the one the build stage set, not the one the Dockerfile asked for.
    assert.equal(docker("inspect", "--format", '{{index .Config.Labels "releaseproof.sha"}}', IMAGE), SHA);

    await prepareSandbox();
    const one = await startInstance({ start, sha: SHA, label: "1-agent-S1" });
    const two = await startInstance({ start, sha: SHA, label: "2-agent-S2" });
    assert.notEqual(one.baseUrl, two.baseUrl);
    assert.notEqual(one.container, two.container);
    // Each wrote to its own /data, as the sandbox user, whatever the Dockerfile said.
    for (const instance of [one, two]) assert.equal(await read(instance.baseUrl), "10001");

    const isolation = await probeIsolation(start, one.container);
    assert.deepEqual(isolation.configuration, []);
    assert.equal(isolation.outboundNetwork, "blocked", `reached: ${isolation.reached.join(", ")}`);
    assert.equal(isolation.rootFilesystem, "read-only");
    assert.equal(isolation.user, "10001");
    assert.deepEqual(isolation.unexpectedEnvironment, []);
    assert.ok(isolation.ok);
    assert.deepEqual(await checkInstance(start, two.container), []);

    // State does not travel between instances.
    docker("exec", one.container, "sh", "-c", "echo changed > /data/index.html");
    await read(one.baseUrl); // the test server prepared this answer before the change
    assert.equal(await read(one.baseUrl), "changed");
    assert.equal(await read(two.baseUrl), "10001");

    // Stopping the sandbox removes every instance.
    await stopSandbox();
    assert.equal(docker("ps", "--all", "--quiet", "--filter", "label=releaseproof.sandbox=1"), "");
  } finally {
    await stopSandbox();
    if (previous) {
      docker("tag", KEPT, IMAGE);
      docker("rmi", KEPT);
    }
  }
});
