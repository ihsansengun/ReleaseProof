/**
 * The requirements audit trail of a run: for every expected value that was
 * compared, where its authority came from, what was expected, and what was
 * observed. Built by code from what the run recorded; no model writes it.
 *
 *   source  ->  requirement (verified quote)  ->  assertion (expected)  ->  evidence (observed)
 */
import type { RunReport } from "../schema.ts";

export type AuditTrail = {
  run: { ticket: string; pullRequest: string; commit: string; deployedCommit?: string; commitEstablished?: string; startedAt: string; executionMode: string; model: string };
  authority: {
    protectedRevision?: string;
    owners?: { github: { id: number; login?: string }[]; jira: { accountId: string; name?: string }[]; fixtureAuthors: string[] };
    notices: string[];
    /** Fingerprint of every authoritative source. A different value means the requirements changed. */
    fingerprint?: string;
  };
  sources: { id: string; kind: string; trust: string; origin: string; basis: string; sha256?: string }[];
  amendments: {
    approved: { path: string; changeHash: string; approver: string; approverId: number; commentId: number; commit: string; linesAdded: number; linesRemoved: number }[];
    notApproved: { path: string; kind: string; changeHash: string; linesAdded: number; linesRemoved: number }[];
    commands: { commentId: number; author: string; accepted: boolean; reason: string; changeHash?: string }[];
  };
  requirements: {
    id: string;
    text: string;
    standing: "approved" | "claimed, never used as an expected value" | "inferred, never used as an expected value";
    quote: string;
    sourceId?: string;
    sourceOrigin?: string;
    relation?: string;
  }[];
  assertions: {
    scenarioId: string;
    scenarioTitle: string;
    assertionId: string;
    description: string;
    comparison: string;
    expectedAsPlanned: string;
    requirementId?: string;
    sourceId?: string;
    sourceOrigin?: string;
    quote?: string;
    evidence:
      | {
          compared: true;
          expected: string | number;
          observed: string | number;
          outcome: "match" | "mismatch";
          scenarioVerdict: string;
          modelFreeRepeat?: string;
          stepsRecorded: number;
          evidenceDirectory: string;
          screenshot?: string;
        }
      | { compared: false; why: string };
  }[];
  conflicts: { id: string; kind: string; description: string }[];
  /** Rules replaced by a later approved source, and how that was established. */
  supersessions: { retiredText: string; retiredSourceId: string; bySourceId: string; how: string }[];
  questions: string[];
};

export function buildAuditTrail(run: RunReport): AuditTrail {
  const requirement = new Map(run.analysis.requirements.map((r) => [r.id, r]));
  const result = new Map(run.results.map((r) => [r.scenarioId, r]));
  const changes = run.context.docChanges ?? [];

  const assertions: AuditTrail["assertions"] = [];
  for (const planned of run.plan.scenarios) {
    const executed = result.get(planned.scenario.id);
    for (const a of planned.scenario.assertions) {
      const outcome = executed?.assertionResults.find((x) => x.assertionId === a.id);
      const expectedAsPlanned =
        a.expected === undefined ? "(none: presence or absence)" : "formula" in a.expected ? `formula: ${a.expected.formula}` : String(a.expected.literal);
      assertions.push({
        scenarioId: planned.scenario.id,
        scenarioTitle: planned.scenario.title,
        assertionId: a.id,
        description: a.description,
        comparison: a.kind,
        expectedAsPlanned,
        requirementId: a.requirementId,
        // Provenance was copied onto the assertion by the plan validator from the source record.
        sourceId: a.provenance?.sourceId,
        sourceOrigin: a.provenance?.origin ?? (a.requirementId ? requirement.get(a.requirementId)?.origin : undefined),
        quote: a.provenance?.quote ?? (a.requirementId ? requirement.get(a.requirementId)?.quote : undefined),
        evidence: outcome
          ? {
              compared: true,
              expected: outcome.expected,
              observed: outcome.actual,
              outcome: outcome.pass ? "match" : "mismatch",
              scenarioVerdict: executed!.verdict,
              modelFreeRepeat: run.confirmations[planned.scenario.id],
              stepsRecorded: executed!.steps.length,
              evidenceDirectory: executed!.evidence.dir,
              screenshot: outcome.screenshot,
            }
          : { compared: false, why: executed ? `${executed.verdict}: ${executed.reason}` : planned.blockedReason || "the scenario was not run" },
      });
    }
  }

  return {
    run: {
      ticket: run.ticketKey,
      pullRequest: `${run.pullRequest.repo}#${run.pullRequest.number}`,
      commit: run.pullRequest.headSha,
      deployedCommit: run.environment.deployedSha,
      commitEstablished: run.environment.deployedSha ? undefined : run.environment.commitEstablished,
      startedAt: run.startedAt,
      executionMode: run.executionMode ?? "recorded",
      model: run.driver,
    },
    authority: {
      protectedRevision: run.context.protectedRevision,
      owners: run.context.owners,
      notices: run.context.authorityNotices ?? [],
      fingerprint: run.ticketHash,
    },
    sources: run.context.sources ?? [],
    amendments: {
      approved: changes
        .filter((c) => c.approval)
        .map((c) => ({ path: c.path, changeHash: c.hash, ...c.approval!, linesAdded: c.addedLines.length, linesRemoved: c.removedLines.length })),
      notApproved: changes
        .filter((c) => !c.approval)
        .map((c) => ({ path: c.path, kind: c.kind, changeHash: c.hash, linesAdded: c.addedLines.length, linesRemoved: c.removedLines.length })),
      commands: run.context.approvals ?? [],
    },
    requirements: run.analysis.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      standing: r.kind === "documented" ? "approved" : r.kind === "claimed" ? "claimed, never used as an expected value" : "inferred, never used as an expected value",
      quote: r.quote,
      sourceId: r.sourceId,
      sourceOrigin: r.origin,
      relation: r.kind === "claimed" ? r.relation : undefined,
    })),
    assertions,
    conflicts: run.analysis.conflicts ?? [],
    supersessions: run.analysis.supersessions ?? [],
    questions: [...run.analysis.ambiguities.map((q) => q.question), ...run.plan.clarifications.map((q) => q.question)],
  };
}

const cell = (value: unknown, max = 300) => {
  const text = String(value ?? "").replace(/\|/g, "\\|").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export function renderAuditTrail(trail: AuditTrail): string {
  const lines: string[] = [
    `# Requirements audit trail: ${cell(trail.run.ticket)}, ${cell(trail.run.pullRequest)}`,
    "",
    "For every expected value that was compared: where its authority came from, what was expected, and what was observed. Built by code from the run's records.",
    "",
    `- Commit tested: \`${cell(trail.run.commit, 40)}\`${trail.run.deployedCommit ? ` (the application reported \`${cell(trail.run.deployedCommit, 40)}\`)` : trail.run.commitEstablished ? ` (not reported by the application; ${cell(trail.run.commitEstablished, 240)})` : ""}`,
    `- Started: ${cell(trail.run.startedAt)} · mode: ${cell(trail.run.executionMode)} · model: ${cell(trail.run.model, 160)}`,
    `- Protected revision for requirement documents and owners: \`${cell(trail.authority.protectedRevision ?? "not recorded", 40)}\``,
    `- Fingerprint of the authoritative sources: \`${cell(trail.authority.fingerprint ?? "not recorded", 64)}\``,
  ];
  if (trail.authority.owners) {
    const o = trail.authority.owners;
    lines.push(
      `- Requirement owners in force: GitHub ${o.github.map((g) => `${g.id}${g.login ? ` (${cell(g.login, 40)})` : ""}`).join(", ") || "none"}; Jira ${o.jira.map((j) => cell(j.accountId, 60)).join(", ") || "none"}; fixture authors ${o.fixtureAuthors.map((n) => cell(n, 40)).join(", ") || "none"}`,
    );
  }
  for (const notice of trail.authority.notices) lines.push(`- **Note:** ${cell(notice, 500)}`);

  lines.push("", "## 1. Sources", "", "| Id | Trust | Kind | Origin | Why | SHA-256 of the text |", "|---|---|---|---|---|---|");
  for (const s of trail.sources) lines.push(`| ${cell(s.id)} | ${cell(s.trust)} | ${cell(s.kind)} | ${cell(s.origin)} | ${cell(s.basis)} | \`${cell((s.sha256 ?? "").slice(0, 16))}\` |`);

  lines.push("", "## 2. Amendments", "");
  if (trail.amendments.approved.length + trail.amendments.notApproved.length + trail.amendments.commands.length === 0) lines.push("None: the pull request changes no requirement document.");
  for (const a of trail.amendments.approved) {
    lines.push(`- **Approved:** change \`${a.changeHash.slice(0, 16)}\` to \`${cell(a.path)}\` (+${a.linesAdded} / -${a.linesRemoved} lines), by ${cell(a.approver, 40)} (GitHub user ${a.approverId}), comment ${a.commentId}, for commit \`${a.commit.slice(0, 12)}\``);
  }
  for (const a of trail.amendments.notApproved) lines.push(`- **Not approved, not used:** change \`${a.changeHash.slice(0, 16)}\` to \`${cell(a.path)}\` (${cell(a.kind)}, +${a.linesAdded} / -${a.linesRemoved} lines)`);
  for (const c of trail.amendments.commands) lines.push(`- Command in comment ${c.commentId} by ${cell(c.author, 40)}: ${c.accepted ? "accepted" : "refused"}: ${cell(c.reason)}`);

  lines.push("", "### Rules replaced by later approved sources", "");
  if (trail.supersessions.length === 0) lines.push("None.");
  for (const s of trail.supersessions) {
    lines.push(`- "${cell(s.retiredText)}" in ${cell(s.retiredSourceId)}, replaced by ${cell(s.bySourceId)} (${s.how === "owner-line" ? "stated by the requirement owner" : "read by the analyst, not confirmed by the owner"}). Not quotable; no expected value rests on it.`);
  }

  lines.push("", "## 3. Requirements", "", "| Id | Standing | Verified quote | Source |", "|---|---|---|---|");
  for (const r of trail.requirements) lines.push(`| ${cell(r.id)} | ${cell(r.standing)} | ${r.quote ? `"${cell(r.quote)}"` : "(none)"} | ${r.sourceId ? `${cell(r.sourceId)}: ${cell(r.sourceOrigin)}` : "(none)"} |`);

  lines.push("", "## 4. Assertions and evidence", "", "| Scenario / assertion | Rests on | Expected | Observed | Outcome | Evidence |", "|---|---|---|---|---|---|");
  for (const a of trail.assertions) {
    const basis = `${cell(a.requirementId ?? "?")} from ${cell(a.sourceId ?? "?")}: "${cell(a.quote ?? "", 160)}"`;
    if (a.evidence.compared) {
      const e = a.evidence;
      lines.push(
        `| ${cell(a.scenarioId)}/${cell(a.assertionId)} ${cell(a.description, 160)} | ${basis} | \`${cell(e.expected, 80)}\` (planned: ${cell(a.expectedAsPlanned, 80)}) | \`${cell(e.observed, 80)}\` | ${e.outcome === "match" ? "match" : "**MISMATCH**"}; scenario ${cell(e.scenarioVerdict)}${e.modelFreeRepeat ? `; repeat without a model: ${cell(e.modelFreeRepeat)}` : ""} | ${e.stepsRecorded} steps, \`${cell(e.evidenceDirectory, 160)}\`${e.screenshot ? `, screenshot \`${cell(e.screenshot, 160)}\`` : ""} |`,
      );
    } else {
      lines.push(`| ${cell(a.scenarioId)}/${cell(a.assertionId)} ${cell(a.description, 160)} | ${basis} | ${cell(a.expectedAsPlanned, 80)} | not compared | ${cell(a.evidence.why, 200)} | none |`);
    }
  }

  lines.push("", "## 5. Conflicts and open questions", "");
  if (trail.conflicts.length + trail.questions.length === 0) lines.push("None.");
  for (const c of trail.conflicts) lines.push(`- **${cell(c.id)}** (${cell(c.kind)}) ${cell(c.description, 500)}`);
  for (const q of trail.questions) lines.push(`- Question: ${cell(q, 400)}`);
  return `${lines.join("\n")}\n`;
}
