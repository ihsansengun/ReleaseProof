import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyse } from "./analyse.ts";
import { discover } from "./discover.ts";
import type { Driver } from "./drivers/driver.ts";
import { runScenario } from "./execute/run.ts";
import { buildContext } from "./ingest/context.ts";
import { plan as makePlan } from "./plan.ts";
import { renderRunReport } from "./report/run.ts";
import type { Manifest, PullRequest, RunReport, ScenarioResult, Ticket } from "./schema.ts";

export type PipelineOptions = {
  ticket: Ticket;
  pullRequest: PullRequest;
  manifest: Manifest;
  manifestFile: string;
  driver: Driver;
  outDir: string;
  maxScenarios: number;
  concurrency: number;
  /** Skip the check that the environment runs the pull request's head commit. */
  allowShaMismatch?: boolean;
};

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

/**
 * Ticket and pull request in, executed and evidenced test results out.
 * Each stage's output is written to disk as it completes.
 */
export async function runPipeline(options: PipelineOptions): Promise<RunReport> {
  const { manifest, driver, outDir } = options;
  await mkdir(outDir, { recursive: true });
  const save = (name: string, data: unknown) => writeFile(path.join(outDir, name), JSON.stringify(data, null, 2));
  const timings: RunReport["timings"] = [];
  const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await work();
    } finally {
      timings.push({ stage, seconds: Math.round((Date.now() - start) / 100) / 10 });
      console.log(`[${stage}] ${timings.at(-1)!.seconds}s`);
    }
  };
  const startedAt = new Date().toISOString();
  const expectedSha = options.allowShaMismatch ? undefined : options.pullRequest.headSha;

  const context = await timed("ingest", () =>
    buildContext(options.ticket, options.pullRequest, manifest, options.manifestFile),
  );
  await save("context.json", context);

  const appMap = await timed("discover", () => discover(manifest, driver, path.join(outDir, "discovery")));
  await save("appmap.json", appMap);

  const { analysis, notes: analysisNotes } = await timed("analyse", () => analyse(context, appMap, manifest, driver));
  await save("analysis.json", { analysis, notes: analysisNotes });

  const plan = await timed("plan", () => makePlan(context, analysis, appMap, manifest, driver, options.maxScenarios));
  await save("plan.json", plan);

  const runnable = plan.scenarios.filter((s) => s.status === "runnable").map((s) => s.scenario);
  const results = await timed("execute", () =>
    pool(runnable, options.concurrency, (scenario) =>
      runScenario({
        scenario,
        manifest,
        expectedSha,
        outDir: path.join(outDir, "scenarios", scenario.id),
        mode: { kind: "agent", driver },
      }),
    ),
  );

  // A failure counts as confirmed only if the recorded steps fail again with
  // no model involved.
  const confirmations: RunReport["confirmations"] = {};
  await timed("confirm", async () => {
    for (const result of results.filter((r) => r.verdict === "failed")) {
      const scenario = runnable.find((s) => s.id === result.scenarioId)!;
      const replay = await runScenario({
        scenario,
        manifest,
        expectedSha,
        outDir: path.join(outDir, "confirmations", scenario.id),
        mode: { kind: "replay", steps: result.steps },
      });
      confirmations[scenario.id] =
        replay.verdict === "failed" ? "reproduced" : replay.verdict === "passed" ? "not reproduced" : "replay diverged";
    }
  });

  const report: RunReport = {
    ticketKey: options.ticket.key,
    pullRequest: {
      repo: options.pullRequest.repo,
      number: options.pullRequest.number,
      headSha: options.pullRequest.headSha,
      title: options.pullRequest.title,
    },
    environment: { baseUrl: manifest.baseUrl, deployedSha: results[0]?.environment.deployedSha },
    driver: driver.label,
    context: {
      docs: context.docs.map((d) => d.path),
      changedFiles: context.pullRequest.files.map((f) => f.path),
      omitted: context.omitted,
    },
    analysis,
    analysisNotes,
    plan,
    results,
    confirmations,
    timings,
    startedAt,
  };
  await save("run.json", report);
  await writeFile(path.join(outDir, "report.md"), renderRunReport(report));
  return report;
}

export type RetestRow = { scenarioId: string; before: string; after: string; how: "replay" | "model"; reason: string };

/**
 * Re-runs a previous run's executed scenarios against the current build:
 * first by replaying the recorded steps, and with the model only where the
 * recording no longer fits the application.
 */
export async function retest(options: {
  previous: RunReport;
  manifest: Manifest;
  driver: Driver;
  outDir: string;
  expectedSha?: string;
  concurrency: number;
}): Promise<{ rows: RetestRow[]; results: ScenarioResult[] }> {
  const { previous, manifest, driver, outDir } = options;
  await mkdir(outDir, { recursive: true });
  const rows: RetestRow[] = [];
  const results = await pool(previous.results, options.concurrency, async (before) => {
    const scenario = previous.plan.scenarios.find((s) => s.scenario.id === before.scenarioId)!.scenario;
    const base = { scenario, manifest, expectedSha: options.expectedSha };
    let after = await runScenario({
      ...base,
      outDir: path.join(outDir, "replay", scenario.id),
      mode: { kind: "replay", steps: before.steps },
    });
    let how: RetestRow["how"] = "replay";
    if (after.verdict === "unverified" || after.verdict === "blocked") {
      how = "model";
      after = await runScenario({
        ...base,
        outDir: path.join(outDir, "model", scenario.id),
        mode: { kind: "agent", driver },
      });
    }
    rows.push({ scenarioId: scenario.id, before: before.verdict, after: after.verdict, how, reason: after.reason });
    return after;
  });
  rows.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId, undefined, { numeric: true }));
  await writeFile(path.join(outDir, "retest.json"), JSON.stringify({ rows, results }, null, 2));
  const lines = [
    `# Retest of ${previous.ticketKey} (pull request #${previous.pullRequest.number})`,
    "",
    "| Scenario | Before | After | Re-run by | Detail |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.scenarioId} | ${r.before} | ${r.after} | ${r.how} | ${r.reason.replace(/\|/g, "\\|")} |`),
    "",
  ];
  await writeFile(path.join(outDir, "retest.md"), lines.join("\n"));
  return { rows, results };
}
