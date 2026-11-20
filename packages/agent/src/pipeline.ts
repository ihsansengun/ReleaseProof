import { buildAuditTrail, renderAuditTrail } from "./report/audit.ts";
import { buildDiagnostics, renderDiagnostics } from "./report/diagnostics.ts";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyse } from "./analyse.ts";
import type { Budget } from "./budget.ts";
import { discover } from "./discover.ts";
import type { Driver } from "./drivers/driver.ts";
import { runScenario, type AppAccess } from "./execute/run.ts";
import { computeVerdict, erroredVerdict } from "./execute/verdict.ts";
import { contradicted, restsOnSingleObservations, standings } from "./report/standing.ts";
import { buildContext, type AuthorityInputs } from "./ingest/context.ts";
import { fingerprint } from "./sources.ts";
import { plan as makePlan } from "./plan.ts";
import { renderRunReport } from "./report/run.ts";
import type { Assertion, Manifest, PullRequest, RunReport, Scenario, ScenarioResult, Ticket } from "./schema.ts";

export type PipelineOptions = {
  ticket: Ticket;
  pullRequest: PullRequest;
  manifest: Manifest;
  manifestFile: string;
  /** Where requirements may come from, as established by the caller. */
  authority: AuthorityInputs;
  authorityNotices?: string[];
  driver: Driver;
  budget: Budget;
  outDir: string;
  maxScenarios: number;
  concurrency: number;
  /** Skip the check that the environment runs the pull request's head commit. */
  allowShaMismatch?: boolean;
  /** What the caller established about the running application, and how to get one per scenario. */
  app?: AppAccess;
  /** Re-run scenarios that ended without a trustworthy verdict on the escalation model. */
  escalation?: boolean;
};

/**
 * Why a scenario's first run does not settle it, or undefined if it does.
 *
 *   - no comparison was completed (unverified), or the executor reported an
 *     obstacle after it had started working (blocked)
 *   - it failed, and the repeat without a model did not reproduce the failure
 *
 *   - it failed and repeats, but every failed comparison is one reading from
 *     the page through one locator. The repeat replays that same locator, so
 *     it shows the reading is stable and nothing about whether the locator
 *     was right. A second attempt has to find the value its own way.
 *
 * A failure that repeats and is backed by the application's own API response,
 * or by a second comparison of the same requirement through another target,
 * is evidence and stays a failure. A scenario that never started (the
 * application did not come up, the commit could not be established) is not a
 * matter of model ability either.
 */
export function needsEscalation(result: ScenarioResult, confirmation: string | undefined, assertions?: Assertion[]): string | undefined {
  if (result.verdict === "failed") {
    if (confirmation !== "reproduced") return `its failure was not reproduced by the repeat without a model (${confirmation ?? "no repeat"})`;
    return assertions && restsOnSingleObservations(assertions, result)
      ? "its failure repeats but rests on a single page observation that nothing else confirms"
      : undefined;
  }
  // Stopped by the application itself: a stronger model would meet the same error.
  if (result.verdict === "errored") return undefined;
  if (result.verdict === "passed" || result.steps.length === 0) return undefined;
  // Stopped for lack of budget: a stronger model would only spend more.
  if (/budget exhausted|limit (of|would)/i.test(result.reason)) return undefined;
  return result.verdict === "unverified" ? "it ended without completing its comparisons" : "the executor could not get through it";
}

/**
 * Whether an escalated run replaces the first result.
 *
 * It does if it passed: every comparison matched, each on its own record.
 *
 * A failure has to carry more than its own repetition. Replaying it repeats
 * the same target at the same moment, so a wrong target, or a right one read
 * too late, repeats as faithfully as a defect does. An escalated failure
 * therefore replaces the first result only if it repeats AND at least one of
 * its mismatches is backed by something other than a single page reading:
 * the application's own API response, a second failed comparison of the same
 * requirement through another target, or the first attempt having failed the
 * same assertion through a different target.
 *
 * Otherwise the first result stands as it was, inconclusive if it was
 * inconclusive, and the escalated attempt stays on record as not kept. A real
 * defect seen only once, through one page reading, is then left without a
 * verdict; a person can read the attempt and decide.
 */
export function escalatedRunSettles(assertions: Assertion[], first: ScenarioResult, second: ScenarioResult, confirmation: string | undefined): boolean {
  if (second.verdict === "passed") return true;
  if (second.verdict !== "failed" || confirmation !== "reproduced") return false;
  return [...standings(assertions, second, first).values()].some((standing) => standing !== "single");
}

/**
 * What becomes of a failed first result when a second attempt settled nothing
 * but disagreed with it: comparisons the two attempts located differently and
 * read differently (one mismatch, one match) are taken out, and the verdict
 * is computed again from the rest. Undefined if there is no such comparison.
 */
export function setAsideDisagreements(assertions: Assertion[], first: ScenarioResult, second: ScenarioResult): ScenarioResult | undefined {
  const disagreed = first.verdict === "failed" ? contradicted(assertions, first, second) : [];
  if (disagreed.length === 0) return undefined;
  const ids = new Set(disagreed.map((d) => d.mine.assertionId));
  const remaining = first.assertionResults.filter((r) => !ids.has(r.assertionId));
  const recomputed = computeVerdict(assertions, remaining, {
    kind: "stopped",
    reason: `Two attempts located ${[...ids].join(", ")} differently and disagreed (one mismatch, one match), so the comparison${ids.size === 1 ? " was" : "s were"} set aside as a locator disagreement, not counted as a defect.`,
  });
  return {
    ...first,
    verdict: recomputed.verdict,
    reason: recomputed.reason,
    assertionResults: remaining,
    setAside: disagreed.map((d) => ({
      assertionId: d.mine.assertionId,
      expected: d.mine.expected,
      actual: d.mine.actual,
      target: d.mine.target,
      otherActual: d.theirs.actual,
      otherTarget: d.theirs.target,
    })),
  };
}

/** Runs `worker` over `items`, at most `limit` at a time, keeping their positions. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

/** Fingerprint of a ticket's text alone. Kept for runs made before sources had trust levels. */
export const ticketHash = (ticket: Ticket) =>
  createHash("sha256")
    .update(JSON.stringify([ticket.summary, ticket.description, ticket.comments.map((c) => c.body)]))
    .digest("hex");

/** A scenario that was planned but never started, recorded as such. */
function notExecuted(scenario: Scenario, manifest: Manifest, reason: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    mode: "agent",
    verdict: "unverified",
    reason: `Not executed: ${reason}`,
    environment: { baseUrl: manifest.baseUrl },
    assertionResults: [],
    observations: {},
    steps: [],
    evidence: { dir: "" },
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

function stageTimer(budget: Budget, timings: RunReport["timings"]) {
  return async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    budget.enter(stage);
    const start = Date.now();
    try {
      return await work();
    } finally {
      timings.push({ stage, seconds: Math.round((Date.now() - start) / 100) / 10 });
      console.log(`[${stage}] ${timings.at(-1)!.seconds}s`);
    }
  };
}

async function writeRun(outDir: string, report: RunReport): Promise<RunReport> {
  await writeFile(path.join(outDir, "run.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(outDir, "report.md"), renderRunReport(report));
  // The audit trail: source -> requirement -> assertion -> evidence.
  const trail = buildAuditTrail(report);
  await writeFile(path.join(outDir, "audit.json"), JSON.stringify(trail, null, 2));
  await writeFile(path.join(outDir, "audit.md"), renderAuditTrail(trail));
  // What did not pass, in a redacted form that is safe to show outside the artifact.
  const diagnostics = buildDiagnostics(report);
  await writeFile(path.join(outDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  await writeFile(path.join(outDir, "diagnostics.md"), renderDiagnostics(diagnostics));
  return report;
}

/**
 * Ticket and pull request in, executed and evidenced test results out.
 * Each stage's output is written to disk as it completes. A run that hits
 * its budget or loses the model still ends with a report that says so.
 */
export async function runPipeline(options: PipelineOptions): Promise<RunReport> {
  const { manifest, driver, budget, outDir } = options;
  await mkdir(outDir, { recursive: true });
  const save = (name: string, data: unknown) => writeFile(path.join(outDir, name), JSON.stringify(data, null, 2));
  const timings: RunReport["timings"] = [];
  const timed = stageTimer(budget, timings);
  const expectedSha = options.allowShaMismatch ? undefined : options.pullRequest.headSha;

  const report: RunReport = {
    ticketKey: options.ticket.key,
    pullRequest: {
      repo: options.pullRequest.repo,
      number: options.pullRequest.number,
      headSha: options.pullRequest.headSha,
      title: options.pullRequest.title,
    },
    environment: {
      baseUrl: manifest.baseUrl,
      commitEstablished: manifest.version ? undefined : options.app?.commitEstablished,
      instances: options.app?.instance ? "per-scenario" : "shared",
    },
    driver: driver.label,
    executionMode: driver.live ? "autonomous" : "recorded",
    context: { docs: [], changedFiles: [], omitted: [] },
    analysis: { featureSummary: "", requirements: [], ambiguities: [], risks: [] },
    analysisNotes: [],
    plan: { scenarios: [], notes: [], clarifications: [] },
    results: [],
    confirmations: {},
    timings,
    startedAt: new Date().toISOString(),
    ticketHash: ticketHash(options.ticket),
  };
  const finish = (stopped?: string) => writeRun(outDir, { ...report, stopped, usage: budget.summary() });

  let runnable: Scenario[];
  try {
    const context = await timed("ingest", () =>
      buildContext(options.ticket, options.pullRequest, manifest, options.manifestFile, options.authority),
    );
    await save("context.json", context);
    report.context = {
      docs: context.docs.map((d) => d.path),
      changedFiles: context.pullRequest.files.map((f) => f.path),
      omitted: context.omitted,
      sources: context.sources.map((s) => ({ id: s.id, kind: s.kind, trust: s.trust, origin: s.origin, basis: s.basis, sha256: s.sha256, identity: s.identity })),
      owners: options.authority.authority.requirementOwners,
      docChanges: context.docChanges,
      approvals: context.approvals,
      authorityNotices: [...(options.authorityNotices ?? []), ...context.authorityNotices],
      protectedRevision: context.protectedRevision,
    };
    // Changes whenever an authoritative source changes, and only then.
    report.ticketHash = fingerprint(context.sources);

    const appMap = await timed("discover", () => discover(manifest, driver, path.join(outDir, "discovery")));
    await save("appmap.json", appMap);

    const analysed = await timed("analyse", () => analyse(context, appMap, manifest, driver));
    report.analysis = analysed.analysis;
    report.analysisNotes = analysed.notes;
    await save("analysis.json", analysed);

    report.plan = await timed("plan", () =>
      makePlan(context, report.analysis, appMap, manifest, driver, options.maxScenarios),
    );
    await save("plan.json", report.plan);
    runnable = report.plan.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario);
  } catch (error) {
    // Nothing was executed, so there is nothing to pass or fail: say why.
    return finish(`Stopped before execution: ${(error as Error).message.split("\n")[0]}`);
  }

  report.results = await timed("execute", () =>
    pool(runnable, options.concurrency, async (scenario) => {
      const over = budget.exceeded();
      if (over) return notExecuted(scenario, manifest, `the run's ${over}.`);
      return runScenario({
        scenario,
        manifest,
        expectedSha,
        app: options.app,
        outDir: path.join(outDir, "scenarios", scenario.id),
        mode: { kind: "agent", driver },
      });
    }),
  );
  report.environment.deployedSha = report.results.find((r) => r.environment.deployedSha)?.environment.deployedSha;

  // Replaying a failure shows whether it repeats: the same steps, the same
  // locators. It does not show that the locators were right, so it is reported
  // as repeatability and never as confirmation of a defect.
  await timed("confirm", async () => {
    for (const result of report.results.filter((r) => r.verdict === "failed")) {
      const scenario = runnable.find((s) => s.id === result.scenarioId)!;
      const replay = await runScenario({
        scenario,
        manifest,
        expectedSha,
        app: options.app,
        outDir: path.join(outDir, "confirmations", scenario.id),
        mode: { kind: "replay", steps: result.steps },
      });
      report.confirmations[scenario.id] =
        replay.verdict === "failed" ? "reproduced" : replay.verdict === "passed" ? "not reproduced" : "replay diverged";
    }
    // A scenario that got no verdict and met an error answer of the
    // application is repeated the same way. If the same steps meet the same
    // error, the application stopped the scenario: that is a finding, not a
    // gap of the test. Seen once only, it stays on record and changes nothing.
    for (const result of report.results.filter((r) => (r.verdict === "blocked" || r.verdict === "unverified") && r.applicationErrors?.length)) {
      const scenario = runnable.find((s) => s.id === result.scenarioId)!;
      const replay = await runScenario({
        scenario,
        manifest,
        expectedSha,
        app: options.app,
        outDir: path.join(outDir, "confirmations", scenario.id),
        mode: { kind: "replay", steps: result.steps },
      });
      const errored = erroredVerdict(result, replay);
      if (errored) {
        result.verdict = errored.verdict;
        result.reason = errored.reason;
        report.confirmations[scenario.id] = "reproduced";
      }
    }
  });

  // Uncertainty is given one more attempt on a stronger model, within the
  // budget. Whatever comes back is judged by the same code as any other run:
  // an escalated run can end passed or failed only through its own recorded
  // comparisons, and if it settles nothing the first result stands as it was.
  if (options.escalation && driver.live) {
    await timed("escalate", async () => {
      report.escalations = [];
      for (const first of [...report.results]) {
        const scenario = runnable.find((s) => s.id === first.scenarioId)!;
        const why = needsEscalation(first, report.confirmations[first.scenarioId], scenario.assertions);
        if (!why) continue;
        if (budget.exceeded()) break;
        let second = await runScenario({
          scenario,
          manifest,
          expectedSha,
          app: options.app,
          outDir: path.join(outDir, "escalations", scenario.id),
          mode: { kind: "agent", driver, stage: "escalate" },
        });
        let confirmation: string | undefined;
        if (second.verdict === "failed") {
          const replay = await runScenario({
            scenario,
            manifest,
            expectedSha,
            app: options.app,
            outDir: path.join(outDir, "escalations", `${scenario.id}-repeat`),
            mode: { kind: "replay", steps: second.steps },
          });
          confirmation = replay.verdict === "failed" ? "reproduced" : replay.verdict === "passed" ? "not reproduced" : "replay diverged";
        }
        const conclusive = escalatedRunSettles(scenario.assertions, first, second, confirmation);
        // Whichever run is not kept stays on record whole: why it ended as it did, its steps and its comparisons.
        report.escalations.push({
          scenarioId: scenario.id,
          why,
          before: first.verdict,
          after: second.verdict,
          kept: conclusive ? "escalated run" : "first run",
          other: conclusive ? first : second,
        });
        if (!conclusive) {
          // The first result stands. But where the second attempt pointed at a
          // different element for the same fixed expectation and found it
          // matching, two locators disagree and neither reading settles the
          // comparison. It is set aside, on record, and the verdict is computed
          // again from what is left: never a pass, and still a failure if any
          // other comparison failed.
          const settled = setAsideDisagreements(scenario.assertions, first, second);
          if (settled) {
            report.results[report.results.indexOf(first)] = settled;
            if (settled.verdict !== "failed") delete report.confirmations[scenario.id];
          }
          continue;
        }
        second = { ...second, reason: `${second.reason} (re-run on the escalation model: ${why})` };
        report.results[report.results.indexOf(first)] = second;
        if (confirmation) report.confirmations[scenario.id] = confirmation as RunReport["confirmations"][string];
        else delete report.confirmations[scenario.id];
      }
    });
  }

  // Each mismatch is labelled with what stands behind it: the application's
  // own API response, a second comparison through another target, a second
  // attempt that found its own way to the value, or one page reading alone.
  for (const result of report.results.filter((r) => r.verdict === "failed")) {
    const assertions = runnable.find((s) => s.id === result.scenarioId)?.assertions ?? [];
    const other = report.escalations?.find((e) => e.scenarioId === result.scenarioId)?.other;
    const standing = standings(assertions, result, other);
    result.assertionResults = result.assertionResults.map((r) => (standing.has(r.assertionId) ? { ...r, standing: standing.get(r.assertionId) } : r));
  }

  const over = budget.exceeded();
  return finish(over ? `The run's ${over}; scenarios not started by then are listed as unverified.` : undefined);
}

/**
 * Re-runs a previous run's executed scenarios against the current build:
 * first by replaying the recorded steps, and with the model only where the
 * recording no longer fits the application. Produces a run report of the
 * same shape, carrying over the earlier analysis and plan.
 */
export async function retestRun(options: {
  previous: RunReport;
  pullRequest: PullRequest;
  manifest: Manifest;
  driver: Driver;
  budget: Budget;
  outDir: string;
  concurrency: number;
  allowShaMismatch?: boolean;
  app?: AppAccess;
}): Promise<RunReport> {
  const { previous, manifest, driver, budget, outDir } = options;
  await mkdir(outDir, { recursive: true });
  const timings: RunReport["timings"] = [];
  const timed = stageTimer(budget, timings);
  const expectedSha = options.allowShaMismatch ? undefined : options.pullRequest.headSha;
  const rows: NonNullable<RunReport["retestOf"]>["rows"] = [];

  const results = await timed("retest", () =>
    pool(previous.results, options.concurrency, async (before) => {
      const scenario = previous.plan.scenarios.find((s) => s.scenario.id === before.scenarioId)!.scenario;
      const base = { scenario, manifest, expectedSha, app: options.app };
      let how: "replay" | "model" = "replay";
      let after =
        before.steps.length > 0
          ? await runScenario({
              ...base,
              outDir: path.join(outDir, "scenarios", scenario.id),
              mode: { kind: "replay", steps: before.steps },
            })
          : notExecuted(scenario, manifest, "the earlier run recorded no steps for it.");
      if (after.verdict === "unverified" || after.verdict === "blocked") {
        const over = budget.exceeded();
        if (over) {
          after = notExecuted(scenario, manifest, `its recording no longer fits, and the run's ${over}.`);
        } else {
          how = "model";
          after = await runScenario({
            ...base,
            outDir: path.join(outDir, "scenarios", scenario.id),
            mode: { kind: "agent", driver },
          });
        }
      }
      rows.push({ scenarioId: scenario.id, before: before.verdict, after: after.verdict, how });
      return after;
    }),
  );
  rows.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId, undefined, { numeric: true }));

  const over = budget.exceeded();
  return writeRun(outDir, {
    ...previous,
    pullRequest: {
      repo: options.pullRequest.repo,
      number: options.pullRequest.number,
      headSha: options.pullRequest.headSha,
      title: options.pullRequest.title,
    },
    environment: { baseUrl: manifest.baseUrl, deployedSha: results.find((r) => r.environment.deployedSha)?.environment.deployedSha },
    driver: driver.label,
    executionMode: driver.live ? "replay" : "recorded",
    results,
    confirmations: {},
    timings,
    startedAt: new Date().toISOString(),
    usage: budget.summary(),
    stopped: over ? `The run's ${over}.` : undefined,
    retestOf: { headSha: previous.pullRequest.headSha, rows },
  });
}
