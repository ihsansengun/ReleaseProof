/**
 * Words for the inputs and values the requirements themselves name, and for
 * what became of each. Only shown when a source names any.
 */
type Input = { requirements: { id: string; examples?: { id: string; input: string; expected: string; status: string; detail: string }[] }[] };

const WORDS: Record<string, string> = {
  matched: "compared, matched",
  mismatched: "**compared, did not match**",
  errored: "**not compared: the application answered with an error**",
  blocked: "not compared: blocked",
  unverified: "not compared",
  deferred: "not run (scenario limit)",
  "not planned": "in no scenario of the plan",
};

export function exampleLines(assessment: Input, safe: (text: unknown, max?: number) => string, heading = "###"): string[] {
  const rows = assessment.requirements.flatMap((r) => (r.examples ?? []).map((e) => ({ requirement: r.id, ...e })));
  if (rows.length === 0) return [];
  const compared = rows.filter((e) => e.status === "matched" || e.status === "mismatched").length;
  return [
    `${heading} Stated examples`,
    "",
    `The requirements name ${rows.length} particular input${rows.length === 1 ? "" : "s"} or value${rows.length === 1 ? "" : "s"}. ${compared} ${compared === 1 ? "was" : "were"} compared. A requirement counts as verified only when every one it names was compared and matched.`,
    "",
    "| Requirement | Example | Stated input | Stated result | What became of it |",
    "|---|---|---|---|---|",
    ...rows.map((e) => `| ${safe(e.requirement, 20)} | ${safe(e.id, 20)} | ${safe(e.input, 80)} | ${safe(e.expected, 120)} | ${WORDS[e.status] ?? safe(e.status, 30)}: ${safe(e.detail, 200)} |`),
    "",
  ];
}
