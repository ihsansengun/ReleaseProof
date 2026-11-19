/**
 * A summary of every scenario that did not pass, made for reading in a place
 * that may be public: what was compared, what was seen, and the last steps
 * that led there.
 *
 * It is built from the run's records by code and passed through `redact`
 * before it leaves the process. Screenshots, full step records and the
 * application's log stay in the evidence artifact and are only named here.
 */
import path from "node:path";
import type { RunReport } from "../schema.ts";
import { failurePatterns } from "./patterns.ts";

const MAX_STEPS = 12;

/**
 * Removes what should not appear in a log, whatever produced it:
 * e-mail addresses, credentials in key=value or header form, signed tokens
 * and long opaque strings. Placeholders the engine itself writes for secret
 * test data ({{secret:name.field}}) are kept: they name a value without
 * containing it.
 */
export function redact(text: string): string {
  const kept: string[] = [];
  return text
    .replace(/\{\{secret:[^}]{1,80}\}\}/g, (placeholder) => {
      kept.push(placeholder);
      return `\u0000${kept.length - 1}\u0000`;
    })
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9+/._~=-]{8,}/gi, "$1 [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted token]")
    .replace(
      /\b((?:pass(?:word|phrase|wd)?|secret|token|api[-_]?key|session(?:[-_]?id)?|sid|cookie|set-cookie|authorization|auth|csrf[-_a-z]*|otp|pin)\b["']?\s*[:=]\s*["']?)([^\s"',;&}\]]+)/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[redacted e-mail]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted value]")
    .replace(/\u0000(\d+)\u0000/g, (_whole, index) => kept[Number(index)]!);
}

const brief = (value: unknown, max: number) => {
  const text = redact(typeof value === "string" ? value : (JSON.stringify(value) ?? "")).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export type Diagnostics = {
  commit: string;
  scenarios: {
    id: string;
    title: string;
    verdict: string;
    reason: string;
    /** What the repeat without a model found, for failures. */
    repeat?: string;
    comparisons: {
      assertionId: string;
      description: string;
      expected: string;
      observed: string;
      outcome: "mismatch" | "match" | "not compared";
      requirementId?: string;
      sourceId?: string;
      pattern?: string;
      /** How the executor located the value. */
      target?: string;
      /** File in the evidence artifact. */
      screenshot?: string;
    }[];
    stepsRecorded: number;
    /** The last steps before the scenario ended. */
    lastSteps: { n: number; tool: string; input: string; ok: boolean; result: string }[];
    evidence: string;
  }[];
};

export function buildDiagnostics(run: RunReport): Diagnostics {
  const patternOf = new Map<string, string>();
  for (const p of failurePatterns(run)) for (const c of p.comparisons) patternOf.set(`${c.scenarioId}/${c.assertionId}`, p.id);

  const scenarios: Diagnostics["scenarios"] = [];
  for (const result of run.results) {
    if (result.verdict === "passed") continue;
    const planned = run.plan.scenarios.find((s) => s.scenario.id === result.scenarioId)?.scenario;
    const comparisons: Diagnostics["scenarios"][number]["comparisons"] = (planned?.assertions ?? []).map((assertion) => {
      const outcome = result.assertionResults.find((a) => a.assertionId === assertion.id);
      return {
        assertionId: assertion.id,
        description: brief(assertion.description, 200),
        expected: outcome ? brief(outcome.expected, 80) : brief(assertion.expected ? ("literal" in assertion.expected ? assertion.expected.literal : assertion.expected.formula) : assertion.kind, 80),
        observed: outcome ? brief(outcome.actual, 80) : "",
        outcome: outcome ? (outcome.pass ? "match" : "mismatch") : "not compared",
        requirementId: assertion.requirementId,
        sourceId: assertion.provenance?.sourceId,
        pattern: patternOf.get(`${result.scenarioId}/${assertion.id}`),
        target: outcome?.target === undefined ? undefined : brief(outcome.target, 200),
        screenshot: outcome?.screenshot ? path.basename(outcome.screenshot) : undefined,
      };
    });
    const first = Math.max(0, result.steps.length - MAX_STEPS);
    scenarios.push({
      id: result.scenarioId,
      title: brief(result.title, 160),
      verdict: result.verdict,
      reason: brief(result.reason, 300),
      repeat: run.confirmations[result.scenarioId],
      comparisons,
      stepsRecorded: result.steps.length,
      lastSteps: result.steps.slice(first).map((step, index) => ({
        n: first + index + 1,
        tool: brief(step.tool, 30),
        input: brief(step.input, 180),
        ok: step.ok,
        result: brief(step.summary, 220),
      })),
      evidence: result.evidence.dir ? path.join("scenarios", result.scenarioId) : "",
    });
  }
  return { commit: run.pullRequest.headSha, scenarios };
}

export function renderDiagnostics(d: Diagnostics): string {
  const lines = [
    "# Diagnostics for scenarios that did not pass",
    "",
    "Built by code from the run's records and redacted: e-mail addresses, credentials, tokens and long opaque values are removed. Screenshots and complete step records are in the evidence artifact, in the directory named for each scenario.",
    "",
  ];
  if (d.scenarios.length === 0) lines.push("Every executed scenario passed.");
  for (const s of d.scenarios) {
    lines.push(`## ${s.id} — ${s.verdict}: ${s.title}`, "", `- Why: ${s.reason}`);
    if (s.repeat) lines.push(`- Repeated without a model on a fresh session: ${s.repeat}`);
    lines.push(`- Steps recorded: ${s.stepsRecorded}; evidence: \`${s.evidence || "none"}\``, "");
    if (s.comparisons.length > 0) {
      lines.push("| Assertion | Outcome | Expected | Observed | Rests on | Pattern | Located by | Screenshot |", "|---|---|---|---|---|---|---|---|");
      for (const c of s.comparisons) {
        const cell = (v: string | undefined) => (v ?? "").replace(/\|/g, "\\|") || "–";
        lines.push(`| ${c.assertionId} ${cell(c.description)} | ${c.outcome === "mismatch" ? "**mismatch**" : c.outcome} | \`${cell(c.expected)}\` | ${c.observed === "" ? "–" : `\`${cell(c.observed)}\``} | ${cell([c.requirementId, c.sourceId].filter(Boolean).join(" from "))} | ${cell(c.pattern)} | ${cell(c.target)} | ${cell(c.screenshot)} |`);
      }
      lines.push("");
    }
    if (s.lastSteps.length > 0) {
      lines.push(`Last ${s.lastSteps.length} steps:`, "");
      for (const step of s.lastSteps) lines.push(`${step.n}. \`${step.tool}\` ${step.input} → ${step.ok ? "ok" : "**failed**"}: ${step.result}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The same summary as lines that are safe to print in a job log: bounded,
 * without control characters, and prefixed so that no line can be read by
 * the runner as a workflow command.
 */
export function diagnosticLines(d: Diagnostics, maxLines = 400): string[] {
  const out: string[] = [];
  for (const s of d.scenarios) {
    out.push(`${s.id} ${s.verdict}: ${s.title}`, `  why: ${s.reason}${s.repeat ? ` | repeat without a model: ${s.repeat}` : ""}`);
    for (const c of s.comparisons) {
      out.push(`  ${c.assertionId} ${c.outcome}${c.pattern ? ` [${c.pattern}]` : ""}: expected ${c.expected}${c.observed === "" ? "" : `, observed ${c.observed}`} | ${c.description}${c.requirementId ? ` | rests on ${c.requirementId}` : ""}`);
      if (c.outcome === "mismatch" && c.target) out.push(`     located by ${c.target}${c.screenshot ? ` | screenshot ${c.screenshot}` : ""}`);
    }
    for (const step of s.lastSteps) out.push(`  step ${step.n} ${step.tool} ${step.input} -> ${step.ok ? "ok" : "FAILED"}: ${step.result}`);
  }
  return out.slice(0, maxLines).map((line) => `diag| ${line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 400)}`);
}
