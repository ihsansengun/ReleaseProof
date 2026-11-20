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
type Signal = { step: number; actor?: { alias: string; step: number }; action: { step: number; tool: string; what: string }; page: string; text: string };
type Input = { results: { scenarioId: string; title: string; verdict: string; applicationErrors?: Error[]; errorSignals?: Signal[] }[] };

export function applicationErrorLines(run: Input, safe: (text: unknown, max?: number) => string, heading = "###"): string[] {
  const met = run.results.filter((r) => r.applicationErrors?.length);
  // Text that read like a failure and was not taken up: shown so that a person can look, and counted as nothing.
  const leads = run.results.flatMap((r) =>
    (r.errorSignals ?? []).filter((g) => !(r.applicationErrors ?? []).some((e) => e.text.includes(g.text) || g.text.includes(e.text))).map((g) => ({ r, g })),
  );
  const unconfirmed =
    leads.length === 0
      ? []
      : [
          `${heading} Possible application errors, not confirmed`,
          "",
          "After these steps the page newly showed text that reads like a failure of the application. It was noticed from the words alone and nothing was concluded from it: no verdict rests on it.",
          "",
          ...leads.slice(0, 20).map(({ r, g }) => `- **${safe(r.scenarioId, 20)}** step ${g.step}${g.actor ? `, signed in as ${safe(g.actor.alias, 40)}` : ""}, after ${safe(`${g.action.tool} ${g.action.what}`, 120)}, on ${safe(g.page, 120)}: ${safe(g.text, 300)}`),
          "",
        ];
  if (met.length === 0) return unconfirmed;
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
  lines.push("", ...unconfirmed);
  return lines;
}
