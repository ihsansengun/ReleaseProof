/**
 * Separates two things a QA report must not blur:
 *
 *   execution results   what happened to the scenarios that ran
 *   release readiness   whether the feature can be called verified
 *
 * A run in which everything that ran passed is still "incomplete" if
 * documented requirements were never compared against the application.
 */

export type RequirementStatus = "verified" | "failed" | "blocked" | "unverified" | "not planned";
export type Readiness = "not ready" | "incomplete" | "ready";

/** The parts of a run this needs. Both the full run report and the CI stage's validated view fit. */
export type ReadinessInput = {
  stopped?: string;
  analysis: {
    requirements: { id: string; text: string; kind: string; quote: string; origin?: string }[];
    /** Disagreements between pull-request material and the approved requirements. */
    conflicts?: { id: string; kind: string; description: string }[];
    supersessions?: { how: string }[];
  };
  plan: {
    /** Runnable scenarios the planner wrote that were dropped to respect the limit. */
    trimmedRunnable?: number;
    scenarios: {
      status: string;
      blockedReason: string;
      scenario: {
        id: string;
        requirementIds?: string[];
        assertions: { id: string; requirementId?: string }[];
      };
    }[];
  };
  results: {
    scenarioId: string;
    verdict: "passed" | "failed" | "blocked" | "unverified";
    reason: string;
    assertionResults: { assertionId: string; pass: boolean }[];
  }[];
};

export type RequirementCoverage = {
  id: string;
  text: string;
  quote: string;
  /** Where the requirement's authority comes from, when the run recorded it. */
  origin?: string;
  status: RequirementStatus;
  /** Where the status comes from: comparisons made, or why none was. */
  detail: string;
};

export type Assessment = {
  readiness: Readiness;
  /** Why the run is not "ready". Empty when it is. */
  reasons: string[];
  execution: { passed: number; failed: number; blocked: number; unverified: number };
  /** Scenarios planned but never started, waiting on a decision or a capability. */
  notRun: number;
  requirements: RequirementCoverage[];
  counts: Record<RequirementStatus, number>;
};

export function assess(run: ReadinessInput): Assessment {
  const resultOf = new Map(run.results.map((r) => [r.scenarioId, r]));
  const requirements: RequirementCoverage[] = run.analysis.requirements
    .filter((r) => r.kind === "documented")
    .map((requirement) => {
      const comparisons: string[] = [];
      const uncompared: string[] = [];
      const waiting: string[] = [];
      let mismatch = false;

      for (const planned of run.plan.scenarios) {
        const { scenario } = planned;
        const result = resultOf.get(scenario.id);
        if (!result) {
          // Never started. It only counts for this requirement if the plan tied it to it.
          if (scenario.requirementIds?.includes(requirement.id)) {
            waiting.push(`${scenario.id}: ${planned.blockedReason || "not run"}`);
          }
          continue;
        }
        for (const assertion of scenario.assertions.filter((a) => a.requirementId === requirement.id)) {
          const outcome = result.assertionResults.find((a) => a.assertionId === assertion.id);
          if (!outcome) uncompared.push(`${scenario.id}/${assertion.id} (${result.verdict}: ${result.reason})`);
          else {
            comparisons.push(`${scenario.id}/${assertion.id} ${outcome.pass ? "match" : "MISMATCH"}`);
            if (!outcome.pass) mismatch = true;
          }
        }
      }

      const base = { id: requirement.id, text: requirement.text, quote: requirement.quote, origin: requirement.origin };
      if (mismatch) return { ...base, status: "failed" as const, detail: comparisons.join("; ") };
      if (comparisons.length > 0) return { ...base, status: "verified" as const, detail: comparisons.join("; ") };
      if (uncompared.length > 0) return { ...base, status: "unverified" as const, detail: uncompared.join("; ") };
      if (waiting.length > 0) return { ...base, status: "blocked" as const, detail: waiting.join("; ") };
      return { ...base, status: "not planned" as const, detail: "No scenario in the plan compares this requirement." };
    });

  const counts: Record<RequirementStatus, number> = { verified: 0, failed: 0, blocked: 0, unverified: 0, "not planned": 0 };
  for (const r of requirements) counts[r.status]++;
  const verdicts = (v: string) => run.results.filter((r) => r.verdict === v).length;
  const execution = {
    passed: verdicts("passed"),
    failed: verdicts("failed"),
    blocked: verdicts("blocked"),
    unverified: verdicts("unverified"),
  };
  const notRun = run.plan.scenarios.filter((s) => !resultOf.has(s.scenario.id)).length;
  const trimmed = run.plan.trimmedRunnable ?? 0;

  const reasons: string[] = [];
  if (execution.failed > 0) reasons.push(`${execution.failed} scenario${execution.failed === 1 ? "" : "s"} failed`);
  const gaps = requirements.length - counts.verified - counts.failed;
  if (gaps > 0) reasons.push(`${gaps} of ${requirements.length} documented requirements were not verified`);
  if (execution.blocked + execution.unverified > 0) {
    reasons.push(`${execution.blocked + execution.unverified} executed scenario${execution.blocked + execution.unverified === 1 ? "" : "s"} produced no verdict`);
  }
  if (notRun > 0) reasons.push(`${notRun} planned scenario${notRun === 1 ? " is" : "s are"} waiting on a decision or a capability`);
  if (trimmed > 0) reasons.push(`${trimmed} runnable scenario${trimmed === 1 ? " was" : "s were"} dropped to stay within the scenario limit`);
  if (run.stopped) reasons.push("the run ended early");
  if (run.results.length === 0) reasons.push("no scenario was executed");
  if (requirements.length === 0) reasons.push("no approved requirement was identified");
  const conflicts = run.analysis.conflicts?.length ?? 0;
  if (conflicts > 0) {
    reasons.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"} about the approved requirements ${conflicts === 1 ? "is" : "are"} unresolved`);
  }
  // A rule replaced on the analyst's reading alone is applied, but an owner has not said so.
  const inferred = (run.analysis.supersessions ?? []).filter((s) => s.how !== "owner-line").length;
  if (inferred > 0) {
    reasons.push(`${inferred} earlier rule${inferred === 1 ? " was" : "s were"} taken as replaced by a later comment without the requirement owner stating it`);
  }

  const readiness: Readiness = execution.failed > 0 || counts.failed > 0 ? "not ready" : reasons.length > 0 ? "incomplete" : "ready";
  return { readiness, reasons, execution, notRun, requirements, counts };
}

export const READINESS_LABEL: Record<Readiness, string> = {
  "not ready": "Not ready",
  incomplete: "Incomplete",
  ready: "Ready",
};

/** One line that leads with readiness and never lets "passed" stand alone. */
export function headline(a: Assessment): string {
  const total = a.requirements.length;
  const parts = [
    `${a.execution.failed} failed, ${a.execution.passed} passed`,
    `${a.counts.verified} of ${total} requirements verified`,
  ];
  const noVerdict = a.execution.blocked + a.execution.unverified;
  if (noVerdict > 0) parts.push(`${noVerdict} without a verdict`);
  if (a.notRun > 0) parts.push(`${a.notRun} scenarios blocked`);
  return `${READINESS_LABEL[a.readiness]}: ${parts.join(" · ")}`;
}
