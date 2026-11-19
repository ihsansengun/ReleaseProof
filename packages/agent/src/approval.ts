/**
 * Approval of a documentation change by a requirement owner, given as a
 * comment on the pull request:
 *
 *     /releaseproof approve-requirements <commit sha> <change hash>
 *     /releaseproof revoke-requirements <change hash>
 *
 * Everything here is decided in code from GitHub's own record of the comment.
 * No model reads these comments to decide whether something is approved.
 */
import type { Authority, DocChange } from "./sources.ts";

/** A pull request comment as GitHub's API returns it. */
export type PullRequestComment = {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { id: number; login: string; type: string } | null;
};

const APPROVE = /^\/releaseproof approve-requirements ([0-9a-f]{40}) ([0-9a-f]{64})$/;
const REVOKE = /^\/releaseproof revoke-requirements ([0-9a-f]{64})$/;
const LOOKS_LIKE_COMMAND = /\/releaseproof\s+(approve|revoke)-requirements/i;

export type ApprovalDecision = {
  commentId: number;
  author: string;
  accepted: boolean;
  /** Why it was accepted or refused, for the report. */
  reason: string;
  changeHash?: string;
};

/**
 * Applies valid approvals to the document changes and explains every comment
 * that looked like a command. An approval counts only if all of these hold:
 *
 *   - the whole comment is the command, exactly, and was never edited
 *   - its author is a person whose numeric GitHub id is a listed owner
 *   - the commit it names is one of this pull request's commits
 *   - the change hash it names is the hash of a change as it stands now
 *   - no later revocation of that hash by a listed owner exists
 *
 * It applies to that one change and to nothing else in the pull request.
 */
export function verifyApprovals(
  comments: PullRequestComment[],
  docChanges: DocChange[],
  authority: Authority,
  pullRequestCommits: string[],
): { docChanges: DocChange[]; decisions: ApprovalDecision[] } {
  const owners = new Map(authority.requirementOwners.github.map((o) => [o.id, o.login]));
  const commits = new Set(pullRequestCommits);
  const byHash = new Map(docChanges.map((c) => [c.hash, c]));
  const decisions: ApprovalDecision[] = [];
  const approved = new Map<string, DocChange["approval"]>();

  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  for (const comment of ordered) {
    // Leading and trailing whitespace is not content; anything else is.
    const body = (comment.body ?? "").trim();
    if (!LOOKS_LIKE_COMMAND.test(body)) continue;
    const author = comment.user?.login ?? "unknown";
    const refuse = (reason: string, changeHash?: string) => decisions.push({ commentId: comment.id, author, accepted: false, reason, changeHash });

    const approve = APPROVE.exec(body);
    const revoke = REVOKE.exec(body);
    if (!approve && !revoke) {
      refuse("the comment is not exactly one well-formed command (nothing may precede or follow it)");
      continue;
    }
    if (comment.created_at !== comment.updated_at) {
      refuse("the comment was edited after it was posted");
      continue;
    }
    if (!comment.user || comment.user.type !== "User") {
      refuse("the author is not a person's account");
      continue;
    }
    if (!owners.has(comment.user.id)) {
      refuse(`${author} (GitHub user ${comment.user.id}) is not a listed requirement owner`);
      continue;
    }
    if (revoke) {
      const hash = revoke[1]!;
      const had = approved.delete(hash);
      decisions.push({ commentId: comment.id, author, accepted: true, reason: had ? "approval revoked" : "revocation recorded; nothing was approved under that hash", changeHash: hash });
      continue;
    }
    const [, commit, hash] = approve!;
    if (!commits.has(commit!)) {
      refuse("the commit it names is not a commit of this pull request as it stands", hash);
      continue;
    }
    const change = byHash.get(hash!);
    if (!change) {
      refuse("no document change in this pull request has that hash now; the content changed after approval, or the hash is wrong", hash);
      continue;
    }
    approved.set(hash!, { approver: author, approverId: comment.user.id, commentId: comment.id, commit: commit! });
    decisions.push({ commentId: comment.id, author, accepted: true, reason: `approved the change to ${change.path}`, changeHash: hash });
  }

  return {
    docChanges: docChanges.map((c) => (approved.has(c.hash) ? { ...c, approval: approved.get(c.hash) } : { ...c, approval: undefined })),
    decisions,
  };
}

/** The exact comment a requirement owner would post to approve a change. */
export const approvalCommand = (commit: string, change: DocChange) => `/releaseproof approve-requirements ${commit} ${change.hash}`;
