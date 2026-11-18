import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Budget, DEFAULT_PRICES, type Limits } from "../budget.ts";
import { ApiDriver, type Driver } from "../drivers/driver.ts";
import { RecordedDriver } from "../drivers/recorded.ts";
import { loadManifest } from "../env.ts";
import { loadPullRequest } from "../ingest/github.ts";
import { loadTicket } from "../ingest/jira.ts";
import { retestRun, runPipeline, ticketHash } from "../pipeline.ts";
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

export type CiRunOptions = {
  incoming: string;
  outDir: string;
  repo: string;
  /** How the build that produced `incoming` was started. */
  trigger: { event: string; headBranch: string; headSha: string; defaultBranch: string };
  ticketsDir: string;
  recordingsDir: string;
  previousRun?: string;
  full: boolean;
  limits: Limits;
  maxScenarios: number;
  concurrency: number;
};

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

  try {
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
    const ticketFile = path.join(options.ticketsDir, `${key}.json`);
    if (!existsSync(ticketFile)) return finish("skipped", `No ticket ${key} is available to this run.`);
    const ticket = await loadTicket(ticketFile);

    // The image is loaded and run; it is never unpacked or executed on the host.
    await run("docker", ["load", "--input", path.join(options.incoming, "image.tar")], { timeout: 10 * 60_000 });
    const label = (
      await run("docker", ["inspect", "--format", '{{index .Config.Labels "releaseproof.sha"}}', IMAGE])
    ).stdout.trim();
    if (label !== meta.headSha) return finish("error", "The application image is not labelled with the pull request's commit.");

    const manifestFile = path.join(options.incoming, "context", "releaseproof.yml");
    const declared = await loadManifest(manifestFile);
    if (!declared.start) return finish("skipped", "The application's manifest has no start section.");
    const { baseUrl } = await startSandbox({ start: declared.start, sha: meta.headSha });
    // The manifest's own address is ignored: the application is wherever the sandbox put it.
    const manifest = { ...declared, baseUrl };

    result.isolation = await probeIsolation(declared.start);
    if (!result.isolation.ok) return finish("error", "The sandbox isolation check failed; nothing was tested.");

    const budget = new Budget(options.limits, DEFAULT_PRICES);
    let driver: Driver;
    const recording = path.join(options.recordingsDir, `${key}.json`);
    if (process.env.ANTHROPIC_API_KEY) {
      driver = new ApiDriver({
        model: process.env.RELEASEPROOF_MODEL || "claude-opus-5-5",
        effort: (process.env.RELEASEPROOF_EFFORT || "medium") as "low" | "medium" | "high",
        budget,
        fallbacks: process.env.RELEASEPROOF_FALLBACKS !== "off",
      });
    } else if (existsSync(recording)) {
      driver = new RecordedDriver(JSON.parse(await readFile(recording, "utf8")) as RunReport);
    } else {
      return finish("skipped", "No model credential is configured and no recording exists for this ticket.");
    }

    const previous =
      options.previousRun && existsSync(options.previousRun)
        ? (JSON.parse(await readFile(options.previousRun, "utf8")) as RunReport)
        : undefined;
    const retestable =
      !options.full &&
      previous !== undefined &&
      previous.pullRequest.number === meta.pr &&
      previous.ticketHash === ticketHash(ticket) &&
      previous.results.some((r) => r.steps.length > 0);

    const runDir = path.join(options.outDir, "run");
    const common = { pullRequest, manifest, driver, budget, outDir: runDir, concurrency: options.concurrency };
    result.run = retestable
      ? await retestRun({ ...common, previous: previous! })
      : await runPipeline({ ...common, ticket, manifestFile, maxScenarios: options.maxScenarios });
    await driver.close();
    return finish("completed");
  } catch (error) {
    return finish("error", `ReleaseProof could not complete: ${(error as Error).message.split("\n")[0]!.slice(0, 300)}`);
  } finally {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, "application.log"), await sandboxLogs());
    await stopSandbox();
  }
}
