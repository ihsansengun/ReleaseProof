import { z } from "zod";
import { authorityLines } from "../report/authority.ts";
import { failurePatterns } from "../report/patterns.ts";
import { redact } from "../report/diagnostics.ts";
import { assess, headline, READINESS_LABEL } from "../report/readiness.ts";
import { MODES } from "../report/run.ts";
import type { CiResult } from "./run.ts";

const MARKER = "<!-- releaseproof-report -->";
const COMMENT_LIMIT = 60_000;

/**
 * Makes a string that came from a ticket, a page or a model safe to put in a
 * comment: no markup, no mentions, no links, one line, bounded length.
 */
export function safe(value: unknown, max = 300): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[`|*_~#[\]()!\\]/g, (c) => `\\${c}`)
    .replace(/@/g, "@​")
    .replace(/:\/\//g, ":​//")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const Verdict = z.enum(["passed", "failed", "blocked", "unverified"]);
const Scalar = z.union([z.string(), z.number()]);

const Stage = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  toolCalls: z.number(),
  usd: z.number().optional(),
});

/** The parts of a result this stage reads. Anything else in the file is ignored. */
export const ReportInput = z.object({
  status: z.enum(["completed", "skipped", "error"]),
  reason: z.string().optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive().optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  isolation: z
    .object({
      environment: z.array(z.string()),
      outboundNetwork: z.string(),
      rootFilesystem: z.string(),
      user: z.string(),
      ok: z.boolean(),
    })
    .optional(),
  run: z
    .object({
      ticketKey: z.string(),
      driver: z.string(),
      // Absent in runs made before modes were recorded; those are treated as recorded.
      executionMode: z.enum(["autonomous", "replay", "recorded"]).default("recorded"),
      stopped: z.string().optional(),
      environment: z.object({ deployedSha: z.string().optional(), commitEstablished: z.string().optional(), instances: z.string().optional() }),
      context: z
        .object({
          sources: z.array(z.object({ id: z.string(), kind: z.string(), trust: z.string(), origin: z.string(), basis: z.string() })).optional(),
          docChanges: z
            .array(
              z.object({
                path: z.string(),
                kind: z.enum(["modified", "added-to-list", "removed"]),
                hash: z.string().regex(/^[0-9a-f]{64}$/),
                removedLines: z.array(z.string()),
                addedLines: z.array(z.string()),
                approval: z
                  .object({ approver: z.string(), approverId: z.number(), commentId: z.number(), commit: z.string().regex(/^[0-9a-f]{40}$/) })
                  .optional(),
              }),
            )
            .optional(),
          approvals: z
            .array(z.object({ commentId: z.number(), author: z.string(), accepted: z.boolean(), reason: z.string(), changeHash: z.string().optional() }))
            .optional(),
          authorityNotices: z.array(z.string()).optional(),
          protectedRevision: z.string().optional(),
        })
        .optional(),
      pullRequest: z.object({ headSha: z.string() }),
      analysis: z.object({
        requirements: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            kind: z.string(),
            quote: z.string(),
            sourceId: z.string().optional(),
            trust: z.string().optional(),
            origin: z.string().optional(),
            relation: z.string().optional(),
          }),
        ),
        conflicts: z.array(z.object({ id: z.string(), kind: z.string(), description: z.string() })).optional(),
        supersessions: z.array(z.object({ retiredText: z.string(), retiredSourceId: z.string(), bySourceId: z.string(), how: z.string() })).optional(),
        ambiguities: z.array(z.object({ id: z.string(), question: z.string() })),
      }),
      plan: z.object({
        trimmedRunnable: z.number().int().nonnegative().optional(),
        scenarios: z.array(
          z.object({
            status: z.string(),
            blockedReason: z.string(),
            scenario: z.object({
              id: z.string(),
              title: z.string(),
              requirementIds: z.array(z.string()).optional(),
              assertions: z.array(z.object({ id: z.string(), description: z.string(), requirementId: z.string().optional(), alsoVerifies: z.array(z.string()).optional() })),
            }),
          }),
        ),
        clarifications: z.array(z.object({ question: z.string() })),
      }),
      results: z.array(
        z.object({
          scenarioId: z.string(),
          title: z.string(),
          verdict: Verdict,
          reason: z.string(),
          assertionResults: z.array(
            z.object({ assertionId: z.string(), expected: Scalar, actual: Scalar, pass: z.boolean() }),
          ),
        }),
      ),
      confirmations: z.record(z.string(), z.string()).optional(),
      escalations: z.array(z.object({ scenarioId: z.string(), why: z.string(), before: z.string(), after: z.string(), kept: z.string() })).optional(),
      usage: z
        .object({
          byStage: z.record(z.string(), Stage).optional(),
          apiErrors: z.array(z.object({ stage: z.string(), error: z.string() })).default([]),
          estimatedUsd: z.number(),
          minutes: z.number(),
          total: Stage,
          limits: z.object({ maxUsd: z.number(), maxMinutes: z.number() }),
        })
        .optional(),
      retestOf: z
        .object({
          headSha: z.string(),
          rows: z.array(z.object({ scenarioId: z.string(), before: z.string(), after: z.string(), how: z.string() })),
        })
        .optional(),
    })
    .optional(),
});
type ReportInput = z.infer<typeof ReportInput>;

// Values that identify commits and changes. They are long and opaque by
// nature, are not secret, and the report needs them exact.
const EXACT = new Set(["headSha", "hash", "commit", "protectedRevision", "repo", "deployedSha"]);

function redactDeep(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key !== undefined && EXACT.has(key) ? value : redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, k)]));
  return value;
}

/**
 * The part of a result that may be handed on as an artifact: only the fields
 * the report renders (so no step records, screenshots, page content or
 * application log), with every text redacted.
 */
export function publicResult(raw: unknown): ReportInput {
  return redactDeep(ReportInput.parse(raw)) as ReportInput;
}

export type Rendered = { conclusion: "success" | "failure" | "neutral"; title: string; body: string };

/** Turns a validated result into the text GitHub will show. Pure: no network, no files. */
export function render(input: ReportInput, runUrl: string): Rendered {
  const lines: string[] = [MARKER];
  const evidence = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl)
    ? `[workflow run and evidence artifact](${runUrl})`
    : "the workflow run";

  if (input.status !== "completed" || !input.run) {
    const title = input.status === "skipped" ? "Not run" : "Could not complete";
    lines.push(`## ReleaseProof QA: ${title.toLowerCase()}`, "", safe(input.reason ?? "No reason was recorded.", 600), "", `Details: ${evidence}.`);
    return { conclusion: "neutral", title, body: lines.join("\n") };
  }

  const run = input.run;
  const a = assess(run);
  const failed = a.execution.failed;
  const inconclusive = a.execution.blocked + a.execution.unverified;
  const commitVerified = run.environment.deployedSha === run.pullRequest.headSha;
  const recorded = run.executionMode === "recorded";
  const title = recorded ? `Recorded replay, not an autonomous run. ${headline(a)}` : `${headline(a)} (${run.executionMode})`;
  // The Check is green only when the feature is verified, not merely when
  // nothing that ran failed. A run in which no live model took part is never
  // a pass or a fail of the pull request.
  const conclusion = recorded ? "neutral" : a.readiness === "not ready" ? "failure" : a.readiness === "ready" ? "success" : "neutral";

  lines.push(
    `## ReleaseProof QA: ${safe(run.ticketKey, 40)}`,
    "",
    ...(recorded
      ? [
          "> **Recorded replay, not an autonomous run.** No live model was used. The analysis, plan and browser steps come from an earlier run; only the comparisons against this commit are new. This result is informational and never passes or fails the pull request.",
          "",
        ]
      : []),
    `### Release readiness: ${READINESS_LABEL[a.readiness]}`,
    "",
    ...(a.readiness === "ready"
      ? ["Every documented requirement was compared against the application and matched; nothing was left blocked or unverified."]
      : a.reasons.map((r) => `- ${r}`)),
    "",
    ...(a.readiness === "incomplete"
      ? ["Nothing that ran failed, but that is not the same as verified: the items below were not tested.", ""]
      : []),
    "### Execution results",
    "",
    `On \`${run.pullRequest.headSha.slice(0, 10)}\` (${
      commitVerified
        ? "the application under test reported this commit"
        : !run.environment.deployedSha && run.environment.commitEstablished
          ? `the application has no way to report its commit; ${safe(run.environment.commitEstablished, 240)}`
          : "**commit not confirmed by the application**"
    })`,
    "",
    "| | Passed / verified | Failed | Blocked | Unverified | Exercised only | Not planned |",
    "|---|---|---|---|---|---|---|",
    `| Scenarios (${run.plan.scenarios.length} planned, ${run.results.length} executed) | ${a.execution.passed} | ${a.execution.failed} | ${a.notRun + a.execution.blocked} | ${a.execution.unverified} | – | ${run.plan.trimmedRunnable ? `${run.plan.trimmedRunnable} dropped by the limit` : "–"} |`,
    `| Documented requirements (${a.requirements.length}) | ${a.counts.verified} | ${a.counts.failed} | ${a.counts.blocked} | ${a.counts.unverified} | ${a.counts.exercised} | ${a.counts["not planned"]} |`,
    "",
    `- Questions for the ticket owner: ${run.analysis.ambiguities.length + run.plan.clarifications.length}`,
    `- Execution mode: ${MODES[run.executionMode]}`,
    `- Model: ${safe(run.driver, 120)}`,
  );
  if (run.usage?.apiErrors.length) {
    lines.push(`- Model API errors after retries: ${run.usage.apiErrors.map((e) => safe(`${e.stage}: ${e.error}`, 200)).join("; ")}`);
  }
  if (run.usage) {
    const t = run.usage.total;
    const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    lines.push(
      `- Cost and time: about $${run.usage.estimatedUsd.toFixed(2)} of $${run.usage.limits.maxUsd}, ${tokens.toLocaleString("en-US")} tokens, ${t.calls} model calls, ${t.toolCalls} tool calls, ${run.usage.minutes} of ${run.usage.limits.maxMinutes} minutes`,
    );
  }
  if (run.usage?.byStage) {
    const stages = Object.entries(run.usage.byStage).slice(0, 12);
    lines.push(
      `- By stage: ${stages
        .map(([name, u]) => {
          const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
          return `${safe(name, 20)} ${tokens.toLocaleString("en-US")} tokens${u.usd === undefined ? "" : ` ($${u.usd.toFixed(2)})`}`;
        })
        .join(", ")}`,
    );
  }
  if (run.escalations?.length) {
    lines.push(
      `- Re-run on the escalation model: ${run.escalations
        .map((e) => `${safe(e.scenarioId, 20)} (${safe(e.why, 120)}; ${safe(e.before, 12)} → ${safe(e.after, 12)}, ${e.kept === "escalated run" ? "result replaced" : "first result kept"})`)
        .join("; ")}`,
    );
  }
  if (run.retestOf) lines.push(`- Re-ran the scenarios planned for \`${safe(run.retestOf.headSha.slice(0, 10), 12)}\`; no new plan was made`);
  if (run.stopped) lines.push(`- **Ended early:** ${safe(run.stopped, 400)}`);
  lines.push("");

  if (failed > 0) {
    // One defect often shows up in several comparisons. Counting comparisons
    // or requirements would overstate it, so they are grouped by what the
    // observed values have in common.
    const patterns = failurePatterns(run);
    const comparisons = patterns.reduce((n, p) => n + p.comparisons.length, 0);
    lines.push(
      "### Failures",
      "",
      `${comparisons} failed comparison${comparisons === 1 ? "" : "s"} in ${failed} scenario${failed === 1 ? "" : "s"}, falling into **${patterns.length} distinct pattern${patterns.length === 1 ? "" : "s"}**. A pattern groups comparisons that are off in the same way; it is a guide to how many separate causes there may be, not a count of defects.`,
      "",
      "| Pattern | What the comparisons share | Comparisons | Requirements they rest on |",
      "|---|---|---|---|",
    );
    for (const p of patterns.slice(0, 20)) {
      lines.push(`| ${p.id} | ${safe(p.description, 120)} | ${p.comparisons.map((c) => `${safe(c.scenarioId, 20)}/${safe(c.assertionId, 12)}`).join(", ")} | ${p.requirementIds.map((id) => safe(id, 10)).join(", ") || "–"} |`);
    }
    lines.push("");
    for (const result of run.results.filter((r) => r.verdict === "failed")) {
      const planned = run.plan.scenarios.find((s) => s.scenario.id === result.scenarioId);
      lines.push(`**${safe(result.scenarioId, 20)} ${safe(result.title, 160)}**`);
      const confirmation = run.confirmations?.[result.scenarioId];
      if (confirmation) lines.push(`- Repeated without a model on a fresh session: ${safe(confirmation, 40)}`);
      for (const outcome of result.assertionResults.filter((a) => !a.pass)) {
        const assertion = planned?.scenario.assertions.find((a) => a.id === outcome.assertionId);
        const requirement = run.analysis.requirements.find((r) => r.id === assertion?.requirementId);
        lines.push(
          `- ${safe(assertion?.description ?? outcome.assertionId, 240)}: expected \`${safe(outcome.expected, 80)}\`, actual \`${safe(outcome.actual, 80)}\``,
        );
        if (requirement) {
          lines.push(`  - Requirement ${safe(requirement.id, 10)}: "${safe(requirement.quote, 240)}"${requirement.origin ? ` (source: ${safe(requirement.origin, 200)})` : ""}`);
        }
      }
      lines.push("");
    }
  }

  if (inconclusive > 0) {
    lines.push("### Not verified", "", "These produced no pass or fail and are not counted as either.", "");
    for (const r of run.results.filter((x) => x.verdict === "blocked" || x.verdict === "unverified")) {
      lines.push(`- **${safe(r.scenarioId, 20)}** (${r.verdict}) ${safe(r.title, 140)}: ${safe(r.reason, 260)}`);
    }
    lines.push("");
  }

  lines.push(
    ...authorityLines({ headSha: run.pullRequest.headSha, context: run.context, analysis: run.analysis }, (text, max = 300) => safe(text, max)),
  );

  const open = a.requirements.filter((r) => r.status !== "verified" && r.status !== "failed");
  if (open.length > 0) {
    lines.push("### Requirements not verified", "", "| Id | Status | Requirement | Why |", "|---|---|---|---|");
    for (const r of open.slice(0, 40)) {
      lines.push(`| ${safe(r.id, 10)} | ${r.status} | ${safe(r.text, 200)} | ${safe(r.detail, 260)} |`);
    }
    if (open.length > 40) lines.push(`| … | | ${open.length - 40} more in the full report | |`);
    lines.push("");
  }

  if (run.retestOf) {
    lines.push("### Change since the previous run", "", "| Scenario | Before | Now | Re-run by |", "|---|---|---|---|");
    for (const row of run.retestOf.rows) {
      lines.push(`| ${safe(row.scenarioId, 20)} | ${safe(row.before, 12)} | ${safe(row.after, 12)} | ${safe(row.how, 8)} |`);
    }
    lines.push("");
  }

  lines.push("<details><summary>All scenarios</summary>", "", "| Id | Scenario | Result |", "|---|---|---|");
  for (const planned of run.plan.scenarios) {
    const result = run.results.find((r) => r.scenarioId === planned.scenario.id);
    lines.push(
      `| ${safe(planned.scenario.id, 20)} | ${safe(planned.scenario.title, 160)} | ${result ? result.verdict : `not run: ${safe(planned.blockedReason, 200)}`} |`,
    );
  }
  lines.push("", "</details>", "");

  const questions = [...run.analysis.ambiguities.map((a) => a.question), ...run.plan.clarifications.map((c) => c.question)];
  if (questions.length > 0) {
    lines.push("<details><summary>Questions for the ticket owner</summary>", "");
    for (const q of questions.slice(0, 20)) lines.push(`- ${safe(q, 400)}`);
    if (questions.length > 20) lines.push(`- …and ${questions.length - 20} more in the report`);
    lines.push("", "</details>", "");
  }

  if (input.isolation) {
    lines.push(
      `Application ran isolated: outbound network ${safe(input.isolation.outboundNetwork, 12)}, filesystem ${safe(input.isolation.rootFilesystem, 12)}, user id ${safe(input.isolation.user, 8)}, ${input.isolation.environment.length} environment variables, none of them credentials.`,
      "",
    );
  }
  lines.push(`Full report, steps and screenshots: ${evidence} (kept 14 days).`);

  let body = lines.join("\n");
  if (body.length > COMMENT_LIMIT) body = `${body.slice(0, COMMENT_LIMIT)}\n\n…shortened; see the full report in the artifact.`;
  return { conclusion, title, body };
}

async function github(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "releaseproof",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${method} ${path}`);
  return response.json();
}

/**
 * Stage 3. Validates the result file, then publishes a Check run on the
 * tested commit and keeps one comment on the pull request up to date.
 * Nothing from the result is executed or followed; it is only displayed.
 */
export async function publish(raw: unknown, runUrl: string, token: string, options: { post?: boolean } = {}): Promise<Rendered & { posted: string[] }> {
  const input = ReportInput.parse(raw satisfies unknown as CiResult);
  const rendered = render(input, runUrl);
  const posted: string[] = [];
  // For an application in a repository this workflow cannot write to, the
  // result is rendered for the run's own summary and nothing is posted.
  if (options.post === false) return { ...rendered, posted };
  if (!input.headSha || !input.pr) return { ...rendered, posted };

  await github("POST", `/repos/${input.repo}/check-runs`, token, {
    name: "ReleaseProof QA",
    head_sha: input.headSha,
    status: "completed",
    conclusion: rendered.conclusion,
    details_url: runUrl,
    output: { title: rendered.title, summary: rendered.body },
  });
  posted.push("check run");

  // A run that was skipped has nothing for a reader to act on: the Check run
  // records it, and the pull request is left without a comment.
  if (input.status === "skipped") return { ...rendered, posted };

  // Only comment while the tested commit is still the head; an older result
  // must not overwrite a newer one.
  const pull = (await github("GET", `/repos/${input.repo}/pulls/${input.pr}`, token)) as { head: { sha: string } };
  if (pull.head.sha !== input.headSha) return { ...rendered, posted };
  const comments = (await github("GET", `/repos/${input.repo}/issues/${input.pr}/comments?per_page=100`, token)) as {
    id: number;
    body?: string;
    user?: { type?: string };
  }[];
  const existing = comments.find((c) => c.user?.type === "Bot" && c.body?.startsWith(MARKER));
  if (existing) {
    await github("PATCH", `/repos/${input.repo}/issues/comments/${existing.id}`, token, { body: rendered.body });
    posted.push("comment updated");
  } else {
    await github("POST", `/repos/${input.repo}/issues/${input.pr}/comments`, token, { body: rendered.body });
    posted.push("comment created");
  }
  return { ...rendered, posted };
}
