/**
 * Words for the errors the application answered with during a run.
 *
 * An error that repeated and stopped a scenario is a finding. One seen once,
 * or seen in a scenario that still reached its comparisons, is listed too,
 * so nothing the application said is lost; it changes no verdict.
 */
type Error = {
  step: number;
  source: string;
  actor?: { alias: string; step: number };
  action?: { step: number; tool: string; what: string };
  request?: { method: string; path: string; status: number };
  page?: string;
  locatedBy?: string;
  text: string;
};
type Input = { results: { scenarioId: string; title: string; verdict: string; applicationErrors?: Error[] }[] };

export function applicationErrorLines(run: Input, safe: (text: unknown, max?: number) => string, heading = "###"): string[] {
  const met = run.results.filter((r) => r.applicationErrors?.length);
  if (met.length === 0) return [];
  const lines = [
    `${heading} Application errors`,
    "",
    "The application answered with an error during these scenarios. Where the same steps met the same error again without a model and the scenario could not reach its comparisons, the scenario is counted as stopped by the application, not as blocked.",
    "",
    "| Scenario | Counted as | Signed in as | Action | What the application answered |",
    "|---|---|---|---|---|",
  ];
  for (const r of met) {
    for (const e of r.applicationErrors!) {
      const what = e.source === "response" ? `${e.request?.method} ${e.request?.path} → HTTP ${e.request?.status}${e.text ? `: ${e.text}` : ""}` : `shown on ${e.page ?? "the page"} (${e.locatedBy}): ${e.text}`;
      lines.push(
        `| ${safe(r.scenarioId, 20)} ${safe(r.title, 80)} | ${r.verdict === "errored" ? "**application error, repeats**" : `${safe(r.verdict, 20)}; error seen, did not decide the result`} | ${e.actor ? safe(e.actor.alias, 40) : "–"} | ${e.action ? `step ${e.action.step}: ${safe(`${e.action.tool} ${e.action.what}`, 120)}` : "–"} | ${safe(what, 300)} |`,
      );
    }
  }
  lines.push("");
  return lines;
}
