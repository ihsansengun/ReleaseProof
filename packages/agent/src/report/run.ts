import type { RunReport } from "../schema.ts";
import { authorityLines } from "./authority.ts";
import { assess, headline, READINESS_LABEL } from "./readiness.ts";

const cell = (value: unknown) => String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** Which documented requirements were actually compared against the application. */
export function coverage(run: RunReport) {
  const assessment = assess(run);
  const documented = run.analysis.requirements.filter((r) => r.kind === "documented");
  return { documented, covered: assessment.counts.verified + assessment.counts.failed, assessment };
}

export const MODES = {
  autonomous: "autonomous (a live model analysed, planned and executed this run)",
  replay: "replay (scenarios from an earlier autonomous run, re-run on this commit)",
  recorded: "recorded (no live model; an earlier run's decisions were replayed)",
} as const;

/** The QA report for one ticket and pull request. */
export function renderRunReport(run: RunReport): string {
  const { documented, assessment } = coverage(run);
  const count = (verdict: string) => run.results.filter((r) => r.verdict === verdict).length;
  const blocked = run.plan.scenarios.filter((s) => s.status === "blocked");
  const lines: string[] = [];

  lines.push(
    `# QA report: ${run.ticketKey} — pull request #${run.pullRequest.number}`,
    "",
    `**${run.pullRequest.title}** · ${run.pullRequest.repo} @ \`${run.pullRequest.headSha.slice(0, 10)}\``,
    "",
    `## Release readiness: ${READINESS_LABEL[assessment.readiness]}`,
    "",
    headline(assessment),
    "",
    ...(assessment.reasons.length > 0 ? ["Why it is not \"ready\":", "", ...assessment.reasons.map((r) => `- ${r}`), ""] : []),
    "## Execution results",
    "",
    `- Scenarios executed: ${run.results.length} — ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked during execution, ${count("unverified")} unverified`,
    `- Scenarios planned but not run: ${blocked.length} (waiting on a decision or a missing capability)`,
    `- Documented requirements: ${assessment.counts.verified} verified, ${assessment.counts.failed} failed, ${assessment.counts.blocked} blocked, ${assessment.counts.unverified} unverified, ${assessment.counts["not planned"]} not planned (of ${documented.length})`,
    `- Clarification requests: ${run.analysis.ambiguities.length + run.plan.clarifications.length}`,
    `- Environment: ${run.environment.baseUrl}, commit \`${run.environment.deployedSha ?? "not reported"}\``,
    `- Execution mode: ${MODES[run.executionMode ?? "recorded"]}`,
    `- Model work done by: ${run.driver}`,
  );
  if (run.usage?.apiErrors?.length) {
    lines.push(`- Model API errors after retries: ${run.usage.apiErrors.map((e) => `${e.stage}: ${e.error}`).join("; ")}`);
  }
  if (run.usage) {
    const t = run.usage.total;
    lines.push(
      `- Model usage: ${t.calls} calls, ${t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens} input and ${t.outputTokens} output tokens, about $${run.usage.estimatedUsd.toFixed(2)} (limit $${run.usage.limits.maxUsd}); ${run.usage.minutes} of ${run.usage.limits.maxMinutes} minutes`,
    );
  }
  if (run.retestOf) {
    lines.push(`- This run re-ran the scenarios planned for commit \`${run.retestOf.headSha.slice(0, 10)}\`; it did not plan afresh`);
  }
  if (run.stopped) lines.push(`- **Ended early:** ${run.stopped}`);
  lines.push("");

  if (run.retestOf) {
    lines.push("## Change since the previous run", "", "| Scenario | Before | Now | Re-run by |", "|---|---|---|---|");
    for (const row of run.retestOf.rows) lines.push(`| ${row.scenarioId} | ${row.before} | ${row.after} | ${row.how} |`);
    lines.push("");
  }

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
    lines.push(`- Repeats when replayed without a model: ${run.confirmations[failure.scenarioId] ?? "not attempted"}`, "");
  }

  const inconclusive = run.results.filter((r) => r.verdict === "blocked" || r.verdict === "unverified");
  if (inconclusive.length > 0) {
    lines.push("## Not verified", "", "These scenarios ran or were due to run, and produced no pass or fail:", "");
    for (const r of inconclusive) lines.push(`- **${r.scenarioId}** (${r.verdict}) ${cell(r.title)}: ${cell(r.reason)}`);
    lines.push("");
  }

  lines.push(
    "## Requirement coverage",
    "",
    "| Id | Status | Requirement | Source quote | Source | Basis |",
    "|---|---|---|---|---|---|",
    ...assessment.requirements.map(
      (r) =>
        `| ${r.id} | ${r.status === "verified" ? "verified" : `**${r.status}**`} | ${cell(r.text)} | "${cell(r.quote)}" | ${cell(r.origin ?? "not recorded")} | ${cell(r.detail)} |`,
    ),
    "",
  );
  lines.push(
    ...authorityLines(
      { headSha: run.pullRequest.headSha, context: run.context, analysis: run.analysis },
      (text, max = 400) => cell(String(text ?? "")).slice(0, max),
      "###",
    ),
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
