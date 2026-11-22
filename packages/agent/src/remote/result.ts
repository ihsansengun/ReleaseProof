/**
 * The result of a remote run: one file, written by the engine, that says what
 * the run found. It is the only place a run-level verdict is stated, and
 * nothing that reads it may work one out for itself.
 *
 * The file follows the result contract's format version 1: `formatVersion`,
 * `runId` and `verdict` are where that version puts them, and everything else
 * is additional. Fields can be added without a new version. A reader that
 * does not know a field leaves it alone.
 *
 * Two things are kept apart throughout, because they are different facts:
 *
 *   OBSERVED  what the comparisons that were made showed. A comparison that
 *             matched is an observation: this element showed this value.
 *   VERIFIED  that an approved requirement holds. That needs more than an
 *             observation: it needs the expected value and the element read
 *             to be the ones the approved text means.
 *
 * While `verdictsTrusted` is false, an observation is never reported as a
 * verification. The run-level verdict is then never "passed", and no
 * requirement is "verified": where the comparisons alone would say so, the
 * result says "unverified" and gives the observation beside it. A mismatch,
 * an error and a blocked run are reported as they are: nobody releases on
 * those, and softening them would hide what was seen.
 *
 * A screenshot, a trace or any other captured file is evidence of what the
 * browser showed. Its presence proves nothing about a requirement, and this
 * file never derives a status from one.
 */
import path from "node:path";
import { assess, type RequirementStatus } from "../report/readiness.ts";
import type { ScenarioResult, Verdict } from "../schema.ts";
import type { RemoteRun } from "./run.ts";

/** The result contract's format version this file follows. */
export const REMOTE_RESULT_FORMAT_VERSION = 1;
/** The version of the additional fields below. Raised when one of them changes meaning. */
export const REMOTE_RESULT_SCHEMA = 1;

/** How far the run got. A run that completed can still have failed or unverified requirements. */
export type ExecutionStatus = "completed" | "ended early" | "nothing executed";

export type Telemetry = "collected" | "not collected";

export type RemoteResult = {
  formatVersion: 1;
  runId: string;
  /** The engine's verdict on the run. Never "passed" while `verdictsTrusted` is false. */
  verdict: Verdict;
  /**
   * Whether "passed" and "verified" in this file may be taken as statements
   * about the approved requirements. False for every run for now.
   */
  verdictsTrusted: boolean;
  /** Why the verdict is what it is, and what the comparisons alone showed. */
  verdictBasis: {
    /** What the comparisons made would give by the same rule, trusted or not. An observation, not a verdict. */
    observed: Verdict;
    reason: string;
    /** Set when `verdict` differs from `observed`: why an observation was not taken as a verdict. */
    notTrustedBecause?: string;
  };
  executionStatus: ExecutionStatus;
  endedEarly?: { reason: string };
  /** What produced this file. */
  producer: { name: "releaseproof-engine"; resultSchema: number; kind: "remote-run"; executionMode: RemoteRun["executionMode"] };
  workspaceId: string;
  projectId: string;
  title: string;
  summary: string;
  target: RemoteRun["target"];
  /** The approved criteria snapshots the run used. */
  snapshots: RemoteRun["snapshots"];
  /** How many requirements ended in each status, and how much of the plan ran. */
  coverage: {
    requirements: { total: number } & Record<"verified" | "failed" | "errored" | "blocked" | "unverified" | "exercised" | "deferred" | "notPlanned", number>;
    /** Requirements whose comparisons all matched but are not counted as verified, because the result is not trusted. */
    observedOnly: number;
    scenarios: { planned: number; executed: number; notExecuted: number };
  };
  requirements: {
    id: string;
    /** The status the engine states. Never "verified" while `verdictsTrusted` is false. */
    status: RequirementStatus;
    /** What the comparisons alone showed for this requirement. An observation. */
    observedStatus: RequirementStatus;
    text: string;
    reason: string;
    /** Expected and observed values of the comparisons tied to this requirement, as text. Empty when none was made. */
    expected: string;
    observed: string;
    source: { document: string; revision: string; approvedBy: string; approvedAt: string } | null;
    stepIds: string[];
  }[];
  steps: {
    id: string;
    scenarioId: string;
    action: string;
    target: string;
    outcome: "ok" | "mismatch" | "error";
    requirementIds: string[];
    note: string;
    /** A screenshot taken at this step, by the id of an entry in `evidence`. */
    screenshot?: { evidenceId: string };
  }[];
  profiles: { name: string; viewport: string; state: "tested" | "not run"; reason: string }[];
  /** For each kind of evidence, whether this run collected it. Anything not collected is absent, never empty-as-if-clean. */
  telemetry: Record<"screenshots" | "recording" | "trace" | "console" | "network" | "analytics" | "webVitals", Telemetry>;
  diagnostics: { console: unknown[]; network: unknown[]; analytics: unknown[] };
  /** Files the run wrote, by a path inside the run's output directory. What each shows, not what it proves. */
  evidence: { id: string; label: string; mediaType: string; path: string; scenarioId: string }[];
  /** For fields a later engine adds before they are part of this schema. */
  extensions: Record<string, unknown>;
};

/** First match wins: the worst outcome decides. */
const WORST_FIRST: Verdict[] = ["failed", "errored", "blocked", "unverified", "passed"];

const NOT_TRUSTED =
  "Which element a comparison reads is still chosen by the recording, and is not yet tied to the approved text. A match shows what the application displayed there, not that the requirement holds.";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function describeTarget(input: unknown): string {
  const given = (input ?? {}) as { path?: string; method?: string; element?: { by?: string; role?: string; value?: string }; target?: { source?: string; by?: string; value?: string; responseId?: string; jsonPath?: string }; assertionId?: string; name?: string };
  if (typeof given.path === "string") return clip(`${given.method ? `${given.method} ` : ""}${given.path}`, 200);
  const element = given.element ?? given.target;
  if (element && "responseId" in element && element.responseId) return clip(`response ${element.responseId}${element.jsonPath ? ` at ${element.jsonPath}` : ""}`, 200);
  if (element?.by) return clip(`${element.by}${"role" in element && element.role ? ` ${element.role}` : ""} "${element.value ?? ""}"`, 200);
  return "";
}

/**
 * Builds the result of a remote run from its record. Pure: it reads nothing
 * but the record, and states nothing the record does not hold.
 */
export function remoteResult(run: RemoteRun): RemoteResult {
  // Taken from the record, where nothing can yet set it to true.
  const trusted: boolean = run.verdictsTrusted;
  const executed = run.results.filter((result) => result.steps.length > 0);
  const assessment = assess({ analysis: run.analysis, plan: run.plan, results: run.results });

  // What the comparisons alone give, by the rule that the worst outcome decides.
  const planned = run.plan.scenarios.filter((planned) => planned.status === "runnable");
  const incomplete =
    run.endedEarly !== undefined ||
    executed.length < planned.length ||
    planned.length === 0 ||
    run.plan.scenarios.some((scenario) => scenario.status !== "runnable") ||
    assessment.requirements.length === 0 ||
    assessment.requirements.some((requirement) => requirement.status !== "verified");
  const worst = WORST_FIRST.find((verdict) => run.results.some((result) => result.verdict === verdict)) ?? "unverified";
  const observed: Verdict = worst === "passed" && incomplete ? "unverified" : worst;
  const verdict: Verdict = observed === "passed" && !trusted ? "unverified" : observed;

  const snapshotOf = new Map(run.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const documented = new Map(run.analysis.requirements.map((requirement) => [requirement.id, requirement]));

  // Steps, each with an id of its own, and the comparisons each check step made.
  const steps: RemoteResult["steps"] = [];
  const evidence: RemoteResult["evidence"] = [];
  const stepsOf = new Map<string, string[]>();
  const comparisonsOf = new Map<string, { expected: string; observed: string }[]>();
  for (const result of executed) {
    const assertions = new Map(run.plan.scenarios.find((planned) => planned.scenario.id === result.scenarioId)?.scenario.assertions.map((assertion) => [assertion.id, assertion]) ?? []);
    const compared = new Map(result.assertionResults.map((made) => [made.assertionId, made]));
    result.steps.forEach((step, index) => {
      const id = `${result.scenarioId}-${index + 1}`;
      const assertionId = step.tool === "check" ? (step.input as { assertionId?: string } | null)?.assertionId : undefined;
      const made = assertionId && step.ok ? compared.get(assertionId) : undefined;
      const requirementId = assertionId ? assertions.get(assertionId)?.requirementId : undefined;
      const requirementIds = requirementId ? [requirementId] : [];
      let screenshot: RemoteResult["steps"][number]["screenshot"];
      if (made?.screenshot) {
        const evidenceId = `${result.scenarioId}-${path.basename(made.screenshot, path.extname(made.screenshot))}`;
        evidence.push({ id: evidenceId, label: `What the browser showed when ${assertionId} was compared`, mediaType: "image/png", path: path.posix.join("scenarios", result.scenarioId, path.basename(made.screenshot)), scenarioId: result.scenarioId });
        screenshot = { evidenceId };
      }
      steps.push({
        id,
        scenarioId: result.scenarioId,
        action: step.tool,
        target: describeTarget(step.input),
        outcome: !step.ok ? "error" : made && !made.pass ? "mismatch" : "ok",
        requirementIds,
        note: clip(step.summary, 400),
        ...(screenshot ? { screenshot } : {}),
      });
      if (requirementId) {
        stepsOf.set(requirementId, [...(stepsOf.get(requirementId) ?? []), id]);
        if (made) comparisonsOf.set(requirementId, [...(comparisonsOf.get(requirementId) ?? []), { expected: String(made.expected), observed: String(made.actual) }]);
      }
    });
    if (result.evidence.trace) {
      evidence.push({ id: `${result.scenarioId}-trace`, label: "Browser trace of the scenario", mediaType: "application/zip", path: path.posix.join("scenarios", result.scenarioId, result.evidence.trace), scenarioId: result.scenarioId });
    }
  }

  const requirements: RemoteResult["requirements"] = assessment.requirements.map((requirement) => {
    const comparisons = comparisonsOf.get(requirement.id) ?? [];
    const source = documented.get(requirement.id)?.sourceId;
    const snapshot = source ? snapshotOf.get(source) : undefined;
    const withheld = requirement.status === "verified" && !trusted;
    return {
      id: requirement.id,
      status: withheld ? "unverified" : requirement.status,
      observedStatus: requirement.status,
      text: requirement.text,
      reason: withheld ? `Observed, not verified. ${requirement.detail}. ${NOT_TRUSTED}` : requirement.detail,
      expected: comparisons.map((made) => made.expected).join("; "),
      observed: comparisons.map((made) => made.observed).join("; "),
      source: snapshot ? { document: snapshot.id, revision: snapshot.sha256, approvedBy: snapshot.approvedBy, approvedAt: snapshot.approvedAt } : null,
      stepIds: stepsOf.get(requirement.id) ?? [],
    };
  });

  const count = (status: RequirementStatus) => requirements.filter((requirement) => requirement.status === status).length;
  const screenshots = evidence.some((file) => file.mediaType === "image/png");
  const traces = evidence.some((file) => file.mediaType === "application/zip");
  const reason =
    observed === "passed"
      ? "Every planned scenario ran and every comparison matched."
      : run.endedEarly
        ? `${run.endedEarly.reason} Not everything planned was run.`
        : (run.results.find((result) => result.verdict === worst && worst !== "passed")?.reason ?? "Not every approved requirement was compared.");

  return {
    formatVersion: REMOTE_RESULT_FORMAT_VERSION,
    runId: run.runId,
    verdict,
    verdictsTrusted: trusted,
    verdictBasis: { observed, reason: clip(reason, 600), ...(verdict !== observed ? { notTrustedBecause: NOT_TRUSTED } : {}) },
    executionStatus: executed.length === 0 ? "nothing executed" : run.endedEarly ? "ended early" : "completed",
    ...(run.endedEarly ? { endedEarly: run.endedEarly } : {}),
    producer: { name: "releaseproof-engine", resultSchema: REMOTE_RESULT_SCHEMA, kind: "remote-run", executionMode: run.executionMode },
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    title: clip(run.analysis.featureSummary || `Run against ${run.target.baseUrl}`, 200),
    summary: clip(summaryOf(run.results, executed.length, planned.length), 600),
    target: run.target,
    snapshots: run.snapshots,
    coverage: {
      requirements: {
        total: requirements.length,
        verified: count("verified"),
        failed: count("failed"),
        errored: count("errored"),
        blocked: count("blocked"),
        unverified: count("unverified"),
        exercised: count("exercised"),
        deferred: count("deferred"),
        notPlanned: count("not planned"),
      },
      observedOnly: requirements.filter((requirement) => requirement.observedStatus === "verified" && requirement.status !== "verified").length,
      scenarios: { planned: planned.length, executed: executed.length, notExecuted: planned.length - executed.length },
    },
    requirements,
    steps,
    // One browser as it comes, at its default size. Nothing else was run, and nothing says it was.
    profiles: executed.length > 0 ? [{ name: "Chromium, desktop", viewport: "1280 × 720", state: "tested", reason: "" }] : [],
    telemetry: {
      screenshots: screenshots ? "collected" : "not collected",
      recording: "not collected",
      trace: traces ? "collected" : "not collected",
      console: "not collected",
      network: "not collected",
      analytics: "not collected",
      webVitals: "not collected",
    },
    diagnostics: { console: [], network: [], analytics: [] },
    evidence,
    extensions: {},
  };
}

function summaryOf(results: ScenarioResult[], executed: number, planned: number): string {
  const matched = results.reduce((sum, result) => sum + result.assertionResults.filter((made) => made.pass).length, 0);
  const mismatched = results.reduce((sum, result) => sum + result.assertionResults.filter((made) => !made.pass).length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${executed} of ${plural(planned, "planned scenario")} ran. ${plural(matched, "comparison")} matched and ${mismatched} did not.`;
}
