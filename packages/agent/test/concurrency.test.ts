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

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string };
type Job = { steps: Step[]; needs?: string | string[]; permissions?: Record<string, string>; concurrency?: { group: string; "cancel-in-progress": boolean }; if?: string };
const jobsOf = (file: { jobs: Record<string, Job> }) => Object.entries(file.jobs);

test("the workflows are wired so that the key is the only thing that groups QA runs", () => {
  const qa = workflow("releaseproof-qa-reusable.yml");
  // No workflow-level group: that one is joined before any gate, by every completed request.
  assert.equal(qa.concurrency, undefined);
  assert.equal(workflow("releaseproof-qa.yml").concurrency, undefined);
  assert.equal(qa.jobs.qa.concurrency.group, "releaseproof-qa-${{ needs.identify.outputs.key }}");
  assert.equal(qa.jobs.qa.concurrency["cancel-in-progress"], true);
  assert.equal(qa.jobs.build.concurrency.group, "releaseproof-build-${{ needs.identify.outputs.key }}");
  assert.deepEqual([qa.jobs.build.needs].flat(), ["identify"]);
  assert.deepEqual([qa.jobs.qa.needs].flat(), ["identify", "build"]);
  assert.equal(qa.jobs.report.concurrency, undefined);
  // The gate sits on the first job, so a skipped run never reaches a group.
  assert.match(qa.jobs.identify.if, /workflow_dispatch' \|\| vars\.RELEASEPROOF_AUTO_TRIGGER == 'on'/);
  // The identifying job holds no secret and cannot write.
  const identify = JSON.stringify(qa.jobs.identify);
  assert.doesNotMatch(identify, /secrets\./);
  assert.deepEqual(qa.jobs.identify.permissions, { contents: "read", actions: "read" });
  // Nothing a pull request controls is interpolated into a group or a script.
  assert.doesNotMatch(JSON.stringify(qa.jobs), /concurrency[^}]*display_title/);
  for (const [, job] of jobsOf(qa)) {
    for (const step of job.steps) assert.doesNotMatch(step.run ?? "", /\$\{\{/, "scripts take their inputs from the environment, never by interpolation");
  }

  const request = workflow("releaseproof-request.yml");
  assert.match(request["run-name"], /#\$\{\{/, "the pull request number must survive YAML parsing");
  assert.equal(request.concurrency.group, "releaseproof-request-${{ inputs.pr || github.event.pull_request.number }}");
  assert.equal(JSON.stringify(request).includes("secrets."), false);
  assert.equal(JSON.stringify(request).includes("pull_request_target"), false);
  // The request stage holds nothing worth taking and touches no code: it checks out nothing.
  assert.deepEqual(request.permissions, { contents: "read" });
  for (const [, job] of jobsOf(request)) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses ?? "", /checkout/);
      assert.doesNotMatch(step.run ?? "", /\$\{\{/);
    }
  }
});

test("the image is built by trusted code from the commit GitHub reports, in a job with no secret", () => {
  const qa = workflow("releaseproof-qa-reusable.yml");
  const build: Job = qa.jobs.build;
  assert.doesNotMatch(JSON.stringify(build), /secrets\./);
  assert.deepEqual(build.permissions, { contents: "read", actions: "read", "pull-requests": "read" });

  const names = build.steps.map((s) => s.name ?? s.uses ?? "");
  const at = (name: string) => {
    const index = names.findIndex((n) => n.startsWith(name));
    assert.notEqual(index, -1, name);
    return index;
  };
  // The commit comes from GitHub's answer to trusted code, then exactly that commit is fetched, then built.
  const head = build.steps[at("Ask GitHub which commit")]!;
  assert.match(head.run!, /cli\.ts head --repo "\$GITHUB_REPOSITORY" --pr "\$PR"/);
  assert.match(head.run!, /"\$TRIGGER_EVENT" = "pull_request" \] && \[ "\$sha" != "\$TRIGGER_SHA"/);
  const fetched = build.steps[at("Fetch exactly that commit")]!;
  assert.equal(fetched.with!.ref, "${{ steps.head.outputs.sha }}");
  assert.equal(fetched.with!["persist-credentials"], false);
  assert.equal(fetched.with!.path, "pr");
  assert.ok(at("Ask GitHub which commit") < at("Fetch exactly that commit") && at("Fetch exactly that commit") < at("Build the application image"));
  // Pull-request files are a build context only: no step runs from that directory.
  for (const step of build.steps) {
    assert.notEqual((step as { "working-directory"?: string })["working-directory"], "pr");
    assert.doesNotMatch(step.run ?? "", /(^|\s)(sh|bash|node|npm|npx|\.)\s+"?\$?\{?GITHUB_WORKSPACE\}?\/pr/);
  }
  // The digest travels as a job output, outside the artifact, and both test steps require it.
  assert.equal(qa.jobs.build.outputs.image_sha256, "${{ steps.digest.outputs.sha256 }}");
  for (const name of ["Test the application", "Verify that the application starts isolated"]) {
    const step = (qa.jobs.qa.steps as Step[]).find((s) => (s.name ?? "").startsWith(name))!;
    assert.equal(step.env!.IMAGE_SHA256, "${{ needs.build.outputs.image_sha256 }}");
    assert.match(step.run!, /--image-sha256 "\$IMAGE_SHA256"/);
    assert.match(step.run!, /--trusted-root "\$GITHUB_WORKSPACE\/protected"/);
  }
  // The QA job never fetches the pull request.
  for (const step of qa.jobs.qa.steps as Step[]) assert.doesNotMatch(JSON.stringify(step.with ?? {}), /head\.outputs|refs\/pull/);
});

test("every third-party action is pinned to a full commit, and the engine to one as well", () => {
  for (const file of ["releaseproof-request.yml", "releaseproof-qa.yml", "releaseproof-qa-reusable.yml"]) {
    const parsed = workflow(file);
    for (const [name, job] of Object.entries(parsed.jobs) as [string, Job & { uses?: string }][]) {
      if (job.uses) assert.match(job.uses, /^\.\/\.github\/workflows\//, `${file}/${name} calls a workflow outside this commit`);
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}/${name}: ${step.uses}`);
      }
    }
  }
  const reusable = workflow("releaseproof-qa-reusable.yml");
  const first = reusable.jobs.identify.steps[0] as Step;
  assert.match(first.run!, /releaseproof_ref must be a full commit SHA/);
  for (const [, job] of jobsOf(reusable)) {
    for (const step of job.steps) {
      if (step.with?.repository) assert.equal(step.with.ref, "${{ inputs.releaseproof_ref }}");
    }
  }
});

test("only the QA job's test step is given the model key", () => {
  const qa = workflow("releaseproof-qa-reusable.yml");
  const holders: string[] = [];
  for (const [name, job] of jobsOf(qa)) {
    for (const step of job.steps) if (JSON.stringify(step.env ?? {}).includes("secrets.")) holders.push(`${name}/${step.name}`);
  }
  assert.deepEqual(holders, ["qa/Test the application"]);
  // The Jira token and account email come from secrets; the site address is a plain variable.
  const steps = qa.jobs.qa.steps as Step[];
  const env = steps.find((s) => s.name === "Test the application")!.env!;
  assert.equal(env.JIRA_API_TOKEN, "${{ secrets.JIRA_API_TOKEN }}");
  assert.match(env.JIRA_EMAIL!, /^\$\{\{ secrets\.JIRA_EMAIL \|\| vars\.JIRA_EMAIL \}\}$/);
  assert.equal(env.JIRA_BASE_URL, "${{ vars.JIRA_BASE_URL }}");
  assert.equal(env.ANTHROPIC_API_KEY, "${{ secrets.ANTHROPIC_API_KEY }}");
  // Verification runs instead of the test step, never beside it, and with no credential but the read-only token.
  const verify = steps.find((s) => (s.name ?? "").startsWith("Verify that the application starts isolated"))!;
  assert.equal(verify.if, "needs.build.outputs.verify_only == 'true'");
  assert.equal(steps.find((s) => s.name === "Test the application")!.if, "needs.build.outputs.verify_only != 'true'");
  assert.match(verify.run!, /run --verify-only/);
  assert.deepEqual(Object.keys(verify.env!).filter((k) => /KEY|TOKEN|EMAIL|SECRET/.test(k)), ["GITHUB_TOKEN"]);
  // This repository's caller passes on exactly the three secrets and grants no more than the jobs ask for.
  const caller = workflow("releaseproof-qa.yml").jobs.releaseproof;
  assert.deepEqual(Object.keys(caller.secrets).sort(), ["ANTHROPIC_API_KEY", "JIRA_API_TOKEN", "JIRA_EMAIL"]);
  assert.deepEqual(caller.permissions, { contents: "read", actions: "read", "pull-requests": "write", checks: "write" });
  assert.equal(caller.with.releaseproof_ref, "${{ github.sha }}");
});
