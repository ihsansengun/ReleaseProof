/**
 * A remote run: scenarios executed against a deployed application, given only
 * a target address and criteria snapshots the control plane approved for this
 * run. No pull request, no ticket, no repository and no container.
 *
 * It starts only from a `StartableRun`, which nothing but
 * `authoriseForExecution` produces: by then the request is well formed, every
 * snapshot matches its hash and is approved for this run, the run is the one
 * the caller asked for, and it has not started before.
 *
 * This module takes no model driver, so nothing in it can call a model. What a
 * model would have decided (how to read the criteria, what to test, which
 * steps to take) comes from a RECORDING supplied by the caller. A recording is
 * a proposal like any model output: every requirement in it is checked against
 * the approved snapshots by the same code that checks a live model's, and an
 * expected value that does not rest on approved text is removed before
 * anything runs.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { attribute } from "../analyse.ts";
import { runScenario } from "../execute/run.ts";
import { AnalysisDraft, Manifest, PlanDraft, Step, type Analysis, type Plan, type ScenarioResult } from "../schema.ts";
import type { SourceRecord } from "../sources.ts";
import { validatePlan } from "../validate.ts";
import { isStartable, type AuthoritativeSnapshot, type StartableRun } from "./authority.ts";
import { RemoteRequestRefused, type AdmittedRun } from "./request.ts";

/** The version of the recording format this engine reads. */
export const REMOTE_RECORDING_VERSION = 1;

/**
 * What a model decided in an earlier run, or what a person wrote in its place:
 * a reading of the criteria, a plan, and the steps taken for each scenario.
 * None of it is trusted. It is checked exactly as a model's answer would be.
 */
export const RemoteRecording = z.strictObject({
  recordingVersion: z.literal(REMOTE_RECORDING_VERSION),
  analysis: AnalysisDraft,
  plan: PlanDraft,
  /** Recorded steps by scenario id. A scenario with none is not executed. */
  steps: z.record(z.string(), z.array(Step)),
});
export type RemoteRecording = z.infer<typeof RemoteRecording>;

/** Reads a recording file. Anything wrong with it is a refusal, said plainly. */
export async function loadRemoteRecording(file: string): Promise<RemoteRecording> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new RemoteRequestRefused(["the recording could not be read as JSON"]);
  }
  const parsed = RemoteRecording.safeParse(raw);
  if (!parsed.success) {
    throw new RemoteRequestRefused(parsed.error.issues.slice(0, 20).map((issue) => `recording: ${issue.path.join(".")} ${issue.message}`));
  }
  return parsed.data;
}

/**
 * What this engine cannot yet do for a request, found before the run is
 * claimed so that a refusal here uses nothing up. Today a run can reach its
 * target's own origin and nothing else.
 */
export function unsupported(admitted: AdmittedRun): string[] {
  const { target } = admitted.request;
  const base = new URL(target.baseUrl);
  const own = new Set([base.host.toLowerCase(), base.hostname.toLowerCase()]);
  const others = target.allowedHosts.filter((host) => !own.has(host.toLowerCase()));
  return others.length === 0
    ? []
    : [`target.allowedHosts names hosts besides the target's own (${others.join(", ")}). A run can reach only its target's origin for now.`];
}

/** An approved snapshot as a source of requirements. Only these are authoritative in a remote run. */
export function snapshotSources(snapshots: readonly AuthoritativeSnapshot[]): SourceRecord[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    kind: "criteria-snapshot",
    trust: "authoritative",
    origin: `criteria snapshot "${snapshot.id}"`,
    basis: `Approved for this run by ${snapshot.authority.approvedBy}, under approval key ${snapshot.authority.keyId}.`,
    text: snapshot.content,
    sha256: snapshot.sha256,
  }));
}

/** The record of a remote run. It has no place for a pull request or a ticket. */
export type RemoteRun = {
  recordVersion: 1;
  runId: string;
  workspaceId: string;
  projectId: string;
  target: { baseUrl: string };
  /** Every snapshot the run used, with its hash and who approved it. */
  snapshots: { id: string; sha256: string; approvedBy: string; approvedAt: string; keyId: string }[];
  /** Always "recorded" for now: decisions came from a recording, and no model was called. */
  executionMode: "recorded";
  limits: { maxScenarios: number; maxMinutes: number; maxUsd: number };
  analysis: Analysis;
  analysisNotes: string[];
  plan: Plan;
  /** What the checks removed from the recorded plan, and why. */
  planProblems: string[];
  results: ScenarioResult[];
  /** Why the run stopped before running everything planned. Absent when it did not. */
  endedEarly?: { reason: string };
  startedAt: string;
  durationMs: number;
};

export type RemoteRunOptions = {
  run: StartableRun;
  recording: RemoteRecording;
  /** Fixtures, accounts and sign-in rules for the target. Its address is replaced by the request's. */
  manifest?: Manifest;
  outDir: string;
  /** The clock, for tests. */
  now?: () => number;
};

const notExecuted = (scenario: Plan["scenarios"][number]["scenario"], baseUrl: string, reason: string, at: number): ScenarioResult => ({
  scenarioId: scenario.id,
  title: scenario.title,
  mode: "replay",
  verdict: "unverified",
  reason: `Not executed: ${reason}`,
  environment: { baseUrl },
  assertionResults: [],
  observations: {},
  steps: [],
  evidence: { dir: "" },
  startedAt: new Date(at).toISOString(),
  durationMs: 0,
});

/**
 * Runs a startable remote run from a recording and writes `remote-run.json`
 * and one directory per scenario into `outDir`. Calls no model.
 */
export async function runRemote(options: RemoteRunOptions): Promise<RemoteRun> {
  // A type can be cast. This asks whether the object really came out of the authority check.
  if (!isStartable(options.run)) {
    throw new RemoteRequestRefused(["this run was not authorised to start"]);
  }
  const now = options.now ?? Date.now;
  const started = now();
  const { request, snapshots } = options.run;
  const baseUrl = new URL(request.target.baseUrl).href;
  // The run goes where the approved request says, whatever address a manifest carries.
  const manifest = Manifest.parse({ ...(options.manifest ?? {}), baseUrl });

  // The recording's reading of the criteria, checked against the approved text.
  // A requirement is documented only if its quote is found in a snapshot;
  // nothing the recording says about trust is read.
  const sources = snapshotSources(snapshots);
  const attributed = attribute(options.recording.analysis, sources);
  const analysis: Analysis = {
    ...attributed.analysis,
    conflicts: attributed.conflicts.map((conflict, index) => ({ ...conflict, id: `C${index + 1}` })),
  };

  // The recorded plan, checked as a live model's would be: an expected value
  // that does not rest on an approved requirement is removed here.
  const checked = validatePlan(options.recording.plan, analysis, manifest, request.limits.maxScenarios, { declared: true });

  await mkdir(options.outDir, { recursive: true });
  const deadline = started + request.limits.maxMinutes * 60_000;
  const results: ScenarioResult[] = [];
  let endedEarly: RemoteRun["endedEarly"];

  for (const planned of checked.plan.scenarios) {
    if (planned.status !== "runnable") continue;
    const { scenario } = planned;
    if (now() >= deadline) {
      endedEarly ??= { reason: `The run reached its limit of ${request.limits.maxMinutes} ${request.limits.maxMinutes === 1 ? "minute" : "minutes"}.` };
      results.push(notExecuted(scenario, baseUrl, "the run had reached its time limit.", now()));
      continue;
    }
    const steps = Object.hasOwn(options.recording.steps, scenario.id) ? options.recording.steps[scenario.id]! : undefined;
    if (steps === undefined || steps.length === 0) {
      results.push(notExecuted(scenario, baseUrl, "the recording holds no steps for this scenario.", now()));
      continue;
    }
    results.push(
      await runScenario({
        scenario,
        manifest,
        outDir: path.join(options.outDir, "scenarios", scenario.id),
        mode: { kind: "replay", steps },
      }),
    );
  }

  const run: RemoteRun = {
    recordVersion: 1,
    runId: request.runId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    target: { baseUrl },
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      sha256: snapshot.sha256,
      approvedBy: snapshot.authority.approvedBy,
      approvedAt: snapshot.authority.approvedAt,
      keyId: snapshot.authority.keyId,
    })),
    executionMode: "recorded",
    limits: { maxScenarios: request.limits.maxScenarios, maxMinutes: request.limits.maxMinutes, maxUsd: request.limits.maxUsd },
    analysis,
    analysisNotes: attributed.notes,
    plan: checked.plan,
    planProblems: checked.problems,
    results,
    ...(endedEarly ? { endedEarly } : {}),
    startedAt: new Date(started).toISOString(),
    durationMs: now() - started,
  };
  await writeFile(path.join(options.outDir, "remote-run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}
