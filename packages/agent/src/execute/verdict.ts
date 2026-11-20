import type { ApplicationError, Assertion, AssertionResult, Outcome, Verdict } from "../schema.ts";

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

/** What makes two error answers the same one: the request and status, or the place and the text. Numbers in addresses vary between runs and are left out. */
const signature = (e: ApplicationError) =>
  e.source === "response" ? `response ${e.request?.method} ${(e.request?.path ?? "").replace(/\d+/g, "N")} ${e.request?.status}` : `page ${e.locatedBy} ${e.text.replace(/\d+/g, "N")}`;

/** The errors of a first run that the same steps met again without a model. */
export function repeatedErrors(first: ApplicationError[] | undefined, replay: ApplicationError[] | undefined): ApplicationError[] {
  const again = new Set((replay ?? []).map(signature));
  return (first ?? []).filter((e) => again.has(signature(e)));
}

export const describeError = (e: ApplicationError) =>
  e.source === "response" ? `${e.request?.method} ${e.request?.path} answered HTTP ${e.request?.status}${e.text ? `: "${e.text}"` : ""}` : `the page showed "${e.text}"`;

/**
 * A scenario that ended without a verdict, in which the application answered
 * with an error that repeats, is "errored": the application stopped it. A
 * mismatch stays a failure and a pass stays a pass, whatever else happened;
 * an error seen once, or a scenario stopped by anything else, stays as it was.
 */
export function erroredVerdict(
  result: { verdict: Verdict; reason: string; applicationErrors?: ApplicationError[] },
  replay: { applicationErrors?: ApplicationError[] } | undefined,
): { verdict: Verdict; reason: string } | undefined {
  if (result.verdict !== "blocked" && result.verdict !== "unverified") return undefined;
  const repeated = repeatedErrors(result.applicationErrors, replay?.applicationErrors);
  if (repeated.length === 0) return undefined;
  const last = repeated[repeated.length - 1]!;
  const after = last.action ? ` after ${last.action.tool} ${last.action.what} (step ${last.action.step})` : "";
  return { verdict: "errored", reason: `Application error${after}: ${describeError(last)}. The same steps met it again without a model. ${result.reason}` };
}
