import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createFixtures, deployedSha } from "../env.ts";
import type { Manifest, Scenario, ScenarioResult, Step } from "../schema.ts";
import { runAgentLoop, type LoopOptions, type LoopUsage } from "./loop.ts";
import { replaySteps } from "./replay.ts";
import type { Session } from "./tools.ts";
import { computeVerdict } from "./verdict.ts";

export type RunOptions = {
  scenario: Scenario;
  manifest: Manifest;
  outDir: string;
  /** If set, the environment must report this commit or nothing is executed. */
  expectedSha?: string;
  mode: { kind: "agent"; loop: LoopOptions } | { kind: "replay"; steps: Step[] };
};

/** Runs one scenario in a fresh browser context and writes result.json plus evidence. */
export async function runScenario(options: RunOptions): Promise<ScenarioResult> {
  const { scenario, manifest, outDir } = options;
  const startedAt = new Date();
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: manifest.baseUrl });
  const origin = new URL(manifest.baseUrl).origin;
  // The executor may only talk to the application under test.
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
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
  };

  let sha: string | undefined;
  let usage: LoopUsage | undefined;
  try {
    sha = await deployedSha(context.request, manifest);
    if (options.expectedSha && sha !== options.expectedSha) {
      session.outcome = {
        kind: "blocked",
        reason: `The environment runs commit ${sha ?? "unknown"}, not ${options.expectedSha}. Nothing was executed.`,
      };
    } else {
      const fixtures = await createFixtures(context.request, manifest, scenario.id, scenario.fixtures);
      if (options.mode.kind === "agent") {
        usage = await runAgentLoop(session, fixtures, options.mode.loop);
      } else {
        await replaySteps(session, options.mode.steps);
      }
    }
  } catch (error) {
    session.outcome = { kind: "blocked", reason: `Execution error: ${(error as Error).message.split("\n")[0]}` };
  }

  const tracePath = path.join(outDir, "trace.zip");
  await context.tracing.stop({ path: tracePath });
  await browser.close();

  const outcome = session.outcome ?? { kind: "stopped" as const, reason: "No outcome recorded." };
  const { verdict, reason } = computeVerdict(scenario.assertions, session.assertionResults, outcome);
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    title: scenario.title,
    mode: options.mode.kind,
    verdict,
    reason,
    environment: { baseUrl: manifest.baseUrl, deployedSha: sha, expectedSha: options.expectedSha },
    assertionResults: session.assertionResults,
    observations: session.observations,
    steps: session.steps,
    evidence: { trace: "trace.zip", dir: outDir },
    usage,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
