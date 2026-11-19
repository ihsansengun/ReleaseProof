/**
 * Groups failed comparisons so that one cause seen in many places is not
 * read as many, and says how much evidence each group has.
 *
 * Four different things are counted and never mixed:
 *
 *   failed assertions   comparisons that did not match
 *   failed scenarios    scenarios with at least one such comparison
 *   failure patterns    groups of failed comparisons that belong together
 *   confirmed distinct defects   patterns with evidence beyond one page reading
 *
 * Grouping is arithmetic on the record, not a diagnosis. Two failed
 * comparisons belong together when they rest on a common approved
 * requirement, or when they are numbers off by the same amount. A pattern is "confirmed" only when at least one of its comparisons
 * is backed by the application's own API response, by a second comparison
 * through another target, or by a second attempt that located the value its
 * own way, and that scenario's failure repeats. Anything else is an
 * unconfirmed pattern: it may be a defect, a wrong locator or a wrong
 * expectation, and the report does not call it a defect.
 */
export type PatternInput = {
  plan: { scenarios: { scenario: { id: string; assertions: { id: string; requirementId?: string; alsoVerifies?: string[] }[] } }[] };
  results: { scenarioId: string; assertionResults: { assertionId: string; expected: string | number; actual: string | number; pass: boolean; standing?: string }[] }[];
  confirmations?: Record<string, string>;
};

export type FailurePattern = {
  id: string;
  /** What the comparisons in the pattern have in common, in words. */
  description: string;
  comparisons: { scenarioId: string; assertionId: string; expected: string | number; actual: string | number }[];
  scenarios: string[];
  /** Requirements the failed comparisons rest on directly. */
  requirementIds: string[];
  /** Whether the pattern has evidence beyond a single page reading. */
  evidence: "confirmed" | "unconfirmed";
  /** Why it is classed that way. */
  basis: string;
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const BACKED = new Set(["state", "corroborated", "re-resolved"]);
const BASIS: Record<string, string> = {
  state: "the application's own API response",
  corroborated: "a second comparison through another target",
  "re-resolved": "a second attempt that located the value its own way",
};

export function failurePatterns(run: PatternInput): FailurePattern[] {
  type Failure = FailurePattern["comparisons"][number] & { requirementId?: string; linked: string[]; standing?: string };
  const failures: Failure[] = [];
  for (const result of run.results) {
    const planned = run.plan.scenarios.find((s) => s.scenario.id === result.scenarioId);
    for (const outcome of result.assertionResults) {
      if (outcome.pass) continue;
      const assertion = planned?.scenario.assertions.find((a) => a.id === outcome.assertionId);
      failures.push({
        scenarioId: result.scenarioId,
        assertionId: outcome.assertionId,
        expected: outcome.expected,
        actual: outcome.actual,
        requirementId: assertion?.requirementId,
        linked: [assertion?.requirementId, ...(assertion?.alsoVerifies ?? [])].filter((id): id is string => !!id),
        standing: outcome.standing,
      });
    }
  }

  // A difference is only meaningful between two quantities. Two HTTP status
  // codes are both numbers, and subtracting them says nothing.
  const status = (v: string | number) => typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599;
  const difference = (f: Failure): number | undefined =>
    typeof f.expected === "number" && typeof f.actual === "number" && !(status(f.expected) && status(f.actual)) ? round(Math.abs(f.actual - f.expected)) : undefined;

  // Union-find: failures joined by a common requirement, or by the same amount.
  const parent = failures.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  failures.forEach((a, i) => {
    failures.forEach((b, j) => {
      if (j <= i) return;
      const sharedRequirement = a.linked.some((id) => b.linked.includes(id));
      const sameAmount = difference(a) !== undefined && difference(a) === difference(b);
      if (sharedRequirement || sameAmount) join(i, j);
    });
  });

  const groups = new Map<number, Failure[]>();
  failures.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));

  return [...groups.values()].map((members, index) => {
    const requirementIds = [...new Set(members.map((m) => m.requirementId).filter((id): id is string => !!id))];
    const scenarios = [...new Set(members.map((m) => m.scenarioId))];
    const amounts = [...new Set(members.map(difference).filter((d): d is number => d !== undefined))];
    const other = members.some((m) => difference(m) === undefined);
    const what = [amounts.length > 0 ? `number${amounts.length === 1 && members.length === 1 ? "" : "s"} off by ${amounts.join(", ")}` : "", other ? "text, presence or status that differs" : ""].filter(Boolean).join("; ");
    const backing = members.find((m) => m.standing && BACKED.has(m.standing) && run.confirmations?.[m.scenarioId] === "reproduced");
    const backedNotRepeating = members.find((m) => m.standing && BACKED.has(m.standing));
    return {
      id: `F${index + 1}`,
      description: `${requirementIds.length > 0 ? `comparisons resting on ${requirementIds.join(", ")}` : `comparisons in scenario ${scenarios.join(", ")}`}: ${what}`,
      comparisons: members.map(({ requirementId: _r, linked: _l, standing: _s, ...comparison }) => comparison),
      scenarios,
      requirementIds,
      evidence: backing ? ("confirmed" as const) : ("unconfirmed" as const),
      basis: backing
        ? `${backing.scenarioId}/${backing.assertionId} is backed by ${BASIS[backing.standing!]}, and the failure repeats`
        : backedNotRepeating
          ? `${backedNotRepeating.scenarioId}/${backedNotRepeating.assertionId} is backed by ${BASIS[backedNotRepeating.standing!]}, but the failure did not repeat when replayed`
          : "rests on single page observations; nothing else confirms it",
    };
  });
}

/** The four counts a report gives, kept apart. */
export function failureCounts(run: PatternInput): { assertions: number; scenarios: number; patterns: number; confirmed: number } {
  const patterns = failurePatterns(run);
  return {
    assertions: patterns.reduce((n, p) => n + p.comparisons.length, 0),
    scenarios: run.results.filter((r) => r.assertionResults.some((a) => !a.pass)).length,
    patterns: patterns.length,
    confirmed: patterns.filter((p) => p.evidence === "confirmed").length,
  };
}
