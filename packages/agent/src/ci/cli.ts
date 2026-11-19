#!/usr/bin/env -S npx tsx
/**
 * Command-line entry for the GitHub Actions adapter. Kept apart from the
 * engine's own CLI: the engine knows nothing about CI, and CI adds nothing
 * to how requirements are analysed or tests are run.
 */
import { assess, headline } from "../report/readiness.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_LIMITS } from "../budget.ts";
import { loadPullRequest } from "../ingest/github.ts";
import { ciBuild } from "./build.ts";
import { publish } from "./report.ts";
import { ciRun } from "./run.ts";

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
};

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "pr-dir": { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      out: { type: "string", default: "releaseproof-out" },
      dockerfile: { type: "string", default: "ci/sandbox/Dockerfile.node" },
      incoming: { type: "string" },
      event: { type: "string" },
      "head-branch": { type: "string" },
      "head-sha": { type: "string" },
      "default-branch": { type: "string" },
      previous: { type: "string" },
      full: { type: "boolean", default: false },
      tickets: { type: "string", default: "eval/tickets" },
      recordings: { type: "string", default: "eval/recordings" },
      "max-usd": { type: "string" },
      "max-tokens": { type: "string" },
      "max-minutes": { type: "string" },
      "max-scenarios": { type: "string" },
      concurrency: { type: "string" },
      result: { type: "string" },
      "run-url": { type: "string", default: "" },
      "trusted-root": { type: "string" },
      "image-sha256": { type: "string" },
      "verify-only": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];

  // The commit the code host reports for a pull request, for the build job to fetch.
  if (command === "head") {
    if (!/^[1-9]\d{0,8}$/.test(values.pr ?? "")) throw new Error("Not a pull request number.");
    const pullRequest = await loadPullRequest(values.repo!, Number(values.pr));
    if (!/^[0-9a-f]{40}$/.test(pullRequest.headSha)) throw new Error("The code host reported no commit for the pull request.");
    console.log(pullRequest.headSha);
    return 0;
  }

  if (command === "build") {
    const meta = await ciBuild({
      prDir: values["pr-dir"]!,
      repo: values.repo!,
      pr: Number(values.pr),
      outDir: values.out,
      dockerfile: values.dockerfile,
    });
    console.log(meta.skip ? `Nothing built: ${meta.skip}` : `Built ${meta.appDir} at ${meta.headSha}`);
    return 0;
  }

  if (command === "run") {
    const result = await ciRun({
      incoming: values.incoming!,
      outDir: values.out,
      repo: values.repo!,
      trigger: {
        event: values.event!,
        headBranch: values["head-branch"]!,
        headSha: values["head-sha"]!,
        defaultBranch: values["default-branch"]!,
      },
      ticketsDir: values.tickets,
      // The application repository's default branch, checked out by the QA
      // workflow. Where the engine and the application share a repository,
      // that is the directory this runs from.
      trustedRoot: values["trusted-root"] ? path.resolve(values["trusted-root"]) : process.cwd(),
      imageSha256: values["image-sha256"],
      verifyOnly: values["verify-only"],
      recordingsDir: values.recordings,
      previousRun: values.previous,
      full: values.full,
      limits: {
        maxUsd: number(values["max-usd"], DEFAULT_LIMITS.maxUsd),
        maxTokens: number(values["max-tokens"], DEFAULT_LIMITS.maxTokens),
        maxMinutes: number(values["max-minutes"], DEFAULT_LIMITS.maxMinutes),
      },
      maxScenarios: number(values["max-scenarios"], 10),
      concurrency: number(values.concurrency, 3),
    });
    console.log(`${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    if (result.isolation) console.log(`isolation: ${JSON.stringify(result.isolation)}`);
    if (result.run?.usage) {
      console.log(`usage: ${JSON.stringify(result.run.usage.total)} about $${result.run.usage.estimatedUsd}`);
      for (const [stage, u] of Object.entries(result.run.usage.byStage)) console.log(`usage in ${stage}: ${JSON.stringify(u)}`);
      for (const e of result.run.usage.apiErrors) console.log(`api error in ${e.stage}: ${e.error}`);
    }
    if (result.run) {
      const a = assess(result.run);
      console.log(headline(a));
      for (const reason of a.reasons) console.log(`readiness: ${reason}`);
      console.log(`requirements: ${JSON.stringify(a.counts)}`);
      for (const r of a.requirements.filter((x) => x.status !== "verified")) console.log(`requirement ${r.id} ${r.status}`);
      for (const r of result.run.results) console.log(`scenario ${r.scenarioId} ${r.verdict}`);
      for (const [id, outcome] of Object.entries(result.run.confirmations ?? {})) console.log(`replay of ${id}: ${outcome}`);
    }
    if (result.run) console.log(`execution mode: ${result.run.executionMode}; timings: ${result.run.timings.map((t) => `${t.stage} ${t.seconds}s`).join(", ")}`);
    // A verification that did not pass must be visible as a failed job: nothing else reports it.
    if (values["verify-only"] && result.status === "error") return 1;
    // Otherwise the job succeeds whenever a result was produced; the verdict is the report's to give.
    return 0;
  }

  if (command === "report") {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set.");
    const raw = JSON.parse(await readFile(values.result!, "utf8"));
    const rendered = await publish(raw, values["run-url"], token);
    await writeFile(path.join(path.dirname(values.result!), "comment.md"), rendered.body);
    console.log(`${rendered.conclusion}: ${rendered.title} (${rendered.posted.join(", ") || "nothing posted"})`);
    return 0;
  }

  console.error("Usage: ci head | build | run | report (see .github/workflows/releaseproof-*.yml)");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
