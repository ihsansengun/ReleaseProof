import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { Driver } from "../drivers/driver.ts";
import { createFixtures, deployedSha } from "../env.ts";
import { renderReport } from "../report/markdown.ts";
import type { Manifest, Scenario, ScenarioResult, Step, Usage } from "../schema.ts";
import { SecretVault } from "../secrets.ts";
import { briefing, SYSTEM } from "./briefing.ts";
import { replaySteps } from "./replay.ts";
import { ALL_TOOLS, requestAllowed, type Session } from "./tools.ts";
import { computeVerdict } from "./verdict.ts";

export type SessionOptions = {
  scenario: Scenario;
  manifest: Manifest;
  outDir: string;
  /** If set, the environment must report this commit or nothing is executed. */
  expectedSha?: string;
  /** State-changing requests allowed out of the browser. Default: all. */
  writes?: Session["writes"];
};

export type OpenSession = {
  session: Session;
  browser: Browser;
  manifest: Manifest;
  /** Fixture data as the model may see it: secrets replaced by placeholders. */
  fixtures: Record<string, unknown>;
  sha?: string;
  expectedSha?: string;
  /** The application server's current date (UTC), from its response headers. */
  serverDate?: string;
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
    vault: new SecretVault(),
    writes: options.writes ?? "all",
  };

  // The executor may only talk to the application under test, and only send
  // what the session's write policy permits. The policy is read per request,
  // so a session can be tightened while it runs.
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    return url.origin === origin && requestAllowed(session.writes, request.method(), url.pathname)
      ? route.continue()
      : route.abort();
  });

  let sha: string | undefined;
  let serverDate: string | undefined;
  let fixtures: Record<string, unknown> = {};
  try {
    sha = await deployedSha(context.request, manifest);
    const header = (await context.request.get(manifest.baseUrl)).headers()["date"];
    if (header && !Number.isNaN(Date.parse(header))) serverDate = new Date(header).toISOString().slice(0, 10);
    if (options.expectedSha && sha !== options.expectedSha) {
      session.outcome = {
        kind: "blocked",
        reason: `The environment runs commit ${sha ?? "unknown"}, not ${options.expectedSha}. Nothing was executed.`,
      };
    } else {
      const raw = await createFixtures(context.request, manifest, scenario.id, scenario.fixtures);
      const extra = Object.fromEntries(
        Object.entries(scenario.fixtures).map(([alias, type]) => [alias, manifest.fixtures[type]?.secretFields ?? []]),
      );
      fixtures = session.vault.maskFixtures(raw, extra);
    }
  } catch (error) {
    session.outcome = { kind: "blocked", reason: `Environment error: ${(error as Error).message.split("\n")[0]}` };
  }
  return { session, browser, manifest, fixtures, sha, expectedSha: options.expectedSha, serverDate, startedAt };
}

/** Stops the browser, computes the verdict and writes result.json and report.md. */
export async function closeSession(
  open: OpenSession,
  info: { mode: "agent" | "replay"; driver?: string; usage?: Usage },
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
    reason: session.vault.scrub(reason),
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
  maxToolCalls?: number;
  mode: { kind: "agent"; driver: Driver } | { kind: "replay"; steps: Step[] };
};

/** Runs one scenario start to finish, driven by a model or by a recording. */
export async function runScenario(options: RunOptions): Promise<ScenarioResult> {
  const open = await openSession(options);
  let usage: Usage | undefined;
  if (!open.session.outcome) {
    try {
      if (options.mode.kind === "agent") {
        usage = await options.mode.driver.session(open.session, {
          name: options.scenario.id,
          system: SYSTEM,
          briefing: briefing(options.scenario, open.manifest, open.fixtures, open.serverDate),
          tools: ALL_TOOLS,
          maxToolCalls: options.maxToolCalls ?? 60,
        });
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
    driver: options.mode.kind === "agent" ? options.mode.driver.label : undefined,
    usage,
  });
}
