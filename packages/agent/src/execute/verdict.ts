import type { Assertion, AssertionResult, Outcome, Verdict } from "../schema.ts";

/**
 * The verdict is a function of recorded comparisons, never of what the
 * executor says about them.
 *
 *   failed      a recorded comparison did not match
 *   passed      every assertion was compared and matched
 *   blocked     not everything was compared, and the executor reported an obstacle
 *   unverified  not everything was compared, for any other reason
 */
export function computeVerdict(
  assertions: Assertion[],
  results: AssertionResult[],
  outcome: Outcome,
): { verdict: Verdict; reason: string } {
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    return {
      verdict: "failed",
      reason: failed.map((r) => `${r.assertionId}: expected ${r.expected}, got ${r.actual}`).join("; "),
    };
  }

  const checked = new Set(results.map((r) => r.assertionId));
  const missing = assertions.filter((a) => !checked.has(a.id)).map((a) => a.id);
  if (missing.length === 0) {
    return { verdict: "passed", reason: `All ${assertions.length} assertions matched.` };
  }

  const prefix = `Not checked: ${missing.join(", ")}.`;
  if (outcome.kind === "blocked") return { verdict: "blocked", reason: `${prefix} ${outcome.reason}` };
  return { verdict: "unverified", reason: `${prefix} ${outcome.reason}` };
}
