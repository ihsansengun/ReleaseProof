import { hostEnv } from "../hostenv.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { Driver } from "../drivers/driver.ts";
import type { Stage } from "../routing.ts";
import { createFixtures, deployedSha } from "../env.ts";
import { renderReport } from "../report/markdown.ts";
import type { Manifest, Scenario, ScenarioResult, Step, Usage } from "../schema.ts";
import { SecretVault } from "../secrets.ts";
import { briefing, SYSTEM } from "./briefing.ts";
import { endCapture, startCapture } from "./capture.ts";
import { replaySteps } from "./replay.ts";
import { ALL_TOOLS, noteResponse, requestAllowed, suppliedOf, type Session } from "./tools.ts";
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
  /**
   * Keeps the page on the application's own origin: service workers are off,
   * a WebSocket to any other host is closed, and a replay stops as soon as the
   * page is found anywhere else. For runs whose target or steps are not the
   * caller's own. It does not stop the request a redirect makes: that is for
   * the network the browser runs on.
   */
  confine?: boolean;
  /** For a run whose plan is not the engine's own: see `Session.untrustedPlan`. */
  untrustedPlan?: boolean;
  /** Collect a picture and a time for each step, console errors and failed requests. Off unless asked for. */
  capture?: boolean;
  /** The size of the page. Left to the browser when absent. */
  viewport?: { width: number; height: number };
  /** Says whether the time allowed has run out. A replay asks before every step. */
  expired?: () => boolean;
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
  const context = await browser.newContext({ baseURL: manifest.baseUrl, ...(options.confine ? { serviceWorkers: "block" as const } : {}), ...(options.viewport ? { viewport: { ...options.viewport } } : {}) });
  const origin = new URL(manifest.baseUrl).origin;
  if (options.confine) {
    // The request filter below does not see WebSockets. One to the application's own host goes through; any other is closed.
    const host = new URL(manifest.baseUrl).host;
    await context.routeWebSocket(/.*/, (socket) => {
      let same = false;
      try {
        same = new URL(socket.url()).host === host;
      } catch {
        same = false;
      }
      if (same) socket.connectToServer();
      else void socket.close({ code: 1008, reason: "not the application under test" });
    });
  }
  // A browser trace holds pictures and copies of every page, with nothing covered. A run that collects what may
  // leave the machine does not record one, so that there is none to upload or expose by mistake.
  if (!options.capture) await context.tracing.start({ screenshots: true, snapshots: true });

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
    ...(options.untrustedPlan ? { untrustedPlan: true } : {}),
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

  if (options.confine) {
    // Every address the page commits to is seen here, also one it left again
    // before a step ended. The first that is elsewhere is remembered for good.
    session.page.on("framenavigated", (frame) => {
      if (frame !== session.page.mainFrame() || session.leftTo !== undefined) return;
      const address = frame.url();
      let seen: string;
      try {
        seen = new URL(address).origin;
      } catch {
        seen = "an address that could not be read";
      }
      if (seen === origin) {
        session.arrived = true;
        return;
      }
      // A blank page is where a browser starts. After the application was
      // open it is somewhere else: another window can put a blank page in
      // this one's place and write into it.
      if (address === "about:blank") {
        if (session.arrived) session.leftTo = "a blank page";
        return;
      }
      session.leftTo = seen;
    });
  }

  if (options.capture) startCapture(session, startedAt.getTime());

  if (options.untrustedPlan) {
    // Another window can keep what was typed and hand it to a page opened later. There is one window.
    context.on("page", (other) => {
      if (other !== session.page) void other.close().catch(() => {});
    });
  }

  // What the application answers to a user's action is kept when it is an error.
  context.on("response", (response) => {
    noteResponse(session, response);
    // And whether the application accepted a change.
    try {
      const request = response.request();
      if (new URL(response.url()).origin !== origin) return;
      const method = request.method();
      if (method !== "GET" && method !== "HEAD" && response.status() < 400) suppliedOf(session).writes += 1;
    } catch {
      // A response whose request or frame is already gone says nothing here.
    }
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
  const capture = endCapture(session);
  if (!capture) await session.context.tracing.stop({ path: path.join(session.outDir, "trace.zip") });
  await open.browser.close();

  const outcome = session.outcome ?? { kind: "stopped" as const, reason: "No outcome recorded." };
  const computed = computeVerdict(session.scenario.assertions, session.assertionResults, outcome);
  // A confined session whose page was somewhere else at any moment does not
  // pass, also when every comparison had been made before it left. A recorded
  // mismatch stays a failure.
  const { verdict, reason } =
    session.leftTo !== undefined && computed.verdict === "passed"
      ? { verdict: "blocked" as const, reason: `${outcome.reason} The comparisons made before that matched.` }
      : computed;
  const result: ScenarioResult = {
    scenarioId: session.scenario.id,
    title: session.scenario.title,
    mode: info.mode,
    driver: info.driver,
    verdict,
    reason: session.vault.scrub(reason),
    environment: { baseUrl: session.baseUrl, deployedSha: open.sha, expectedSha: open.expectedSha, commitEstablished: open.commitEstablished },
    assertionResults: session.assertionResults,
    ...(session.appErrors?.length ? { applicationErrors: session.appErrors } : {}),
    ...(outcome.kind === "blocked" && outcome.cause ? { blockedCause: outcome.cause } : {}),
    ...(session.errorSignals?.length ? { errorSignals: session.errorSignals } : {}),
    observations: session.observations,
    ...(session.texts && Object.keys(session.texts).length > 0 ? { textObservations: session.texts } : {}),
    steps: session.steps,
    ...(capture ? { capture } : {}),
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
  mode: { kind: "agent"; driver: Driver; stage?: Stage } | { kind: "replay"; steps: Step[] };
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
          stage: options.mode.stage,
        });
      } else {
        await replaySteps(open.session, options.mode.steps, {
          confineTo: options.confine ? new URL(open.manifest.baseUrl).origin : undefined,
          expired: options.expired,
        });
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
