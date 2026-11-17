import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { createFixtures, deployedSha } from "../env.ts";
import { renderReport } from "../report/markdown.ts";
import type { Manifest, Scenario, ScenarioResult, Step } from "../schema.ts";
import { runAgentLoop, type LoopOptions, type LoopUsage } from "./loop.ts";
import { replaySteps } from "./replay.ts";
import type { Session } from "./tools.ts";
import { computeVerdict } from "./verdict.ts";

export type SessionOptions = {
  scenario: Scenario;
  manifest: Manifest;
  outDir: string;
  /** If set, the environment must report this commit or nothing is executed. */
  expectedSha?: string;
  /** Block every request that is not a GET or HEAD, at the network layer. */
  readOnly?: boolean;
};

export type OpenSession = {
  session: Session;
  browser: Browser;
  manifest: Manifest;
  fixtures: Record<string, unknown>;
  sha?: string;
  expectedSha?: string;
  startedAt: Date;
};

/**
 * Starts an isolated browser for one scenario, checks the environment and
 * prepares fixtures. If the scenario cannot start, `session.outcome` is
 * already set and nothing further should be executed.
 */
export async function openSession(options: SessionOptions): Promise<OpenSession> {
  const { scenario, manifest, outDir } = options;
  const startedAt = new Date();
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: manifest.baseUrl });
  const origin = new URL(manifest.baseUrl).origin;
  // The executor may only talk to the application under test, and in
  // read-only mode may not send anything that could change its state.
  await context.route("**/*", (route) => {
    const request = route.request();
    const sameOrigin = new URL(request.url()).origin === origin;
    const safeMethod = ["GET", "HEAD"].includes(request.method());
    return sameOrigin && (!options.readOnly || safeMethod) ? route.continue() : route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true });

  const session: Session = {
    scenario,
    baseUrl: manifest.baseUrl,
    context,
    page: await context.newPage(),
    outDir,
    observations: {},
    apiResponses: new Map(),
    assertionResults: [],
    steps: [],
    readOnly: options.readOnly,
  };

  let sha: string | undefined;
  let fixtures: Record<string, unknown> = {};
  try {
    sha = await deployedSha(context.request, manifest);
    if (options.expectedSha && sha !== options.expectedSha) {
      session.outcome = {
        kind: "blocked",
        reason: `The environment runs commit ${sha ?? "unknown"}, not ${options.expectedSha}. Nothing was executed.`,
      };
    } else {
      fixtures = await createFixtures(context.request, manifest, scenario.id, scenario.fixtures);
    }
  } catch (error) {
    session.outcome = { kind: "blocked", reason: `Environment error: ${(error as Error).message.split("\n")[0]}` };
  }
  return { session, browser, manifest, fixtures, sha, expectedSha: options.expectedSha, startedAt };
}

/** Stops the browser, computes the verdict and writes result.json and report.md. */
export async function closeSession(
  open: OpenSession,
  info: { mode: "agent" | "replay"; driver?: string; usage?: LoopUsage },
): Promise<ScenarioResult> {
  const { session } = open;
  await session.context.tracing.stop({ path: path.join(session.outDir, "trace.zip") });
  await open.browser.close();

  const outcome = session.outcome ?? { kind: "stopped" as const, reason: "No outcome recorded." };
  const { verdict, reason } = computeVerdict(session.scenario.assertions, session.assertionResults, outcome);
  const result: ScenarioResult = {
    scenarioId: session.scenario.id,
    title: session.scenario.title,
    mode: info.mode,
    driver: info.driver,
    verdict,
    reason,
    environment: { baseUrl: session.baseUrl, deployedSha: open.sha, expectedSha: open.expectedSha },
    assertionResults: session.assertionResults,
    observations: session.observations,
    steps: session.steps,
    evidence: { trace: "trace.zip", dir: session.outDir },
    usage: info.usage,
    startedAt: open.startedAt.toISOString(),
    durationMs: Date.now() - open.startedAt.getTime(),
  };
  await writeFile(path.join(session.outDir, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(session.outDir, "report.md"), renderReport(session.scenario, result));
  return result;
}

export type RunOptions = SessionOptions & {
  mode: { kind: "agent"; loop: LoopOptions } | { kind: "replay"; steps: Step[] };
};

/** Runs one scenario start to finish, with the built-in model loop or a recording. */
export async function runScenario(options: RunOptions): Promise<ScenarioResult> {
  const open = await openSession(options);
  let usage: LoopUsage | undefined;
  if (!open.session.outcome) {
    try {
      if (options.mode.kind === "agent") {
        usage = await runAgentLoop(open.session, open.manifest, open.fixtures, options.mode.loop);
      } else {
        await replaySteps(open.session, options.mode.steps);
      }
    } catch (error) {
      open.session.outcome = {
        kind: "stopped",
        reason: `Execution error: ${(error as Error).message.split("\n")[0]}`,
      };
    }
  }
  return closeSession(open, {
    mode: options.mode.kind,
    driver: options.mode.kind === "agent" ? options.mode.loop.model : undefined,
    usage,
  });
}
