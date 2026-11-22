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
 * the approved snapshots by the same code that checks a live model's, and a
 * comparison that does not cite a requirement quoted from approved text is
 * removed before anything runs.
 *
 * What that check does NOT establish: that the expected value of a comparison
 * is the one the quoted text states, or that the element read is the right
 * one. Both are the recording's. A result from a recording is therefore
 * evidence of what the application showed, not a verdict on the criteria, and
 * the record says which it is (`executionMode`).
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { attribute } from "../analyse.ts";
import { runScenario } from "../execute/run.ts";
import { AnalysisDraft, Manifest, PlanDraft, Step, type Analysis, type Plan, type ScenarioResult } from "../schema.ts";
import type { SourceRecord } from "../sources.ts";
import { validatePlan } from "../validate.ts";
import { isStartable, type AuthoritativeSnapshot, type StartableRun } from "./authority.ts";
import { RemoteRequestRefused, type AdmittedRun } from "./request.ts";
import { remoteResult, REMOTE_VIEWPORT } from "./result.ts";

/** The version of the recording format this engine reads. */
export const REMOTE_RECORDING_VERSION = 1;
/** The most steps a recording may hold for one scenario: the same count a live model is allowed. */
export const MAX_RECORDED_STEPS = 60;
/** The largest recording file read. */
export const MAX_RECORDING_BYTES = 2_000_000;

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
  steps: z.record(z.string(), z.array(Step).max(MAX_RECORDED_STEPS)),
});
export type RemoteRecording = z.infer<typeof RemoteRecording>;

/**
 * What is wrong with a recording beyond its shape. Ids become file names and
 * keys in the record, so each is a plain name and names one thing.
 */
export function recordingProblems(recording: RemoteRecording): string[] {
  const problems: string[] = [];
  const plain = /^[A-Za-z0-9_-]{1,64}$/;
  const requirements = new Set<string>();
  for (const requirement of recording.analysis.requirements) {
    if (!plain.test(requirement.id)) problems.push("recording: a requirement id is not a plain name of at most 64 letters, digits, hyphens or underscores");
    else if (requirements.has(requirement.id)) problems.push(`recording: requirement id "${requirement.id}" is used more than once`);
    requirements.add(requirement.id);
  }
  for (const scenario of recording.plan.scenarios) {
    if (!plain.test(scenario.id)) problems.push("recording: a scenario id is not a plain name of at most 64 letters, digits, hyphens or underscores");
    for (const assertion of scenario.assertions) {
      if (!plain.test(assertion.id)) problems.push("recording: an assertion id is not a plain name of at most 64 letters, digits, hyphens or underscores");
    }
  }
  return [...new Set(problems)].slice(0, 20);
}

/** Reads a recording file. Anything wrong with it is a refusal, said plainly. */
export async function loadRemoteRecording(file: string): Promise<RemoteRecording> {
  let raw: unknown;
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new RemoteRequestRefused(["the recording could not be read"]);
  }
  if (size > MAX_RECORDING_BYTES) throw new RemoteRequestRefused([`the recording is larger than ${MAX_RECORDING_BYTES} bytes`]);
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new RemoteRequestRefused(["the recording could not be read as JSON"]);
  }
  return checkedRecording(raw);
}

/** A recording, or a refusal that says what is wrong with it. */
export function checkedRecording(raw: unknown): RemoteRecording {
  const parsed = RemoteRecording.safeParse(raw);
  if (!parsed.success) {
    throw new RemoteRequestRefused(parsed.error.issues.slice(0, 20).map((issue) => `recording: ${issue.path.join(".")} ${issue.message}`));
  }
  const problems = recordingProblems(parsed.data);
  if (problems.length > 0) throw new RemoteRequestRefused(problems);
  return parsed.data;
}

/**
 * What this engine cannot yet do for a request, found before the run is
 * claimed so that a refusal here uses nothing up. Today a run can reach its
 * target's own origin and nothing else.
 */
export function unsupported(admitted: Pick<AdmittedRun, "request">): string[] {
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
  target: { baseUrl: string; /** Present, and true, when the target was on the engine's own machine: a trial, not a worker's run. */ localTarget?: true };
  /** Every snapshot the run used, with its hash and who approved it. */
  snapshots: { id: string; sha256: string; approvedBy: string; approvedAt: string; keyId: string }[];
  /** Always "recorded" for now: decisions came from a recording, and no model was called. */
  executionMode: "recorded";
  /**
   * Whether a scenario's "passed" may be taken as a verdict on the criteria.
   * Always false for now: which element a comparison reads is still chosen by
   * the recording, so a pass here is evidence of what the application showed.
   * Nothing but a decision recorded in this engine changes it.
   */
  verdictsTrusted: false;
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
  // Checked here as well as by the command, so that no caller can skip either.
  const cannot = unsupported(options.run);
  if (cannot.length > 0) throw new RemoteRequestRefused(cannot);
  const recording = checkedRecording(options.recording);
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
  const attributed = attribute(recording.analysis, sources);
  const analysis: Analysis = {
    ...attributed.analysis,
    conflicts: attributed.conflicts.map((conflict, index) => ({ ...conflict, id: `C${index + 1}` })),
  };

  // The recorded plan, checked more strictly than a live model's: a comparison
  // is removed unless it cites a requirement quoted from approved text and its
  // expected value is itself stated in that text. The element read remains
  // the recording's.
  const checked = validatePlan(recording.plan, analysis, manifest, request.limits.maxScenarios, { declared: true, quoted: true });

  await mkdir(options.outDir, { recursive: true });
  const deadline = started + request.limits.maxMinutes * 60_000;
  const limitReached = `The run reached its limit of ${request.limits.maxMinutes} ${request.limits.maxMinutes === 1 ? "minute" : "minutes"}.`;
  const results: ScenarioResult[] = [];
  let endedEarly: RemoteRun["endedEarly"];
  let ranOut = false;

  for (const planned of checked.plan.scenarios) {
    if (planned.status !== "runnable") continue;
    const { scenario } = planned;
    if (now() >= deadline) {
      endedEarly ??= { reason: limitReached };
      results.push(notExecuted(scenario, baseUrl, "the run had reached its time limit.", now()));
      continue;
    }
    const steps = Object.hasOwn(recording.steps, scenario.id) ? recording.steps[scenario.id]! : undefined;
    if (steps === undefined || steps.length === 0) {
      results.push(notExecuted(scenario, baseUrl, "the recording holds no steps for this scenario.", now()));
      continue;
    }
    const result = await runScenario({
      scenario,
      manifest,
      outDir: path.join(options.outDir, "scenarios", scenario.id),
      mode: { kind: "replay", steps },
      // The target and the steps are not this engine's own: the page stays on the target.
      confine: true,
      // And the plan is not this engine's own: values are read only from pages and answers as the application served them.
      untrustedPlan: true,
      viewport: REMOTE_VIEWPORT,
      // What the browser showed and said is collected, as evidence and not as a verdict.
      capture: true,
      expired: () => (ranOut ||= now() >= deadline),
    });
    // From the clock, never from what a result says about itself.
    if (ranOut) endedEarly ??= { reason: limitReached };
    // The record names evidence by where it is in the output, not by where that is on this machine.
    results.push({ ...result, evidence: { ...result.evidence, dir: path.posix.join("scenarios", scenario.id) } });
  }

  const run: RemoteRun = {
    recordVersion: 1,
    runId: request.runId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    target: { baseUrl, ...(new URL(baseUrl).hostname === "localhost" ? { localTarget: true as const } : {}) },
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      sha256: snapshot.sha256,
      approvedBy: snapshot.authority.approvedBy,
      approvedAt: snapshot.authority.approvedAt,
      keyId: snapshot.authority.keyId,
    })),
    executionMode: "recorded",
    verdictsTrusted: false,
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
  // The result: what the run found, in the format a control plane reads. The record above is the working behind it.
  await writeFile(path.join(options.outDir, "result.json"), `${JSON.stringify(remoteResult(run), null, 2)}\n`);
  return run;
}
