/**
 * The parts of a report that say where requirements came from: sources and
 * their trust, what the pull request changed in requirement documents, how
 * approval commands were judged, conflicts, and what the pull request claimed
 * that was not used. Shared by the full report and the pull request comment.
 */
import type { ApprovalDecision } from "../approval.ts";
import type { DocChange } from "../sources.ts";

export type AuthorityView = {
  headSha: string;
  context?: {
    sources?: { id: string; kind: string; trust: string; origin: string; basis: string }[];
    docChanges?: DocChange[];
    approvals?: ApprovalDecision[];
    authorityNotices?: string[];
    protectedRevision?: string;
  };
  analysis: {
    requirements: { id: string; text: string; kind: string; quote: string; sourceId?: string; trust?: string; origin?: string; relation?: string }[];
    conflicts?: { id: string; kind: string; description: string }[];
  };
};

/** `clean` makes untrusted text safe for where the lines will be shown. */
export function authorityLines(view: AuthorityView, clean: (text: unknown, max?: number) => string, heading = "###"): string[] {
  const lines: string[] = [];
  const context = view.context ?? {};
  const conflicts = view.analysis.conflicts ?? [];
  const changes = context.docChanges ?? [];
  const claims = view.analysis.requirements.filter((r) => r.kind === "claimed");

  if (conflicts.length > 0) {
    lines.push(
      `${heading} Conflicts with approved requirements`,
      "",
      "Tests ran against the approved requirements. These must be settled by a requirement owner; until then the result cannot be \"ready\".",
      "",
    );
    for (const c of conflicts.slice(0, 30)) lines.push(`- **${clean(c.id, 8)}** (${clean(c.kind, 24)}) ${clean(c.description, 500)}`);
    if (conflicts.length > 30) lines.push(`- …and ${conflicts.length - 30} more`);
    lines.push("");
  }

  if (changes.length > 0) {
    lines.push(`${heading} Requirement documents changed by this pull request`, "");
    for (const change of changes.slice(0, 20)) {
      const what = change.kind === "modified" ? "changed" : change.kind === "removed" ? "removed" : "added as a new requirement document";
      if (change.approval) {
        lines.push(
          `- \`${clean(change.path, 120)}\` ${what}. **Approved** by ${clean(change.approval.approver, 40)} (GitHub user ${change.approval.approverId}) for commit \`${clean(change.approval.commit.slice(0, 12), 12)}\`; the change is treated as an approved amendment.`,
        );
      } else {
        lines.push(
          `- \`${clean(change.path, 120)}\` ${what}: ${change.addedLines.length} line(s) added, ${change.removedLines.length} removed. **Not approved**, so not used as a requirement.`,
          `  - A listed requirement owner can approve exactly this change by commenting: \`/releaseproof approve-requirements ${clean(view.headSha, 40)} ${clean(change.hash, 64)}\``,
        );
      }
    }
    lines.push("");
  }

  const judged = context.approvals ?? [];
  if (judged.length > 0) {
    lines.push(`${heading} Approval commands`, "");
    for (const d of judged.slice(0, 20)) {
      lines.push(`- Comment ${d.commentId} by ${clean(d.author, 40)}: ${d.accepted ? "accepted" : "**refused**"}: ${clean(d.reason, 240)}`);
    }
    lines.push("");
  }

  if (claims.length > 0) {
    lines.push(`${heading} Stated by the pull request or by unverified sources (never used as an expected value)`, "");
    for (const r of claims.slice(0, 30)) {
      lines.push(`- ${clean(r.id, 10)} (${clean(r.trust ?? "unverified", 16)}; ${clean(r.relation ?? "none", 12)}): "${clean(r.quote, 240)}"; from ${clean(r.origin ?? "unknown", 200)}`);
    }
    lines.push("");
  }

  const sources = context.sources ?? [];
  if (sources.length > 0 || (context.authorityNotices ?? []).length > 0) {
    lines.push(`${heading} Requirement sources`, "");
    for (const notice of context.authorityNotices ?? []) lines.push(`- **Note:** ${clean(notice, 400)}`);
    if (context.protectedRevision) lines.push(`- Protected revision: \`${clean(context.protectedRevision.slice(0, 40), 40)}\``);
    lines.push("", "| Id | Trust | Origin | Why |", "|---|---|---|---|");
    for (const s of sources.slice(0, 40)) {
      lines.push(`| ${clean(s.id, 8)} | ${s.trust === "authoritative" ? "authoritative" : `**${clean(s.trust, 16)}**`} | ${clean(s.origin, 220)} | ${clean(s.basis, 160)} |`);
    }
    lines.push("");
  }
  return lines;
}
