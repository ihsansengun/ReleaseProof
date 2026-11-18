#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { BridgeDriver } from "./drivers/bridge.ts";
import { ApiDriver, type Driver } from "./drivers/driver.ts";
import { loadManifest } from "./env.ts";
import { runScenario } from "./execute/run.ts";
import { loadPullRequest, loadPullRequestFile } from "./ingest/github.ts";
import { loadTicket } from "./ingest/jira.ts";
import { retestRun, runPipeline } from "./pipeline.ts";
import { Budget, DEFAULT_LIMITS, DEFAULT_PRICES } from "./budget.ts";
import { RecordedDriver } from "./drivers/recorded.ts";
import { coverage } from "./report/run.ts";
import { Scenario, Step, type RunReport, type ScenarioResult } from "./schema.ts";

const USAGE = `Usage:
  releaseproof run --ticket <file|key> (--repo <owner/name> --pr <n> | --pr-file <json>) --manifest <file>
        ticket + pull request -> discovery, analysis, plan, execution, report
  releaseproof retest --run <run.json> --repo <owner/name> --pr <n> --manifest <file>
        re-run a previous run's scenarios against the current build
  releaseproof run-scenario <scenario.json> --manifest <file>
        execute one scenario with a model
  releaseproof replay <scenario.json> --steps <file> --manifest <file>
        re-run recorded steps, no model

Options:
  --driver api|bridge|recorded   how the model is attached (default api)
  --recording <run.json>         recorded: an earlier run to replay instead of a live model
  --max-usd, --max-tokens, --max-minutes   run budget (defaults 8, 3000000, 25)
  --port <n>            bridge: port to serve jobs on (default 4200)
  --base-url <url>      override the manifest's baseUrl
  --expect-sha <sha>    refuse to run unless the environment reports this commit
  --allow-sha-mismatch  run: do not require the pull request's head commit
  --out <dir>           output directory (default runs/<timestamp>)
  --max-scenarios <n>   run: plan size limit (default 10)
  --concurrency <n>     scenarios executed at once (default 3)
  --steps <file>        replay: a step array, or a result.json containing steps
  --confirm             run-scenario: replay a failure once without the model

Environment:
  RELEASEPROOF_MODEL, RELEASEPROOF_EFFORT   api driver (default claude-opus-5-5, medium)
  GITHUB_TOKEN                              optional, for private repositories
  JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN when --ticket is a key, not a file`;

function printScenario(result: ScenarioResult, label = "") {
  console.log(`\n${result.scenarioId} ${result.title}${label}`);
  for (const r of result.assertionResults) {
    console.log(`  ${r.pass ? "match   " : "MISMATCH"} ${r.assertionId}: expected ${r.expected}, actual ${r.actual}`);
  }
  console.log(`  verdict: ${result.verdict.toUpperCase()} - ${result.reason}`);
  console.log(`  evidence: ${result.evidence.dir}`);
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: { type: "string", default: "releaseproof.yml" },
      "base-url": { type: "string" },
      "expect-sha": { type: "string" },
      "allow-sha-mismatch": { type: "boolean", default: false },
      out: { type: "string" },
      steps: { type: "string" },
      confirm: { type: "boolean", default: false },
      driver: { type: "string", default: "api" },
      port: { type: "string", default: "4200" },
      ticket: { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      "pr-file": { type: "string" },
      run: { type: "string" },
      "max-scenarios": { type: "string", default: "10" },
      "max-usd": { type: "string" },
      "max-tokens": { type: "string" },
      "max-minutes": { type: "string" },
      recording: { type: "string" },
      concurrency: { type: "string", default: "3" },
    },
  });
  const [command, scenarioFile] = positionals;
  if (!command || !["run", "retest", "run-scenario", "replay"].includes(command)) {
    console.error(USAGE);
    return 2;
  }

  const manifest = await loadManifest(values.manifest, values["base-url"]);
  const outDir = values.out ?? path.join("runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const budget = new Budget(
    {
      maxUsd: Number(values["max-usd"] ?? DEFAULT_LIMITS.maxUsd),
      maxTokens: Number(values["max-tokens"] ?? DEFAULT_LIMITS.maxTokens),
      maxMinutes: Number(values["max-minutes"] ?? DEFAULT_LIMITS.maxMinutes),
    },
    DEFAULT_PRICES,
  );
  const makeDriver = async (): Promise<Driver> => {
    if (values.driver === "bridge") {
      console.log(`Bridge: waiting for a model on http://127.0.0.1:${values.port} (POST /claim)`);
      return new BridgeDriver(Number(values.port), "external model via HTTP bridge");
    }
    if (values.driver === "recorded") {
      if (!values.recording) throw new Error("--driver recorded needs --recording <run.json>");
      return new RecordedDriver(JSON.parse(await readFile(values.recording, "utf8")) as RunReport);
    }
    const effort = (process.env.RELEASEPROOF_EFFORT ?? "medium") as "low" | "medium" | "high";
    return new ApiDriver({ model: process.env.RELEASEPROOF_MODEL ?? "claude-opus-5-5", effort, budget });
  };

  if (command === "run") {
    if (!values.ticket || !(values["pr-file"] || (values.repo && values.pr))) {
      console.error("run needs --ticket, and either --repo with --pr or --pr-file");
      return 2;
    }
    const ticket = await loadTicket(values.ticket);
    const pullRequest = values["pr-file"]
      ? await loadPullRequestFile(values["pr-file"])
      : await loadPullRequest(values.repo!, Number(values.pr));
    const driver = await makeDriver();
    try {
      const report = await runPipeline({
        ticket,
        pullRequest,
        manifest,
        manifestFile: values.manifest,
        driver,
        budget,
        outDir,
        maxScenarios: Number(values["max-scenarios"]),
        concurrency: Number(values.concurrency),
        allowShaMismatch: values["allow-sha-mismatch"],
      });
      const { documented, covered } = coverage(report);
      const count = (v: string) => report.results.filter((r) => r.verdict === v).length;
      console.log(
        `\n${report.ticketKey}: ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked, ${count("unverified")} unverified; ${report.plan.scenarios.filter((s) => s.status === "blocked").length} not run; ${covered}/${documented.length} documented requirements compared`,
      );
      console.log(`report: ${path.join(outDir, "report.md")}`);
      return count("failed") === 0 ? 0 : 1;
    } finally {
      await driver.close();
    }
  }

  if (command === "retest") {
    if (!values.run || !values.repo || !values.pr) {
      console.error("retest needs --run <run.json>, --repo and --pr");
      return 2;
    }
    const previous = JSON.parse(await readFile(values.run, "utf8")) as RunReport;
    const pullRequest = await loadPullRequest(values.repo, Number(values.pr));
    const driver = await makeDriver();
    try {
      const report = await retestRun({
        previous,
        pullRequest,
        manifest,
        driver,
        budget,
        outDir,
        concurrency: Number(values.concurrency),
        allowShaMismatch: values["allow-sha-mismatch"],
      });
      for (const r of report.retestOf!.rows) console.log(`${r.scenarioId}: ${r.before} -> ${r.after} (${r.how})`);
      console.log(`report: ${path.join(outDir, "report.md")}`);
      return report.results.some((r) => r.verdict === "failed") ? 1 : 0;
    } finally {
      await driver.close();
    }
  }

  if (!scenarioFile) {
    console.error(USAGE);
    return 2;
  }
  const scenario = Scenario.parse(JSON.parse(await readFile(scenarioFile, "utf8")));
  const base = { scenario, manifest, expectedSha: values["expect-sha"] };

  if (command === "replay") {
    if (!values.steps) {
      console.error("replay needs --steps <file>");
      return 2;
    }
    const raw = JSON.parse(await readFile(values.steps, "utf8"));
    const steps = Step.array().parse(Array.isArray(raw) ? raw : raw.steps);
    const result = await runScenario({ ...base, outDir: path.join(outDir, scenario.id), mode: { kind: "replay", steps } });
    printScenario(result, " (replay)");
    return result.verdict === "passed" ? 0 : 1;
  }

  const driver = await makeDriver();
  try {
    const result = await runScenario({ ...base, outDir: path.join(outDir, scenario.id), mode: { kind: "agent", driver } });
    printScenario(result);
    if (values.confirm && result.verdict === "failed") {
      const confirmation = await runScenario({
        ...base,
        outDir: path.join(outDir, `${scenario.id}-confirm`),
        mode: { kind: "replay", steps: result.steps },
      });
      printScenario(confirmation, " (confirmation replay)");
    }
    return result.verdict === "passed" ? 0 : 1;
  } finally {
    await driver.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Anthropic.APIError ? `API error ${error.status}: ${error.message}` : error);
    process.exit(2);
  },
);
