/**
 * How much stands behind one failed comparison.
 *
 * Replaying a failed scenario without a model repeats the same steps with the
 * same locators. If a locator pointed at the wrong element, the replay reads
 * the wrong element again. That shows the result is repeatable; it does not
 * show the application is at fault. What does add weight is evidence reached
 * another way: the application's own API response, a second comparison of the
 * same requirement through a different target, or a second attempt that found
 * its own way to the value and saw the same thing.
 */
import type { Assertion, AssertionResult, ScenarioResult } from "../schema.ts";

export type Standing =
  /** Read from an API response of the application: its own statement of its state. */
  | "state"
  /** Another failed comparison of the same requirement, through a different target, agrees. */
  | "corroborated"
  /** A second attempt located the value its own way and saw the same mismatch. */
  | "re-resolved"
  /** One reading from the page, through one locator. Repeating it adds nothing. */
  | "single";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Read from an API response, directly or through an observation that was recorded from one. */
const fromApi = (r: AssertionResult) => {
  const target = r.target as { source?: unknown; from?: unknown } | null;
  return target?.source === "api" || (target?.source === "observation" && target.from === "api");
};
const requirementsOf = (a: Assertion | undefined) => new Set([a?.requirementId, ...(a?.alsoVerifies ?? [])].filter((id): id is string => !!id));

/** The standing of each failed comparison of one scenario result. `other` is another attempt at the same scenario, if there was one. */
export function standings(assertions: Assertion[], result: Pick<ScenarioResult, "assertionResults">, other?: Pick<ScenarioResult, "assertionResults">): Map<string, Standing> {
  const failed = result.assertionResults.filter((r) => !r.pass);
  const out = new Map<string, Standing>();
  for (const r of failed) {
    if (fromApi(r)) {
      out.set(r.assertionId, "state");
      continue;
    }
    const mine = requirementsOf(assertions.find((a) => a.id === r.assertionId));
    const agreeing = failed.some(
      (o) =>
        o.assertionId !== r.assertionId &&
        !same(o.target, r.target) &&
        [...requirementsOf(assertions.find((a) => a.id === o.assertionId))].some((id) => mine.has(id)),
    );
    if (agreeing) {
      out.set(r.assertionId, "corroborated");
      continue;
    }
    const again = other?.assertionResults.find((o) => o.assertionId === r.assertionId);
    out.set(r.assertionId, again && !again.pass && !same(again.target, r.target) ? "re-resolved" : "single");
  }
  return out;
}

/** True when a failed result rests on nothing but single page observations. */
export function restsOnSingleObservations(assertions: Assertion[], result: Pick<ScenarioResult, "assertionResults">): boolean {
  const all = [...standings(assertions, result).values()];
  return all.length > 0 && all.every((s) => s === "single");
}

/**
 * Failed page comparisons of `kept` that another attempt, pointing at a
 * different element, compared and found matching. Two locators disagree about
 * the same fixed expectation, so neither reading settles it.
 */
export function contradicted(assertions: Assertion[], kept: Pick<ScenarioResult, "assertionResults">, other: Pick<ScenarioResult, "assertionResults">): { mine: AssertionResult; theirs: AssertionResult }[] {
  const standing = standings(assertions, kept);
  return kept.assertionResults.flatMap((mine) => {
    if (mine.pass || standing.get(mine.assertionId) !== "single") return [];
    const theirs = other.assertionResults.find((o) => o.assertionId === mine.assertionId);
    return theirs?.pass && !same(theirs.target, mine.target) ? [{ mine, theirs }] : [];
  });
}

export const STANDING_TEXT: Record<Standing, string> = {
  state: "read from the application's own API response",
  corroborated: "another comparison of the same requirement, through a different target, also failed",
  "re-resolved": "a second attempt located the value its own way and saw the same mismatch",
  single: "a single page observation; not independently confirmed, so check the locator before treating it as a defect",
};
