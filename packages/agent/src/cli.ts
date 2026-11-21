#!/usr/bin/env -S npx tsx
import { parse as parseYaml } from "yaml";
import type { AuthorityInputs } from "./ingest/context.ts";
import { AUTHORITY_FILE, readProtectedRef, sameAsRevision } from "./protected.ts";
import { Authority, NO_AUTHORITY } from "./sources.ts";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { BridgeDriver } from "./drivers/bridge.ts";
import { ApiDriver, type Driver } from "./drivers/driver.ts";
import { routingFromEnv } from "./routing.ts";
import { loadManifest } from "./env.ts";
import { runScenario } from "./execute/run.ts";
import { loadPullRequest, loadPullRequestComments, loadPullRequestCommits, loadPullRequestFile } from "./ingest/github.ts";
import { loadTicketWithProvenance, type LoadedTicket } from "./ingest/jira.ts";
import { retestRun, runPipeline } from "./pipeline.ts";
import { Budget, DEFAULT_LIMITS, DEFAULT_PRICES } from "./budget.ts";
import { RecordedDriver } from "./drivers/recorded.ts";
import { headline } from "./report/readiness.ts";
import { coverage } from "./report/run.ts";
import { authoriseForExecution, authoriseRemoteRun, directoryLedger, loadTrustedKeys, unexpected } from "./remote/authority.ts";
import { loadRemoteRecording, runRemote, unsupported } from "./remote/run.ts";
import { loadRemoteRequest, RemoteRequestRefused } from "./remote/request.ts";
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
  releaseproof check-remote-request <request.json> --approvals <file> --authority-keys <file>
        --expect-run <id> --expect-workspace <id> --expect-project <id>
        check whether a remote run request is sound and approved: its format,
        its target, every criteria snapshot against its hash, that it is the
        run the caller asked for, and that the control plane approved each
        snapshot for this run. No model, no browser. It starts nothing
  releaseproof run-remote <request.json> --approvals <file> --authority-keys <file>
        --expect-run <id> --expect-workspace <id> --expect-project <id>
        --ledger <dir> --recording <file> --out <dir> [--target-manifest <file>]
        run an approved remote request against its target from a recording.
        The run is claimed in the ledger and starts once. No model is called.
        --allow-local-target accepts a target named "localhost", for a trial
        against an application on this machine
  releaseproof check-remote-request <request.json> --integrity-only
        format, target and hashes only. Authority is NOT checked

Options:
  --driver api|bridge|recorded   how the model is attached (default api)
  --recording <run.json>         recorded: an earlier run to replay instead of a live model
  --max-usd, --max-tokens, --max-minutes   run budget (defaults 2, 3000000, 25)
  --port <n>            bridge: port to serve jobs on (default 4200)
  --base-url <url>      override the manifest's baseUrl
  --expect-sha <sha>    refuse to run unless the environment reports this commit
  --allow-sha-mismatch  run: do not require the pull request's head commit
  --out <dir>           output directory (default runs/<timestamp>)
  --max-scenarios <n>   run: plan size limit (default 10)
  --concurrency <n>     scenarios executed at once (default 3)
  --base-ref <ref>      run: git ref holding the approved documents, the owner list and
                        the ticket file (default origin/HEAD). Requirements are trusted
                        only as that revision has them
  --trust-local-docs    run: development mode. Treat the local ticket file and documents as
                        approved. The report says so; this never establishes trusted
                        requirements and is not available in CI
  --steps <file>        replay: a step array, or a result.json containing steps
  --confirm             run-scenario: replay a failure once without the model

Environment:
  RELEASEPROOF_MODEL_<STAGE>, RELEASEPROOF_EFFORT_<STAGE>   api driver, per stage
      (ANALYSE, PLAN: claude-sonnet-5-5; DISCOVER, EXECUTE: claude-haiku-5-5; ESCALATE: claude-sonnet-5-5)
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

/**
 * Works out, for a command-line run, where requirements may come from. With a
 * resolvable base ref, only what that revision holds is approved. Without
 * one, local files are unverified unless the development-mode flag is given.
 */
async function establishAuthority(
  loaded: LoadedTicket,
  manifestFile: string,
  options: { baseRef?: string; trustLocalDocs: boolean; repo?: string; pr?: number },
): Promise<{ inputs: AuthorityInputs; notices: string[] }> {
  const notices: string[] = [];
  const material =
    (await readProtectedRef(manifestFile, options.baseRef ?? "origin/HEAD")) ??
    (options.baseRef ? undefined : await readProtectedRef(manifestFile, "origin/main"));
  if (options.baseRef && !material) notices.push(`The base ref "${options.baseRef}" could not be resolved.`);
  if (material) notices.push(...material.notices);
  else notices.push("No protected revision could be established: local documents are unverified.");

  let ticketProvenance: AuthorityInputs["ticketProvenance"];
  if (loaded.via === "jira-api") ticketProvenance = { via: "jira-api", site: loaded.site };
  else if (material && (await sameAsRevision(loaded.path, material.revision))) {
    ticketProvenance = { via: "protected-file", revision: material.revision, path: loaded.path };
  } else ticketProvenance = { via: "local-file", path: loaded.path, trustedByFlag: options.trustLocalDocs };

  // In development mode the local owner list is read too, so that fixture comments can be exercised.
  let authority = material?.authority ?? NO_AUTHORITY;
  if (options.trustLocalDocs && !material) {
    const top = path.resolve(path.dirname(manifestFile));
    for (let dir = top; ; dir = path.dirname(dir)) {
      const text = await readFile(path.join(dir, AUTHORITY_FILE), "utf8").catch(() => null);
      if (text !== null) {
        const parsed = Authority.safeParse(parseYaml(text) ?? {});
        if (parsed.success) authority = parsed.data;
        break;
      }
      if (dir === path.dirname(dir)) break;
    }
  }

  let comments: AuthorityInputs["comments"];
  let commits: AuthorityInputs["commits"];
  if (options.repo && options.pr) {
    try {
      comments = await loadPullRequestComments(options.repo, options.pr);
      commits = await loadPullRequestCommits(options.repo, options.pr);
    } catch {
      notices.push("Comments on the pull request could not be read, so no approval command was considered.");
    }
  }
  return {
    inputs: {
      ticketProvenance,
      authority,
      protectedRevision: material?.revision ?? "none established",
      approvedDocs: material?.approvedDocs ?? [],
      comments,
      commits,
      trustLocalDocs: options.trustLocalDocs,
    },
    notices,
  };
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
      "base-ref": { type: "string" },
      "trust-local-docs": { type: "boolean", default: false },
      approvals: { type: "string" },
      "authority-keys": { type: "string" },
      "integrity-only": { type: "boolean", default: false },
      ledger: { type: "string" },
      "allow-local-target": { type: "boolean", default: false },
      "target-manifest": { type: "string" },
      "expect-run": { type: "string" },
      "expect-workspace": { type: "string" },
      "expect-project": { type: "string" },
    },
  });
  const [command, scenarioFile] = positionals;

  // A remote run. It takes no model driver, so nothing here can call a model:
  // decisions come from a recording, checked like any model's answer.
  if (command === "run-remote") {
    const need = ["approvals", "authority-keys", "expect-run", "expect-workspace", "expect-project", "ledger", "recording", "out"] as const;
    const missing = need.filter((name) => !values[name]);
    if (!scenarioFile || missing.length > 0) {
      console.error(`run-remote needs a request file and ${need.map((name) => `--${name}`).join(", ")}. Missing: ${missing.map((name) => `--${name}`).join(", ") || "the request file"}.`);
      if (missing.includes("recording")) console.error("A run from a remote request with a live model is not available yet.");
      return 2;
    }
    try {
      // A target on this machine is accepted only when asked for by name, for a trial here.
      const local = values["allow-local-target"] === true;
      const admitted = await loadRemoteRequest(scenarioFile, new Date(), { allowLocalTarget: local });
      if (local) console.log("A target on this machine is allowed for this run. This is for trials here only.");
      // Found before the run is claimed, so a refusal here uses nothing up.
      const cannot = unsupported(admitted);
      if (cannot.length > 0) throw new RemoteRequestRefused(cannot);
      const recording = await loadRemoteRecording(values.recording!);
      let trusted: Awaited<ReturnType<typeof loadTrustedKeys>>;
      let evidence: unknown;
      let ledger: ReturnType<typeof directoryLedger>;
      try {
        trusted = await loadTrustedKeys(values["authority-keys"]!);
      } catch (error) {
        console.error(`The trusted keys could not be read: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
        return 2;
      }
      try {
        evidence = JSON.parse(await readFile(values.approvals!, "utf8")) as unknown;
      } catch {
        console.error("The approvals file could not be read as JSON.");
        return 2;
      }
      try {
        ledger = directoryLedger(values.ledger!);
      } catch (error) {
        console.error(`The ledger could not be opened: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
        return 2;
      }
      // Everything that can fail for a plain reason is done before the run is claimed.
      // Never the default manifest of whatever directory this runs in: only one named for the target.
      let targetManifest: Awaited<ReturnType<typeof loadManifest>> | undefined;
      try {
        if (values["target-manifest"]) targetManifest = await loadManifest(values["target-manifest"], admitted.request.target.baseUrl);
      } catch {
        console.error("The target manifest could not be read.");
        return 2;
      }
      try {
        await mkdir(values.out!, { recursive: true });
      } catch {
        console.error("The output directory could not be created.");
        return 2;
      }
      const startable = authoriseForExecution(admitted, evidence, trusted, {
        expected: { runId: values["expect-run"]!, workspaceId: values["expect-workspace"]!, projectId: values["expect-project"]! },
        ledger,
      });
      const run = await runRemote({ run: startable, recording, manifest: targetManifest, outDir: values.out! });
      console.log(`Run ${run.runId} against ${run.target.baseUrl}: ${run.results.length} ${run.results.length === 1 ? "scenario" : "scenarios"} recorded, from a recording, with no model.`);
      for (const result of run.results) console.log(`  ${result.scenarioId}  ${result.verdict}  ${result.reason}`);
      if (run.endedEarly) console.log(`Ended early: ${run.endedEarly.reason}`);
      console.log(`Written to ${path.join(values.out!, "remote-run.json")}. No run-level verdict is stated yet.`);
      return 0;
    } catch (error) {
      if (!(error instanceof RemoteRequestRefused)) throw error;
      console.error(error.message);
      return 2;
    }
  }

  // Decided before anything else is loaded: no manifest, no driver, no model.
  if (command === "check-remote-request") {
    if (!scenarioFile) {
      console.error("check-remote-request needs a request file");
      return 2;
    }
    try {
      const admitted = await loadRemoteRequest(scenarioFile);
      const { request } = admitted;
      // Authority is checked unless the caller says, in so many words, not to.
      // A flag that is absent or empty is never read as that.
      if (values["integrity-only"]) {
        if (values.approvals !== undefined || values["authority-keys"] !== undefined) {
          console.error("--integrity-only is not given together with --approvals or --authority-keys");
          return 2;
        }
        console.log(`Run ${request.runId} against ${request.target.baseUrl}: the request is well formed and every snapshot matches its hash.`);
        for (const snapshot of admitted.snapshots) {
          console.log(`  criteria ${snapshot.id}  sha256 ${snapshot.sha256}  approver as claimed: ${snapshot.approvedBy} at ${snapshot.approvedAt} (not verified)`);
        }
        console.log("Integrity only: authority was NOT checked. Nothing here says the control plane approved these criteria.");
        return 0;
      }
      if (!values.approvals || !values["authority-keys"]) {
        console.error("check-remote-request needs --approvals and --authority-keys, each naming a file. To check integrity alone, give --integrity-only.");
        return 2;
      }
      // Which run the caller asked for is stated by the caller, never read from the request.
      const expected = { runId: values["expect-run"], workspaceId: values["expect-workspace"], projectId: values["expect-project"] };
      if (!expected.runId || !expected.workspaceId || !expected.projectId) {
        console.error("check-remote-request needs --expect-run, --expect-workspace and --expect-project: the run its caller asked for.");
        return 2;
      }
      const mismatch = unexpected(admitted, expected as { runId: string; workspaceId: string; projectId: string });
      if (mismatch.length > 0) throw new RemoteRequestRefused(mismatch);
      // The keys come from this command's caller, never from the request.
      let trusted: Awaited<ReturnType<typeof loadTrustedKeys>>;
      let evidence: unknown;
      try {
        trusted = await loadTrustedKeys(values["authority-keys"]);
      } catch (error) {
        console.error(`The trusted keys could not be read: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
        return 2;
      }
      try {
        evidence = JSON.parse(await readFile(values.approvals, "utf8")) as unknown;
      } catch {
        console.error("The approvals file could not be read as JSON.");
        return 2;
      }
      const authorised = authoriseRemoteRun(admitted, evidence, trusted);
      console.log(`Run ${request.runId} against ${request.target.baseUrl}: every snapshot matches its hash and is approved for this run.`);
      for (const snapshot of authorised.snapshots) {
        console.log(`  criteria ${snapshot.id}  sha256 ${snapshot.sha256}  approved by ${snapshot.authority.approvedBy}, signed by key ${snapshot.authority.keyId}`);
      }
      console.log("This is a check. It starts nothing and claims nothing: a run is claimed when it starts, and starts once.");
      return 0;
    } catch (error) {
      if (!(error instanceof RemoteRequestRefused)) throw error;
      console.error(error.message);
      return 2;
    }
  }

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
    return new ApiDriver({ routing: routingFromEnv(process.env), budget });
  };

  if (command === "run") {
    if (!values.ticket || !(values["pr-file"] || (values.repo && values.pr))) {
      console.error("run needs --ticket, and either --repo with --pr or --pr-file");
      return 2;
    }
    const loaded = await loadTicketWithProvenance(values.ticket);
    const ticket = loaded.ticket;
    const pullRequest = values["pr-file"]
      ? await loadPullRequestFile(values["pr-file"])
      : await loadPullRequest(values.repo!, Number(values.pr));
    const authority = await establishAuthority(loaded, values.manifest, {
      baseRef: values["base-ref"],
      trustLocalDocs: values["trust-local-docs"],
      repo: values["pr-file"] ? undefined : values.repo,
      pr: values["pr-file"] ? undefined : Number(values.pr),
    });
    for (const notice of authority.notices) console.log(`requirements: ${notice}`);
    const driver = await makeDriver();
    try {
      const report = await runPipeline({
        ticket,
        pullRequest,
        manifest,
        manifestFile: values.manifest,
        authority: authority.inputs,
        authorityNotices: authority.notices,
        driver,
        budget,
        outDir,
        maxScenarios: Number(values["max-scenarios"]),
        concurrency: Number(values.concurrency),
        allowShaMismatch: values["allow-sha-mismatch"],
        escalation: process.env.RELEASEPROOF_ESCALATION !== "off",
      });
      const { documented, covered, assessment } = coverage(report);
      const count = (v: string) => report.results.filter((r) => r.verdict === v).length;
      console.log(`\n${headline(assessment)}`);
      console.log(
        `\n${report.ticketKey}: ${count("passed")} passed, ${count("failed")} failed, ${count("errored")} application errors, ${count("blocked")} blocked, ${count("unverified")} unverified; ${report.plan.scenarios.filter((s) => s.status === "blocked").length} not run; ${covered}/${documented.length} documented requirements compared`,
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
