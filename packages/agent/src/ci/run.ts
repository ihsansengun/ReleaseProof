import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Budget, DEFAULT_PRICES, type Limits } from "../budget.ts";
import { ApiDriver, type Driver } from "../drivers/driver.ts";
import { RecordedDriver } from "../drivers/recorded.ts";
import { loadManifest } from "../env.ts";
import { hostEnv } from "../hostenv.ts";
import { loadPullRequest } from "../ingest/github.ts";
import { buildContext, type AuthorityInputs } from "../ingest/context.ts";
import { loadPullRequestComments, loadPullRequestCommits } from "../ingest/github.ts";
import {
  fileTicketProvider,
  jiraCloudProvider,
  loadFromProviders,
  takeJiraCredentials,
  type LoadedTicket,
  type TicketProvider,
} from "../ingest/jira.ts";
import { retestRun, runPipeline } from "../pipeline.ts";
import { readProtectedCheckout } from "../protected.ts";
import { fingerprint } from "../sources.ts";
import type { RunReport } from "../schema.ts";
import { IMAGE, probeIsolation, sandboxLogs, startSandbox, stopSandbox, type Isolation } from "./sandbox.ts";

const run = promisify(execFile);

/** What stage 1 says it built. Produced next to untrusted code, so every field is checked. */
export const Meta = z.object({
  pr: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  appDir: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]+$/)
    .refine((dir) => !dir.startsWith("/") && !dir.split("/").includes(".."))
    .optional(),
  skip: z.string().max(500).optional(),
});

export type CiResult = {
  status: "completed" | "skipped" | "error";
  reason?: string;
  repo: string;
  pr?: number;
  headSha?: string;
  isolation?: Isolation;
  run?: RunReport;
};

/** Limits asked for when a run was started by hand. They arrive with the build, so they are untrusted. */
const Requested = z
  .object({
    maxUsd: z.coerce.number().positive().optional().catch(undefined),
    maxMinutes: z.coerce.number().positive().optional().catch(undefined),
    maxScenarios: z.coerce.number().int().positive().optional().catch(undefined),
    disableFallbacks: z.coerce.string().optional().catch(undefined),
    executorModel: z.string().optional().catch(undefined),
  })
  .catch({});

/** Models a manual run may ask for as the executor. Anything else is ignored. */
export const EXECUTOR_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];

/**
 * Turns the application's log into lines that are safe to print in a job log:
 * bounded, without control characters, and prefixed so that no line can be
 * read by the runner as a workflow command.
 */
export function logTail(log: string, maxLines = 60, maxChars = 300): string[] {
  return log
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-maxLines)
    .map((line) => `app| ${line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, maxChars)}`);
}

/** A request may tighten the configured limits. It can never loosen them. */
export function tighten(
  base: { limits: Limits; maxScenarios: number },
  requested: unknown,
): { limits: Limits; maxScenarios: number; disableFallbacks: boolean; executorModel?: string } {
  const r = Requested.parse(requested ?? {});
  return {
    limits: {
      maxTokens: base.limits.maxTokens,
      maxUsd: Math.min(base.limits.maxUsd, r.maxUsd ?? Infinity),
      maxMinutes: Math.min(base.limits.maxMinutes, r.maxMinutes ?? Infinity),
    },
    maxScenarios: Math.min(base.maxScenarios, r.maxScenarios ?? Infinity),
    disableFallbacks: r.disableFallbacks === "true",
    executorModel: r.executorModel && EXECUTOR_MODELS.includes(r.executorModel) ? r.executorModel : undefined,
  };
}

/** Which model driver a run gets: live whenever a key is configured, recorded only without one. */
export function driverChoice(apiKey: string | undefined, recordingExists: boolean): "live" | "recorded" | "none" {
  if (apiKey && apiKey.trim() !== "") return "live";
  return recordingExists ? "recorded" : "none";
}

/** An earlier run can be re-run on a new commit only if a live model produced it. */
export function canRetest(previous: RunReport | undefined, pr: number, hash: string, full: boolean): boolean {
  return (
    !full &&
    previous !== undefined &&
    (previous.executionMode === "autonomous" || previous.executionMode === "replay") &&
    previous.pullRequest.number === pr &&
    previous.ticketHash === hash &&
    previous.results.some((r) => r.steps.length > 0)
  );
}

export type CiRunOptions = {
  incoming: string;
  outDir: string;
  repo: string;
  /** How the build that produced `incoming` was started. */
  trigger: { event: string; headBranch: string; headSha: string; defaultBranch: string };
  ticketsDir: string;
  /** This stage's own working copy of the default branch: the protected revision. */
  trustedRoot: string;
  recordingsDir: string;
  previousRun?: string;
  full: boolean;
  limits: Limits;
  maxScenarios: number;
  concurrency: number;
};

/** The first symbolic link (or other non-regular entry) under a directory, if any. */
export async function firstSymlink(dir: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await firstSymlink(full);
      if (inner) return inner;
    } else if (!entry.isFile()) return full;
  }
  return undefined;
}

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

/**
 * Stage 2. Runs trusted code only. Checks where its inputs came from, starts
 * the application image in the sandbox, verifies the sandbox, and runs the
 * pipeline against it. Always returns a result that says what happened.
 */
export async function ciRun(options: CiRunOptions): Promise<CiResult> {
  const result: CiResult = { status: "error", repo: options.repo };
  const finish = async (status: CiResult["status"], reason?: string) => {
    result.status = status;
    result.reason = reason;
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, "ci-result.json"), JSON.stringify(result, null, 2));
    return result;
  };

  // Credentials are taken out of this process's environment as soon as they
  // are read. Everything started later (container client, browser, probes)
  // also gets an allow-listed environment, so this is the second of two locks.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const jira = takeJiraCredentials(process.env);

  try {
    // The hand-off is plain files. A link in it could point anywhere on this
    // machine, which holds the model key, so its presence ends the run.
    const link = await firstSymlink(options.incoming);
    if (link) return finish("error", "The build's hand-off contains a symbolic link; nothing was read from it.");
    const parsed = Meta.safeParse(JSON.parse(await readFile(path.join(options.incoming, "meta.json"), "utf8")));
    if (!parsed.success) return finish("error", "The build stage's description of what it built is malformed.");
    const meta = parsed.data;
    result.pr = meta.pr;
    result.headSha = meta.headSha;

    // Where did the build come from? A manual run must have used the default
    // branch's workflow; a pull-request run must be for the commit it names.
    const { trigger } = options;
    if (trigger.event === "workflow_dispatch" && trigger.headBranch !== trigger.defaultBranch) {
      return finish("error", `The build was started from branch "${trigger.headBranch}", not from ${trigger.defaultBranch}.`);
    }
    if (trigger.event === "pull_request" && trigger.headSha !== meta.headSha) {
      return finish("error", "The build claims a different commit than the pull-request event it ran for.");
    }
    if (!["workflow_dispatch", "pull_request"].includes(trigger.event)) {
      return finish("error", `Builds started by "${trigger.event}" are not accepted.`);
    }

    const pullRequest = await loadPullRequest(options.repo, meta.pr);
    if (pullRequest.headSha !== meta.headSha) {
      return finish("skipped", "The pull request has moved on to a newer commit since this build started.");
    }
    if (pullRequest.headRepo !== options.repo) {
      return finish("skipped", "Pull requests from forks need a maintainer's go-ahead, which is not implemented yet.");
    }
    if (meta.skip) return finish("skipped", meta.skip);
    if (!meta.appDir || !pullRequest.files.some((f) => f.path.startsWith(`${meta.appDir}/`))) {
      return finish("error", "The build names an application directory the pull request does not change.");
    }

    const key = TICKET_KEY.exec(pullRequest.title)?.[0];
    if (!key) return finish("skipped", "The pull request title names no ticket (expected a key such as ABC-123).");

    // Requirements come from two places only, both outside the pull request's
    // reach: Jira over its authenticated API, and files in this stage's own
    // working copy of the default branch. A provider that cannot answer (network,
    // credentials) ends the run; nothing falls back to pull-request text.
    const providers: TicketProvider[] = [];
    if (jira) providers.push(jiraCloudProvider(jira));
    providers.push(fileTicketProvider(options.ticketsDir));
    let loaded: LoadedTicket | undefined;
    try {
      loaded = await loadFromProviders(key, providers);
    } catch (error) {
      return finish("error", `The ticket ${key} could not be read: ${(error as Error).message.split("\n")[0]!.slice(0, 200)} Nothing was tested.`);
    }
    if (!loaded) return finish("skipped", `No ticket ${key} is available to this run.`);
    const ticket = loaded.ticket;
    console.log(`ticket: ${key} from ${loaded.via === "jira-api" ? `Jira (${loaded.site})` : "a ticket file on the default branch"}`);

    // Everything that decides what counts as a requirement is read from this
    // stage's own working copy, which is the default branch at a pinned commit.
    const protectedMaterial = await readProtectedCheckout(options.trustedRoot, meta.appDir);
    const authority: AuthorityInputs = {
      ticketProvenance:
        loaded.via === "jira-api"
          ? { via: "jira-api", site: loaded.site }
          : { via: "protected-file", revision: protectedMaterial.revision, path: path.relative(options.trustedRoot, loaded.path) },
      authority: protectedMaterial.authority,
      protectedRevision: protectedMaterial.revision,
      approvedDocs: protectedMaterial.approvedDocs,
      comments: await loadPullRequestComments(options.repo, meta.pr),
      commits: await loadPullRequestCommits(options.repo, meta.pr),
    };
    delete process.env.GITHUB_TOKEN;
    console.log(`requirements: protected revision ${protectedMaterial.revision.slice(0, 12)}, ${protectedMaterial.approvedDocs.length} approved document(s), ${protectedMaterial.authority.requirementOwners.github.length} GitHub and ${protectedMaterial.authority.requirementOwners.jira.length} Jira requirement owner(s)`);

    // The image is loaded and run; it is never unpacked or executed on the host.
    await run("docker", ["load", "--input", path.join(options.incoming, "image.tar")], { timeout: 10 * 60_000, env: hostEnv(process.env) });
    const label = (
      await run("docker", ["inspect", "--format", '{{index .Config.Labels "releaseproof.sha"}}', IMAGE], { env: hostEnv(process.env) })
    ).stdout.trim();
    if (label !== meta.headSha) return finish("error", "The application image is not labelled with the pull request's commit.");

    const manifestFile = path.join(options.incoming, "context", "releaseproof.yml");
    const declared = await loadManifest(manifestFile).catch(() => null);
    if (!declared) return finish("error", "The application's manifest is not valid.");
    if (!declared.start) return finish("skipped", "The application's manifest has no start section.");
    const { baseUrl } = await startSandbox({ start: declared.start, sha: meta.headSha });
    // The manifest's own address is ignored: the application is wherever the sandbox put it.
    const manifest = { ...declared, baseUrl };

    result.isolation = await probeIsolation(declared.start);
    if (!result.isolation.ok) return finish("error", "The sandbox isolation check failed; nothing was tested.");

    const requestedFile = path.join(options.incoming, "limits.json");
    const effective = tighten(
      { limits: options.limits, maxScenarios: options.maxScenarios },
      existsSync(requestedFile) ? JSON.parse(await readFile(requestedFile, "utf8").catch(() => "{}")) : {},
    );
    console.log(`limits: $${effective.limits.maxUsd}, ${effective.limits.maxMinutes} min, ${effective.limits.maxTokens} tokens, ${effective.maxScenarios} scenarios`);
    const budget = new Budget(effective.limits, DEFAULT_PRICES);
    let driver: Driver;
    const recording = path.join(options.recordingsDir, `${key}.json`);
    const choice = driverChoice(apiKey, existsSync(recording));
    if (choice === "live") {
      const model = process.env.RELEASEPROOF_MODEL || "claude-opus-5-5";
      const fallbacks = process.env.RELEASEPROOF_FALLBACKS !== "off" && !effective.disableFallbacks;
      console.log(`driver: live model ${model} (an API key is configured); fallbacks ${fallbacks ? "on" : "off"}`);
      if (effective.executorModel) console.log(`executor model for this run: ${effective.executorModel}`);
      driver = new ApiDriver({
        apiKey,
        model,
        executorModel: effective.executorModel,
        effort: (process.env.RELEASEPROOF_EFFORT || "medium") as "low" | "medium" | "high",
        budget,
        fallbacks,
      });
    } else if (choice === "recorded") {
      console.log("driver: recorded responses (no API key is configured)");
      driver = new RecordedDriver(JSON.parse(await readFile(recording, "utf8")) as RunReport);
    } else {
      return finish("skipped", "No model credential is configured and no recording exists for this ticket.");
    }

    const previous =
      options.previousRun && existsSync(options.previousRun)
        ? (JSON.parse(await readFile(options.previousRun, "utf8")) as RunReport)
        : undefined;
    // A previous plan is reused only if no authoritative source has changed since.
    const sourcesNow = fingerprint((await buildContext(ticket, pullRequest, manifest, manifestFile, authority)).sources);
    const retestable = canRetest(previous, meta.pr, sourcesNow, options.full);
    console.log(retestable ? "mode: re-running the previous run's scenarios" : "mode: planning afresh");

    const runDir = path.join(options.outDir, "run");
    const common = { pullRequest, manifest, driver, budget, outDir: runDir, concurrency: options.concurrency };
    result.run = retestable
      ? await retestRun({ ...common, previous: previous! })
      : await runPipeline({
          ...common,
          ticket,
          manifestFile,
          maxScenarios: effective.maxScenarios,
          authority,
          authorityNotices: protectedMaterial.notices,
        });
    await driver.close();
    return finish("completed");
  } catch (error) {
    return finish("error", `ReleaseProof could not complete: ${(error as Error).message.split("\n")[0]!.slice(0, 300)}`);
  } finally {
    await mkdir(options.outDir, { recursive: true });
    const log = await sandboxLogs();
    await writeFile(path.join(options.outDir, "application.log"), log);
    console.log("application log (last lines, as text):");
    for (const line of logTail(log)) console.log(line);
    await stopSandbox();
  }
}
