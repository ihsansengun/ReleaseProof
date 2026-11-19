/** Words for how the scenarios that ran were chosen, and for what was left out. */
type Input = {
  plan: {
    selection?: { cap: number; candidates: number; policy: string; boundaryGaps: string[] };
    scenarios: { status: string; scenario: { id: string; title: string }; selection?: { rank?: number; score: number; reasons: string[] } }[];
  };
};

export function selectionLines(run: Input, safe: (text: unknown, max?: number) => string, heading = "###"): string[] {
  const selection = run.plan.selection;
  if (!selection || selection.candidates <= selection.cap) return [];
  const chosen = run.plan.scenarios.filter((s) => s.selection?.rank !== undefined).sort((a, b) => a.selection!.rank! - b.selection!.rank!);
  const deferred = run.plan.scenarios.filter((s) => s.status === "deferred");
  const lines = [
    `${heading} Scenario selection`,
    "",
    `${selection.candidates} runnable scenarios were planned and the limit is ${selection.cap}. ${
      selection.policy === "coverage"
        ? "Code chose them one at a time, each time taking the scenario that adds most to what the chosen ones already cover: a first comparison of an approved requirement counts 3, a new position at a threshold 2, a new access-control or ownership check 2, a new state change, side effect or risk 1. Ties go to the scenario the planner listed first."
        : "The plan declares no focus, so they were taken as the planner listed them."
    }`,
    "",
    "| Rank | Scenario | Adds |",
    "|---|---|---|",
    ...chosen.map((s) => `| ${s.selection!.rank} | ${safe(s.scenario.id, 20)} ${safe(s.scenario.title, 120)} | ${safe(s.selection!.reasons.join("; "), 300)} |`),
    "",
    `${heading} Not run because of the scenario limit`,
    "",
    "These scenarios are complete in the plan and were not executed. What each would have added to the ones that ran:",
    "",
    ...deferred.map((s) => `- **${safe(s.scenario.id, 20)}** ${safe(s.scenario.title, 140)}: ${s.selection?.reasons.length ? safe(s.selection.reasons.join("; "), 300) : "nothing the scenarios that ran do not already cover"}`),
    "",
  ];
  if (selection.boundaryGaps.length > 0) {
    lines.push("Thresholds left untested:", "", ...selection.boundaryGaps.slice(0, 30).map((g) => `- ${safe(g, 200)}`), "");
  }
  return lines;
}
