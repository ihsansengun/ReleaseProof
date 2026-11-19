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
import type { AssertionResult, RunReport } from "../schema.ts";
import { failurePatterns } from "./patterns.ts";

const MAX_STEPS = 12;
/** Steps kept per scenario in the JSON record. */
const MAX_RECORDED_STEPS = 150;
/** The steps that carry evidence: what was read, what was compared, what the application answered. */
const EVIDENCE_TOOLS = new Set(["observe", "check", "api_request"]);

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

/** The seven things a reader needs to judge one comparison. */
export const EVIDENCE_PARTS = ["requirement", "actor", "resource", "action", "target", "comparison", "final state"] as const;

export type Provenance = {
  step: number;
  requirement?: string;
  expected: string;
  /** Fixture alias whose credentials were last entered, and since which step. */
  actor?: string;
  /** The page, or the request and what the application answered. */
  resource?: string;
  /** Values read earlier that the expected value was computed from: the state before. */
  before: string[];
  /** The last step before the comparison that could change state. */
  action?: string;
  /** How the thing compared was identified, and what it is. */
  target: string;
  /** What was read, before a pattern or a conversion. */
  raw?: string;
  /** Comparisons made later in the scenario: the state after, as far as it was asserted. */
  after: string[];
  present: string[];
  missing: string[];
};

/** Turns the stored record into redacted, bounded text, and says which parts are there. */
function provenanceOf(outcome: AssertionResult, later: AssertionResult[]): Provenance | undefined {
  const e = outcome.evidence;
  if (!e) return undefined;
  const request = e.resource.request;
  const resource = request
    ? `${request.method} ${brief(request.path, 120)} -> ${request.status} at step ${request.step}${request.body ? `, body ${brief(request.body, 160)}` : ""}`
    : e.resource.page
      ? `page ${brief(e.resource.page, 120)}`
      : undefined;
  const element = e.target.element ? `; element <${brief(e.target.element.tag, 20)}>${e.target.element.role ? ` role ${brief(e.target.element.role, 20)}` : ""}${e.target.element.context ? ` in "${brief(e.target.element.context, 100)}"` : ""}` : "";
  const target = `${brief(e.target.locatedBy, 160)}${e.target.within ? ` within ${brief(e.target.within, 100)}` : ""}${e.target.matched === undefined ? "" : `; matched ${e.target.matched}`}${e.target.visible === undefined ? "" : e.target.visible ? ", visible" : ", not visible"}${element}`;
  const provenance: Omit<Provenance, "present" | "missing"> = {
    step: e.step,
    ...(e.requirement ? { requirement: `${e.requirement.id}${e.requirement.sourceId ? ` from ${e.requirement.sourceId}` : ""}${e.requirement.quote ? `: "${brief(e.requirement.quote, 200)}"` : ""}` } : {}),
    expected: `${e.expected.kind} ${e.expected.formula ? `formula ${brief(e.expected.formula, 120)} = ${brief(outcome.expected, 40)}` : e.expected.literal === undefined ? "" : brief(e.expected.literal, 80)}${e.expected.unit ? ` (${e.expected.unit})` : ""}`.trim(),
    ...(e.actor ? { actor: `${brief(e.actor.alias, 40)} (credentials entered at step ${e.actor.step})` } : {}),
    ...(resource ? { resource } : {}),
    before: e.before.map((b) => `${brief(b.name, 40)} = ${b.value}${b.step ? ` (step ${b.step}${b.when ? `, ${brief(b.when, 100)}` : ""})` : ""}`),
    ...(e.action ? { action: `step ${e.action.step} ${brief(e.action.tool, 20)} ${brief(e.action.what, 140)}` } : {}),
    target,
    ...(e.raw === undefined ? {} : { raw: brief(e.raw, 160) }),
    after: later.map((l) => `${l.assertionId}: expected ${brief(l.expected, 40)}, observed ${brief(l.actual, 40)}`),
  };
  const has: Record<(typeof EVIDENCE_PARTS)[number], boolean> = {
    requirement: !!e.requirement,
    actor: !!e.actor,
    resource: !!resource,
    action: !!e.action || !!request,
    target: e.target.locatedBy !== "",
    comparison: true,
    // A reading taken after the last step that could change state is the state that step left behind.
    "final state": (!!e.action && e.action.step < e.step) || later.length > 0,
  };
  return { ...provenance, present: EVIDENCE_PARTS.filter((p) => has[p]), missing: EVIDENCE_PARTS.filter((p) => !has[p]) };
}

export type Diagnostics = {
  commit: string;
  /** How many comparisons carry all seven parts of their evidence, of those that were made. */
  completeness?: { complete: number; compared: number };
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
      standing?: string;
      /** How the executor located the value. */
      target?: string;
      /**
       * What stands behind the comparison, from the record made when it was
       * compared. It does not depend on the step listing.
       */
      provenance?: Provenance;
      /** File in the evidence artifact. */
      screenshot?: string;
    }[];
    stepsRecorded: number;
    /**
     * For a scenario that did not pass: the last steps before it ended. For one
     * that passed: the steps that carry its evidence (readings, comparisons and
     * the application's answers), so that a pass can be questioned too.
     */
    lastSteps: { n: number; tool: string; input: string; ok: boolean; result: string }[];
    /** Every step, redacted. Written to the JSON record only. */
    allSteps?: { n: number; tool: string; input: string; ok: boolean; result: string }[];
    /** Set for a run that was re-run on the escalation model and whose result was not the one kept. */
    attempt?: string;
    evidence: string;
  }[];
};

export function buildDiagnostics(run: RunReport): Diagnostics {
  const patternOf = new Map<string, string>();
  for (const p of failurePatterns(run)) for (const c of p.comparisons) patternOf.set(`${c.scenarioId}/${c.assertionId}`, p.id);

  const scenarios: Diagnostics["scenarios"] = [];
  const kept = run.results.map((result) => ({ result, attempt: undefined as string | undefined }));
  const others = (run.escalations ?? [])
    .filter((e) => e.other)
    .map((e) => ({
      result: e.other!,
      attempt: e.kept === "escalated run" ? `first run, replaced by the escalated run (${e.why})` : `escalated run, not kept (${e.why})`,
    }));
  for (const { result, attempt } of [...kept, ...others]) {
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
        ...(outcome?.standing ? { standing: outcome.standing } : {}),
        target: outcome?.target === undefined ? undefined : brief(outcome.target, 200),
        ...(outcome && provenanceOf(outcome, result.assertionResults.slice(result.assertionResults.indexOf(outcome) + 1))
          ? { provenance: provenanceOf(outcome, result.assertionResults.slice(result.assertionResults.indexOf(outcome) + 1)) }
          : {}),
        screenshot: outcome?.screenshot ? path.basename(outcome.screenshot) : undefined,
      };
    });
    const passed = result.verdict === "passed";
    const describe = (step: (typeof result.steps)[number], index: number) => ({
      n: index + 1,
      tool: brief(step.tool, 30),
      input: brief(step.input, 180),
      ok: step.ok,
      result: brief(step.summary, 220),
    });
    const all = result.steps.map(describe);
    scenarios.push({
      id: result.scenarioId,
      title: brief(result.title, 160),
      verdict: result.verdict,
      reason: brief(result.reason, 300),
      repeat: attempt ? undefined : run.confirmations[result.scenarioId],
      comparisons,
      stepsRecorded: result.steps.length,
      lastSteps: passed ? all.filter((s) => EVIDENCE_TOOLS.has(s.tool)).slice(-2 * MAX_STEPS) : all.slice(-MAX_STEPS),
      allSteps: all.slice(0, MAX_RECORDED_STEPS),
      ...(attempt ? { attempt } : {}),
      evidence: result.evidence.dir ? path.join("scenarios", result.scenarioId) : "",
    });
  }
  const withEvidence = scenarios.filter((s) => !s.attempt).flatMap((s) => s.comparisons).filter((c) => c.provenance);
  return {
    commit: run.pullRequest.headSha,
    ...(withEvidence.length > 0 ? { completeness: { complete: withEvidence.filter((c) => c.provenance!.missing.length === 0).length, compared: withEvidence.length } } : {}),
    scenarios,
  };
}

/** One comparison's evidence as lines of text. */
function provenanceLines(p: Provenance): string[] {
  return [
    `evidence ${p.present.length}/${EVIDENCE_PARTS.length}${p.missing.length ? ` (not recorded: ${p.missing.join(", ")})` : ""} at step ${p.step}`,
    ...(p.requirement ? [`requirement ${p.requirement}`] : []),
    `expected ${p.expected}`,
    ...(p.actor ? [`actor ${p.actor}`] : []),
    ...(p.resource ? [`resource ${p.resource}`] : []),
    ...(p.before.length ? [`before: ${p.before.join("; ")}`] : []),
    ...(p.action ? [`last action: ${p.action}`] : []),
    `target ${p.target}${p.raw === undefined ? "" : `; read "${p.raw}"`}`,
    ...(p.after.length ? [`after: ${p.after.join("; ")}`] : []),
  ];
}

export function renderDiagnostics(d: Diagnostics): string {
  const lines = [
    "# Diagnostics for every executed scenario",
    "",
    ...(d.completeness ? [`Evidence: ${d.completeness.complete} of ${d.completeness.compared} comparisons carry all seven parts of their record (requirement, actor, resource, action, target, comparison, final state). "Initial" and "final" state are what the scenario read and compared, not a snapshot of the application; the actor is the test account whose credentials were last entered.`, ""] : []),
    "Built by code from the run's records and redacted: e-mail addresses, credentials, tokens and long opaque values are removed. Scenarios that passed are included, with the readings and comparisons their pass rests on, so that a pass can be examined as closely as a failure. Screenshots are not part of this record.",
    "",
  ];
  if (d.scenarios.length === 0) lines.push("No scenario was executed.");
  for (const s of d.scenarios) {
    lines.push(`## ${s.id} — ${s.verdict}: ${s.title}`, "", ...(s.attempt ? [`- This is the ${s.attempt}.`] : []), `- Why: ${s.reason}`);
    if (s.repeat) lines.push(`- Repeatability (same steps and locators, no model; not a confirmation of a defect): ${s.repeat}`);
    lines.push(`- Steps recorded: ${s.stepsRecorded}; evidence: \`${s.evidence || "none"}\``, "");
    if (s.comparisons.length > 0) {
      lines.push("| Assertion | Outcome | Expected | Observed | Rests on | Pattern | Located by | Screenshot |", "|---|---|---|---|---|---|---|---|");
      for (const c of s.comparisons) {
        const cell = (v: string | undefined) => (v ?? "").replace(/\|/g, "\\|") || "–";
        lines.push(`| ${c.assertionId} ${cell(c.description)} | ${c.outcome === "mismatch" ? "**mismatch**" : c.outcome} | \`${cell(c.expected)}\` | ${c.observed === "" ? "–" : `\`${cell(c.observed)}\``} | ${cell([c.requirementId, c.sourceId].filter(Boolean).join(" from "))} | ${cell(c.pattern)} | ${cell(c.target)} | ${cell(c.screenshot)} |`);
      }
      lines.push("");
      for (const c of s.comparisons.filter((x) => x.provenance)) {
        lines.push(`**${c.assertionId}** ${c.outcome}`, "", ...provenanceLines(c.provenance!).map((l) => `- ${l}`), "");
      }
    }
    if (s.lastSteps.length > 0) {
      lines.push(s.verdict === "passed" ? `Readings, comparisons and responses (${s.lastSteps.length}):` : `Last ${s.lastSteps.length} steps:`, "");
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
export function diagnosticLines(d: Diagnostics, maxLines = 700): string[] {
  const out: string[] = [];
  // What did not pass comes first, so that a cut-off loses passes, not failures.
  const ordered = [...d.scenarios.filter((s) => s.verdict !== "passed"), ...d.scenarios.filter((s) => s.verdict === "passed")];
  for (const s of ordered) {
    out.push(`${s.id} ${s.verdict}${s.attempt ? ` [${s.attempt}]` : ""}: ${s.title}`, `  why: ${s.reason}${s.repeat ? ` | repeatability (same locators, no model): ${s.repeat}` : ""}`);
    for (const c of s.comparisons) {
      out.push(`  ${c.assertionId} ${c.outcome}${c.pattern ? ` [${c.pattern}]` : ""}: expected ${c.expected}${c.observed === "" ? "" : `, observed ${c.observed}`} | ${c.description}${c.requirementId ? ` | rests on ${c.requirementId}` : ""}${c.standing ? ` | standing: ${c.standing}` : ""}`);
      if (c.outcome !== "not compared" && c.target) out.push(`     located by ${c.target}${c.screenshot ? ` | screenshot ${c.screenshot}` : ""}`);
      if (c.provenance) for (const l of provenanceLines(c.provenance)) out.push(`     ${l}`);
    }
    for (const step of s.lastSteps) out.push(`  step ${step.n} ${step.tool} ${step.input} -> ${step.ok ? "ok" : "FAILED"}: ${step.result}`);
  }
  if (d.completeness) out.unshift(`evidence: ${d.completeness.complete} of ${d.completeness.compared} comparisons carry all seven parts of their record`);
  return out.slice(0, maxLines).map((line) => `diag| ${line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 400)}`);
}
