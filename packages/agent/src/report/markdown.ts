import type { Scenario, ScenarioResult } from "../schema.ts";

const cell = (value: unknown) =>
  String(typeof value === "string" ? value : JSON.stringify(value))
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ");

/** Compact, human-readable form of a tool input, without the rationale. */
function describeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return cell(input);
  const { rationale: _omit, ...rest } = input as Record<string, unknown>;
  return cell(rest);
}

/** One scenario's decisions, interactions, comparisons and evidence. */
export function renderReport(scenario: Scenario, result: ScenarioResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.scenarioId} ${result.title}`, "");
  lines.push(`**Verdict: ${result.verdict.toUpperCase()}** — ${result.reason}`, "");
  lines.push(
    `- Steps chosen by: ${result.mode === "replay" ? "recording (no model)" : (result.driver ?? "model")}`,
    `- Environment: ${result.environment.baseUrl}, commit ${result.environment.deployedSha ?? "not reported"}`,
    `- Started ${result.startedAt}, took ${(result.durationMs / 1000).toFixed(1)} s, ${result.steps.length} tool calls`,
    `- Basis: ${scenario.basis}; requirements ${scenario.requirementIds.join(", ") || "none"}`,
    "",
    "## Objective",
    "",
    scenario.intent,
    "",
    "## Assertions",
    "",
    "Expected values were fixed in the plan; actual values were read and compared in code.",
    "",
    "| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |",
    "|---|---|---|---|---|---|---|",
  );
  for (const assertion of scenario.assertions) {
    const r = result.assertionResults.find((x) => x.assertionId === assertion.id);
    const planned = "literal" in assertion.expected ? assertion.expected.literal : assertion.expected.formula;
    lines.push(
      `| ${assertion.id} | ${cell(assertion.description)} | \`${cell(planned)}\` | ${r ? cell(r.expected) : ""} | ${r ? cell(r.actual) : ""} | ${r ? (r.pass ? "match" : "**MISMATCH**") : "not checked"} | ${r?.screenshot ? `[${r.screenshot}](${r.screenshot})` : ""} |`,
    );
  }
  const observed = Object.entries(result.observations);
  if (observed.length > 0) {
    lines.push("", "## Observations", "");
    for (const [name, value] of observed) lines.push(`- \`${name}\` = ${value}`);
  }
  lines.push(
    "",
    "## Steps",
    "",
    "| # | Tool | Input | Outcome | Stated reason |",
    "|---|---|---|---|---|",
  );
  result.steps.forEach((step, i) => {
    lines.push(
      `| ${i + 1} | ${step.tool} | ${describeInput(step.input)} | ${step.ok ? "" : "error: "}${cell(step.summary)} | ${cell(step.rationale ?? "")} |`,
    );
  });
  lines.push("", "## Evidence", "", `- Playwright trace: \`${result.evidence.trace}\` (open with \`npx playwright show-trace\`)`);
  for (const r of result.assertionResults) {
    if (r.screenshot) lines.push(`- ${r.assertionId}: ![${r.assertionId}](${r.screenshot})`);
  }
  return `${lines.join("\n")}\n`;
}
