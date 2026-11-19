/**
 * Groups failed comparisons so that one defect seen in many places is not
 * read as many defects.
 *
 * This is arithmetic on recorded values, not a diagnosis. Two rules, applied
 * in code:
 *
 *   1. Failed numeric comparisons anywhere in the run whose observed value
 *      is off by the same amount form one pattern.
 *   2. A failed comparison that is not numeric joins the first numeric
 *      pattern of its own scenario, or, if that scenario has none, forms a
 *      pattern with the scenario's other non-numeric failures.
 *
 * A pattern is a rough guide to distinct causes. Two defects can produce the
 * same difference, and one defect can produce several. Every comparison in
 * a pattern is listed, so nothing is hidden by the grouping.
 */
export type PatternInput = {
  plan: { scenarios: { scenario: { id: string; assertions: { id: string; requirementId?: string; alsoVerifies?: string[] }[] } }[] };
  results: { scenarioId: string; assertionResults: { assertionId: string; expected: string | number; actual: string | number; pass: boolean }[] }[];
};

export type FailurePattern = {
  id: string;
  /** What the comparisons in the pattern have in common, in words. */
  description: string;
  comparisons: { scenarioId: string; assertionId: string; expected: string | number; actual: string | number }[];
  scenarios: string[];
  /** Requirements the failed comparisons rest on directly. */
  requirementIds: string[];
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function failurePatterns(run: PatternInput): FailurePattern[] {
  type Failure = FailurePattern["comparisons"][number] & { requirementId?: string };
  const failures: Failure[] = [];
  for (const result of run.results) {
    const planned = run.plan.scenarios.find((s) => s.scenario.id === result.scenarioId);
    for (const outcome of result.assertionResults) {
      if (outcome.pass) continue;
      const assertion = planned?.scenario.assertions.find((a) => a.id === outcome.assertionId);
      failures.push({ scenarioId: result.scenarioId, assertionId: outcome.assertionId, expected: outcome.expected, actual: outcome.actual, requirementId: assertion?.requirementId });
    }
  }

  const groups = new Map<string, { description: string; members: Failure[] }>();
  const firstNumericOf = new Map<string, string>();
  const numeric = (f: Failure) => typeof f.expected === "number" && typeof f.actual === "number";
  for (const f of failures.filter(numeric)) {
    const off = round(Math.abs((f.actual as number) - (f.expected as number)));
    const key = `number:${off}`;
    if (!groups.has(key)) groups.set(key, { description: `a number that is off by ${off}`, members: [] });
    groups.get(key)!.members.push(f);
    if (!firstNumericOf.has(f.scenarioId)) firstNumericOf.set(f.scenarioId, key);
  }
  for (const f of failures.filter((x) => !numeric(x))) {
    const key = firstNumericOf.get(f.scenarioId) ?? `scenario:${f.scenarioId}`;
    if (!groups.has(key)) groups.set(key, { description: `text or presence that differs, in scenario ${f.scenarioId}`, members: [] });
    groups.get(key)!.members.push(f);
  }

  return [...groups.values()].map((group, index) => ({
    id: `F${index + 1}`,
    description: group.description,
    comparisons: group.members.map(({ requirementId: _unused, ...comparison }) => comparison),
    scenarios: [...new Set(group.members.map((m) => m.scenarioId))],
    requirementIds: [...new Set(group.members.map((m) => m.requirementId).filter((id): id is string => !!id))],
  }));
}
