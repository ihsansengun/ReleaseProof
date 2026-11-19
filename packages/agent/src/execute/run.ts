import { hostEnv } from "../hostenv.ts";
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

/** What the caller provides about the application beyond its manifest. Built by trusted code. */
export type AppAccess = {
  /**
   * How the caller itself established which commit is running. Used only
   * for applications that have no version endpoint: without it, a scenario
   * for such an application is not executed.
   */
  commitEstablished?: string;
  /** Starts an application of its own for one scenario; `release` stops it. */
  instance?: (label: string) => Promise<{ baseUrl: string; release: () => Promise<void> }>;
};

export type SessionOptions = {
  scenario: Scenario;
  manifest: Manifest;
  outDir: string;
  app?: AppAccess;
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
  commitEstablished?: string;
  /** The application server's current date (UTC), from its response headers. */
  serverDate?: string;
  startedAt: Date;
};

/** The browser's environment: the engine-wide allow-list, never the engine's own environment. */
export const browserEnv = hostEnv;

/**
 * Starts an isolated browser for one scenario, checks the environment and
 * prepares fixtures. If the scenario cannot start, `session.outcome` is
 * already set and nothing further should be executed.
 */
export async function openSession(options: SessionOptions): Promise<OpenSession> {
  const { scenario, manifest, outDir } = options;
  const startedAt = new Date();
  await mkdir(outDir, { recursive: true });

  // The browser renders untrusted pages. It gets a minimal environment, so
  // nothing the engine holds (model key, tokens) is in a process that parses
  // content from the application under test.
  const browser = await chromium.launch({ env: browserEnv(process.env) });
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
  // An application with no version endpoint cannot say which commit it is.
  // Then the caller's own knowledge of what it started stands in, if it has any.
  const commitEstablished = manifest.version ? undefined : options.app?.commitEstablished;
  try {
    sha = await deployedSha(context.request, manifest);
    const header = (await context.request.get(manifest.baseUrl, { maxRedirects: 0 })).headers()["date"];
    if (header && !Number.isNaN(Date.parse(header))) serverDate = new Date(header).toISOString().slice(0, 10);
    if (options.expectedSha && sha !== options.expectedSha && !commitEstablished) {
      session.outcome = {
        kind: "blocked",
        reason: manifest.version
          ? `The environment runs commit ${sha ?? "unknown"}, not ${options.expectedSha}. Nothing was executed.`
          : `The application has no version endpoint and nothing else establishes that it runs commit ${options.expectedSha}. Nothing was executed.`,
      };
    } else {
      // Accounts the application ships with need no request; the rest are created through its endpoints.
      const wanted = Object.entries(scenario.fixtures);
      const created = Object.fromEntries(wanted.filter(([, type]) => !manifest.accounts[type]));
      const raw = await createFixtures(context.request, manifest, scenario.id, created);
      const extra = Object.fromEntries(
        Object.entries(created).map(([alias, type]) => [alias, manifest.fixtures[type]?.secretFields ?? []]),
      );
      fixtures = session.vault.maskFixtures(raw, extra);
      for (const [alias, type] of wanted) {
        const account = manifest.accounts[type];
        if (account) fixtures[alias] = { existingAccount: account.description, username: account.username, password: session.vault.declared(`${alias}.password`, account.password) };
      }
    }
  } catch (error) {
    session.outcome = { kind: "blocked", reason: `Environment error: ${(error as Error).message.split("\n")[0]}` };
  }
  return { session, browser, manifest, fixtures, sha, expectedSha: options.expectedSha, commitEstablished, serverDate, startedAt };
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
    environment: { baseUrl: session.baseUrl, deployedSha: open.sha, expectedSha: open.expectedSha, commitEstablished: open.commitEstablished },
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

/** A scenario whose application never came up: blocked, with nothing executed. */
async function notStarted(options: RunOptions, reason: string): Promise<ScenarioResult> {
  await mkdir(options.outDir, { recursive: true });
  const result: ScenarioResult = {
    scenarioId: options.scenario.id,
    title: options.scenario.title,
    mode: options.mode.kind,
    verdict: "blocked",
    reason,
    environment: { baseUrl: options.manifest.baseUrl },
    assertionResults: [],
    observations: {},
    steps: [],
    evidence: { dir: options.outDir },
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  await writeFile(path.join(options.outDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

export type RunOptions = SessionOptions & {
  maxToolCalls?: number;
  mode: { kind: "agent"; driver: Driver } | { kind: "replay"; steps: Step[] };
};

/** Runs one scenario start to finish, driven by a model or by a recording. */
export async function runScenario(options: RunOptions): Promise<ScenarioResult> {
  // With an application per scenario, this scenario's is started now and
  // stopped when the scenario ends, whatever happens in between.
  if (options.app?.instance) {
    const { instance, ...rest } = options.app;
    let started: Awaited<ReturnType<typeof instance>>;
    try {
      started = await instance(`${options.mode.kind}-${options.scenario.id}`);
    } catch (error) {
      return notStarted(options, `The application could not be started for this scenario: ${(error as Error).message.split("\n")[0]!.slice(0, 200)}`);
    }
    try {
      return await runScenario({ ...options, app: rest, manifest: { ...options.manifest, baseUrl: started.baseUrl } });
    } finally {
      await started.release().catch(() => {});
    }
  }
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
