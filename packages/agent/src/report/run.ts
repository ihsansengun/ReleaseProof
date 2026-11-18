import type { RunReport } from "../schema.ts";

const cell = (value: unknown) => String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** Which documented requirements were actually compared against the application. */
export function coverage(run: RunReport) {
  const compared = new Map<string, Set<string>>();
  for (const planned of run.plan.scenarios) {
    const result = run.results.find((r) => r.scenarioId === planned.scenario.id);
    if (!result) continue;
    for (const assertion of planned.scenario.assertions) {
      const outcome = result.assertionResults.find((a) => a.assertionId === assertion.id);
      if (!outcome || !assertion.requirementId) continue;
      const set = compared.get(assertion.requirementId) ?? new Set();
      set.add(`${planned.scenario.id}/${assertion.id} ${outcome.pass ? "match" : "MISMATCH"}`);
      compared.set(assertion.requirementId, set);
    }
  }
  const documented = run.analysis.requirements.filter((r) => r.kind === "documented");
  return { documented, compared, covered: documented.filter((r) => compared.has(r.id)).length };
}

/** The QA report for one ticket and pull request. */
export function renderRunReport(run: RunReport): string {
  const { documented, compared, covered } = coverage(run);
  const count = (verdict: string) => run.results.filter((r) => r.verdict === verdict).length;
  const blocked = run.plan.scenarios.filter((s) => s.status === "blocked");
  const lines: string[] = [];

  lines.push(
    `# QA report: ${run.ticketKey} — pull request #${run.pullRequest.number}`,
    "",
    `**${run.pullRequest.title}** · ${run.pullRequest.repo} @ \`${run.pullRequest.headSha.slice(0, 10)}\``,
    "",
    "## Summary",
    "",
    `- Scenarios executed: ${run.results.length} — ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked during execution, ${count("unverified")} unverified`,
    `- Scenarios planned but not run: ${blocked.length} (waiting on a decision or a missing capability)`,
    `- Documented requirements compared against the application: ${covered} of ${documented.length}`,
    `- Clarification requests: ${run.analysis.ambiguities.length + run.plan.clarifications.length}`,
    `- Environment: ${run.environment.baseUrl}, commit \`${run.environment.deployedSha ?? "not reported"}\``,
    `- Model work done by: ${run.driver}`,
    "",
  );

  const failures = run.results.filter((r) => r.verdict === "failed");
  lines.push("## Failures", "");
  if (failures.length === 0) lines.push("None.", "");
  for (const failure of failures) {
    const planned = run.plan.scenarios.find((s) => s.scenario.id === failure.scenarioId)!;
    lines.push(`### ${failure.scenarioId} ${failure.title}`, "");
    for (const outcome of failure.assertionResults.filter((a) => !a.pass)) {
      const assertion = planned.scenario.assertions.find((a) => a.id === outcome.assertionId)!;
      const source = run.analysis.requirements.find((r) => r.id === assertion.requirementId);
      lines.push(
        `- **${assertion.description}**: expected ${outcome.expected}, actual ${outcome.actual}`,
        `  - Requirement ${source?.id}: "${source?.quote}"`,
        `  - Evidence: [screenshot](scenarios/${failure.scenarioId}/${outcome.screenshot}), [steps](scenarios/${failure.scenarioId}/report.md)`,
      );
    }
    lines.push(`- Replayed without a model: ${run.confirmations[failure.scenarioId] ?? "not attempted"}`, "");
  }

  lines.push(
    "## Requirement coverage",
    "",
    "| Id | Requirement | Source quote | Compared by |",
    "|---|---|---|---|",
    ...documented.map(
      (r) => `| ${r.id} | ${cell(r.text)} | "${cell(r.quote)}" | ${[...(compared.get(r.id) ?? ["**not compared**"])].join("<br>")} |`,
    ),
    "",
  );
  const inferred = run.analysis.requirements.filter((r) => r.kind === "inferred");
  if (inferred.length > 0) {
    lines.push("Inferred, not stated in any source (never used as an expected value):", "");
    for (const r of inferred) lines.push(`- ${r.id}: ${r.text}`);
    lines.push("");
  }

  lines.push("## Clarification requests", "");
  if (run.analysis.ambiguities.length + run.plan.clarifications.length === 0) lines.push("None.", "");
  for (const q of run.analysis.ambiguities) lines.push(`- **${q.id}** ${q.question}`, `  - ${q.why}`);
  for (const q of run.plan.clarifications) lines.push(`- (from planning ${q.scenarioId}) ${q.question}`);
  lines.push("");

  lines.push("## Scenarios", "", "| Id | Basis | Title | Result | Detail |", "|---|---|---|---|---|");
  for (const planned of run.plan.scenarios) {
    const result = run.results.find((r) => r.scenarioId === planned.scenario.id);
    lines.push(
      result
        ? `| [${result.scenarioId}](scenarios/${result.scenarioId}/report.md) | ${planned.scenario.basis} | ${cell(result.title)} | ${result.verdict} | ${cell(result.reason)} |`
        : `| ${planned.scenario.id} | ${planned.scenario.basis} | ${cell(planned.scenario.title)} | not run | ${cell(planned.blockedReason)} |`,
    );
  }
  lines.push("");

  if (run.analysis.risks.length > 0) {
    lines.push("## Risks identified", "");
    for (const k of run.analysis.risks) {
      const probes = run.plan.scenarios.filter((s) => s.riskIds.includes(k.id)).map((s) => s.scenario.id);
      lines.push(`- **${k.id}** ${k.description} — ${probes.length ? `probed by ${probes.join(", ")}` : "not probed"}`);
    }
    lines.push("");
  }

  const notes = [...run.analysisNotes, ...run.plan.notes, ...run.context.omitted.map((o) => `Not read: ${o}`)];
  if (notes.length > 0) {
    lines.push("## Notes from automatic checks", "");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push(
    "## Inputs and timing",
    "",
    `- Documentation read: ${run.context.docs.join(", ") || "none"}`,
    `- Changed files: ${run.context.changedFiles.join(", ")}`,
    `- Stages: ${run.timings.map((t) => `${t.stage} ${t.seconds}s`).join(", ")}`,
    `- Tool calls in execution: ${run.results.reduce((n, r) => n + r.steps.length, 0)}`,
    "",
  );
  return lines.join("\n");
}
