import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
// @ts-expect-error plain JavaScript shared with the workflow
import { concurrencyKey } from "../../../ci/qa-concurrency.mjs";

const key = concurrencyKey as (i: { event?: string; eventPr?: unknown; metaPr?: unknown; runId?: unknown }) => string;
const workflow = (name: string) => parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8"));

/**
 * GitHub's rule for a job-level group with cancel-in-progress: when a run
 * enters a group, the run already in that group is cancelled. Runs that are
 * skipped before the job never enter a group.
 */
function simulate(arrivals: { name: string; gated: boolean; key: string }[]): Record<string, "running" | "cancelled" | "skipped"> {
  const state: Record<string, "running" | "cancelled" | "skipped"> = {};
  const holder = new Map<string, string>();
  for (const run of arrivals) {
    if (!run.gated) {
      state[run.name] = "skipped";
      continue;
    }
    const previous = holder.get(run.key);
    if (previous) state[previous] = "cancelled";
    holder.set(run.key, run.name);
    state[run.name] = "running";
  }
  return state;
}

test("runs for different pull requests never share a concurrency key", () => {
  const manual8 = key({ event: "workflow_dispatch", metaPr: 8, runId: "100" });
  const manual9 = key({ event: "workflow_dispatch", metaPr: 9, runId: "101" });
  const auto9 = key({ event: "pull_request", eventPr: "9", metaPr: 9, runId: "102" });
  const auto10 = key({ event: "pull_request", eventPr: "10", metaPr: 10, runId: "103" });
  assert.equal(manual8, "pr-8");
  assert.notEqual(manual8, manual9);
  assert.notEqual(auto9, auto10);
  assert.notEqual(manual8, auto10);
  // The same pull request shares one key however the run was started, so a newer build replaces the older run.
  assert.equal(manual9, auto9);
});

test("a pull request cannot claim another pull request's key", () => {
  // Its build says it is pull request 8; GitHub's record of the event says 9.
  assert.equal(key({ event: "pull_request", eventPr: "9", metaPr: 8, runId: "1" }), "pr-9");
  // No record of the event (a fork): a key of its own, which can cancel nothing.
  assert.equal(key({ event: "pull_request", eventPr: "", metaPr: 8, runId: "77" }), "run-77");
  for (const hostile of ["8; rm -rf /", "pr-8", "8\n9", -8, 0, 1.5, {}, null, undefined, "08", "9".repeat(12)]) {
    assert.equal(key({ event: "workflow_dispatch", metaPr: hostile, runId: "5" }), "run-5", JSON.stringify(hostile));
    assert.equal(key({ event: "pull_request", eventPr: hostile, metaPr: 8, runId: "5" }), "run-5", JSON.stringify(hostile));
  }
  assert.equal(key({ event: "push", eventPr: "8", metaPr: 8, runId: "6" }), "run-6");
  assert.match(key({ event: "workflow_dispatch", metaPr: 8, runId: "$(id)" }), /^pr-8$/);
  assert.equal(key({ event: "push", runId: "$(id)" }), "run-unknown");
});

test("simultaneous runs: only a newer build of the same pull request replaces a run in flight", () => {
  const gate = (event: string, auto: boolean) => event === "workflow_dispatch" || auto;

  // What happened on 19 November: a live manual run for #8, then a draft pull request #9 is opened.
  const incident = simulate([
    { name: "manual #8", gated: gate("workflow_dispatch", false), key: key({ event: "workflow_dispatch", metaPr: 8, runId: "1" }) },
    { name: "opened #9", gated: gate("pull_request", false), key: key({ event: "pull_request", eventPr: "9", runId: "2" }) },
  ]);
  assert.deepEqual(incident, { "manual #8": "running", "opened #9": "skipped" });

  // The old keying, for contrast: one title shared by every build, joined before the gate.
  const old = simulate([
    { name: "manual #8", gated: true, key: "ReleaseProof build for PR" },
    { name: "opened #9", gated: true, key: "ReleaseProof build for PR" },
  ]);
  assert.equal(old["manual #8"], "cancelled");

  // Automatic runs on, several pull requests and manual runs at once.
  const busy = simulate([
    { name: "auto #8", gated: gate("pull_request", true), key: key({ event: "pull_request", eventPr: "8", runId: "1" }) },
    { name: "auto #9", gated: gate("pull_request", true), key: key({ event: "pull_request", eventPr: "9", runId: "2" }) },
    { name: "manual #10", gated: true, key: key({ event: "workflow_dispatch", metaPr: 10, runId: "3" }) },
    { name: "manual #11", gated: true, key: key({ event: "workflow_dispatch", metaPr: 11, runId: "4" }) },
    { name: "hostile #12 claiming #8", gated: true, key: key({ event: "pull_request", eventPr: "12", metaPr: 8, runId: "5" }) },
    { name: "fork", gated: true, key: key({ event: "pull_request", eventPr: "", metaPr: 9, runId: "6" }) },
    { name: "auto #9 new commit", gated: true, key: key({ event: "pull_request", eventPr: "9", runId: "7" }) },
  ]);
  assert.deepEqual(busy, {
    "auto #8": "running",
    "auto #9": "cancelled",
    "manual #10": "running",
    "manual #11": "running",
    "hostile #12 claiming #8": "running",
    fork: "running",
    "auto #9 new commit": "running",
  });
});

test("the workflows are wired so that the key is the only thing that groups QA runs", () => {
  const qa = workflow("releaseproof-qa.yml");
  // No workflow-level group: that one is joined before any gate, by every completed build.
  assert.equal(qa.concurrency, undefined);
  assert.equal(qa.jobs.qa.concurrency.group, "releaseproof-qa-${{ needs.identify.outputs.key }}");
  assert.equal(qa.jobs.qa.concurrency["cancel-in-progress"], true);
  assert.deepEqual([qa.jobs.qa.needs].flat(), ["identify"]);
  assert.equal(qa.jobs.report.concurrency, undefined);
  // The gate sits on the first job, so a skipped run never reaches the group.
  assert.match(qa.jobs.identify.if, /workflow_dispatch' \|\| vars\.RELEASEPROOF_AUTO_TRIGGER == 'on'/);
  // The identifying job holds no secret and cannot write.
  const identify = JSON.stringify(qa.jobs.identify);
  assert.doesNotMatch(identify, /secrets\./);
  assert.deepEqual(qa.jobs.identify.permissions, { contents: "read", actions: "read" });
  // Nothing a pull request controls is interpolated into a group or a script.
  assert.doesNotMatch(JSON.stringify(qa.jobs), /concurrency[^}]*display_title/);
  for (const job of Object.values(qa.jobs) as { steps: { run?: string }[] }[]) {
    for (const step of job.steps) assert.doesNotMatch(step.run ?? "", /\$\{\{\s*github\.event\.workflow_run\.(display_title|head_branch|head_commit)/);
  }

  const build = workflow("releaseproof-build.yml");
  assert.match(build["run-name"], /#\$\{\{/, "the pull request number must survive YAML parsing");
  assert.equal(build.concurrency.group, "releaseproof-build-${{ inputs.pr || github.event.pull_request.number }}");
  assert.equal(JSON.stringify(build).includes("secrets."), false);
  assert.equal(JSON.stringify(build).includes("pull_request_target"), false);
});

test("only the QA job's test step is given the model key", () => {
  const qa = workflow("releaseproof-qa.yml");
  const holders: string[] = [];
  for (const [name, job] of Object.entries(qa.jobs) as [string, { steps: { name?: string; env?: Record<string, string> }[] }][]) {
    for (const step of job.steps) if (JSON.stringify(step.env ?? {}).includes("secrets.")) holders.push(`${name}/${step.name}`);
  }
  assert.deepEqual(holders, ["qa/Test the application"]);
});
