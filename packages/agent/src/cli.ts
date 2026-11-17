#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loadManifest } from "./env.ts";
import { runScenario, type RunOptions } from "./execute/run.ts";
import { Scenario, Step, type ScenarioResult } from "./schema.ts";

const USAGE = `Usage:
  releaseproof run-scenario <scenario.json> [options]   execute with the agent loop
  releaseproof replay <scenario.json> --steps <file>    re-run recorded steps, no model

Options:
  --manifest <file>     environment manifest (default: releaseproof.yml)
  --base-url <url>      override the manifest's baseUrl
  --expect-sha <sha>    refuse to run unless the environment reports this commit
  --out <dir>           evidence directory (default: runs/<timestamp>)
  --steps <file>        replay: a step array, or a result.json containing steps
  --max-steps <n>       agent: tool-call budget (default 40)
  --confirm             agent: replay a failed scenario once without the model

Environment:
  RELEASEPROOF_MODEL    model id (default claude-opus-5-5)
  RELEASEPROOF_EFFORT   low | medium | high (default medium)`;

function print(result: ScenarioResult, label = "") {
  console.log(`\n${result.scenarioId} ${result.title}${label}`);
  for (const r of result.assertionResults) {
    console.log(`  ${r.pass ? "match   " : "MISMATCH"} ${r.assertionId}: expected ${r.expected}, actual ${r.actual}`);
  }
  console.log(`  verdict: ${result.verdict.toUpperCase()} - ${result.reason}`);
  console.log(`  evidence: ${result.evidence.dir}`);
  if (result.usage) {
    const u = result.usage;
    console.log(`  model: ${u.model}, ${u.turns} turns, ${u.inputTokens} in / ${u.outputTokens} out tokens`);
  }
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: { type: "string", default: "releaseproof.yml" },
      "base-url": { type: "string" },
      "expect-sha": { type: "string" },
      out: { type: "string" },
      steps: { type: "string" },
      "max-steps": { type: "string", default: "40" },
      confirm: { type: "boolean", default: false },
    },
  });
  const [command, scenarioFile] = positionals;
  if (!command || !scenarioFile || !["run-scenario", "replay"].includes(command)) {
    console.error(USAGE);
    return 2;
  }

  const scenario = Scenario.parse(JSON.parse(await readFile(scenarioFile, "utf8")));
  const manifest = await loadManifest(values.manifest, values["base-url"]);
  const root = values.out ?? path.join("runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const base: Omit<RunOptions, "mode" | "outDir"> = { scenario, manifest, expectedSha: values["expect-sha"] };

  if (command === "replay") {
    if (!values.steps) {
      console.error("replay needs --steps <file>");
      return 2;
    }
    const raw = JSON.parse(await readFile(values.steps, "utf8"));
    const steps = Step.array().parse(Array.isArray(raw) ? raw : raw.steps);
    const result = await runScenario({ ...base, outDir: path.join(root, scenario.id), mode: { kind: "replay", steps } });
    print(result, " (replay)");
    return result.verdict === "passed" ? 0 : 1;
  }

  const effort = (process.env.RELEASEPROOF_EFFORT ?? "medium") as "low" | "medium" | "high";
  const loop = {
    client: new Anthropic(),
    model: process.env.RELEASEPROOF_MODEL ?? "claude-opus-5-5",
    effort,
    maxToolCalls: Number(values["max-steps"]),
  };
  const result = await runScenario({ ...base, outDir: path.join(root, scenario.id), mode: { kind: "agent", loop } });
  print(result);

  if (values.confirm && result.verdict === "failed") {
    const confirmation = await runScenario({
      ...base,
      outDir: path.join(root, `${scenario.id}-confirm`),
      mode: { kind: "replay", steps: result.steps },
    });
    print(confirmation, " (confirmation replay)");
    console.log(
      confirmation.verdict === "failed"
        ? "\nFailure reproduced without the model."
        : "\nFailure did NOT reproduce on replay; treat it as unverified.",
    );
  }
  return result.verdict === "passed" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Anthropic.APIError ? `API error ${error.status}: ${error.message}` : error);
    process.exit(2);
  },
);
