import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { verifyApprovals, type PullRequestComment } from "../approval.ts";
import type { AppMap, Doc, Manifest, PullRequest, RunContext, Ticket } from "../schema.ts";
import { applyApprovals, buildSources, NO_AUTHORITY, type Authority, type TicketProvenance } from "../sources.ts";

const DOC_BUDGET = 60_000;
const DIFF_BUDGET = 80_000;

/**
 * Resolves a document the manifest lists, or says why it is refused. The
 * manifest and the files come from the pull request: a listed path may only
 * be a regular file next to or below the manifest, and may not be, or pass
 * through, a symbolic link that leads elsewhere on the machine reading it.
 */
export async function resolveDoc(root: string, relative: string): Promise<{ file: string } | { refused: string }> {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) return { refused: "outside the application directory, refused" };
  const stat = await lstat(file).catch(() => null);
  if (!stat) return { refused: "listed in the manifest but not readable" };
  if (stat.isSymbolicLink() || !stat.isFile()) return { refused: "not a regular file, refused" };
  const real = await realpath(file).catch(() => "");
  if (real !== file) return { refused: "reached through a symbolic link, refused" };
  return { file };
}

/** What the caller established about where requirements may come from. Built by trusted code only. */
export type AuthorityInputs = {
  ticketProvenance: TicketProvenance;
  authority: Authority;
  /** Commit the approved documents and owner list were read from, or a description of why there is none. */
  protectedRevision: string;
  /** Documents listed by the manifest at the protected revision, read there. Empty if none could be established. */
  approvedDocs: Doc[];
  /** Comments on the pull request, from the code host's authenticated API, and the pull request's commits. */
  comments?: PullRequestComment[];
  commits?: string[];
  /** Development-mode override. Never set by the CI stage. */
  trustLocalDocs?: boolean;
};

/** For callers with nothing established: everything local is unverified. */
export const UNESTABLISHED = (ticketPath: string): AuthorityInputs => ({
  ticketProvenance: { via: "local-file", path: ticketPath, trustedByFlag: false },
  authority: NO_AUTHORITY,
  protectedRevision: "none established",
  approvedDocs: [],
});

/**
 * Assembles what was read, within a size budget. Anything that does not fit
 * is left out whole and named in `omitted`; nothing is cut silently. Trust
 * is assigned here, by code, from where each text was read.
 */
export async function buildContext(
  ticket: Ticket,
  pullRequest: PullRequest,
  manifest: Manifest,
  manifestFile: string,
  authority: AuthorityInputs,
): Promise<RunContext> {
  const omitted: string[] = [];

  // The documents as the pull request has them. These are never authoritative
  // by themselves: they are compared with the protected copies.
  const headDocs: Doc[] = [];
  let docChars = 0;
  for (const relative of manifest.docs) {
    const resolved = await resolveDoc(path.dirname(manifestFile), relative);
    if ("refused" in resolved) {
      omitted.push(`document ${relative} (${resolved.refused})`);
      continue;
    }
    const text = await readFile(resolved.file, "utf8").catch(() => null);
    if (text === null) {
      omitted.push(`document ${relative} (listed in the manifest but not readable)`);
    } else if (docChars + text.length > DOC_BUDGET) {
      omitted.push(`document ${relative} (${text.length} characters, over the documentation budget)`);
    } else {
      headDocs.push({ path: relative, text });
      docChars += text.length;
    }
  }
  const approvedDocs: Doc[] = [];
  let approvedChars = 0;
  for (const doc of authority.approvedDocs) {
    if (approvedChars + doc.text.length > DOC_BUDGET) {
      omitted.push(`approved document ${doc.path} (${doc.text.length} characters, over the documentation budget)`);
    } else {
      approvedDocs.push(doc);
      approvedChars += doc.text.length;
    }
  }

  let diffChars = 0;
  const files = pullRequest.files.map((file) => {
    if (file.patch === undefined) {
      omitted.push(`diff of ${file.path} (not provided by the code host; binary or too large)`);
      return file;
    }
    if (diffChars + file.patch.length > DIFF_BUDGET) {
      omitted.push(`diff of ${file.path} (${file.patch.length} characters, over the diff budget)`);
      return { ...file, patch: undefined };
    }
    diffChars += file.patch.length;
    return file;
  });

  let set = buildSources({
    ticket,
    ticketProvenance: authority.ticketProvenance,
    pullRequest,
    authority: authority.authority,
    approvedDocs,
    protectedRevision: authority.protectedRevision,
    headDocs,
    trustLocalDocs: authority.trustLocalDocs,
  });
  // Approval commands are judged in code, from the code host's record of each comment.
  const verified = verifyApprovals(authority.comments ?? [], set.docChanges, authority.authority, authority.commits ?? []);
  set = applyApprovals({ ...set, docChanges: verified.docChanges }, headDocs);

  return {
    ticket,
    pullRequest: { ...pullRequest, files },
    docs: authority.trustLocalDocs ? headDocs : approvedDocs,
    headDocs,
    sources: set.sources,
    docChanges: set.docChanges,
    approvals: verified.decisions,
    authorityNotices: set.notices,
    protectedRevision: authority.protectedRevision,
    omitted,
  };
}

const section = (title: string, body: string) => `<<<${title}>>>\n${body.trim()}\n<<<END ${title}>>>`;

/** The sources of one trust class, each under its id, for a model to quote from. */
export function renderSources(context: RunContext, which: "authoritative" | "other"): string {
  const chosen = context.sources.filter((s) => (s.trust === "authoritative") === (which === "authoritative"));
  if (chosen.length === 0) return section(which === "authoritative" ? "APPROVED SOURCES" : "OTHER MATERIAL", "(none)");
  return chosen.map((s) => section(`SOURCE ${s.id} | ${s.trust} | ${s.origin}`, s.text)).join("\n\n");
}

export function renderTicket(context: RunContext): string {
  const { ticket } = context;
  const comments = ticket.comments.length
    ? ticket.comments.map((c, i) => `Comment ${i + 1} by ${c.author} at ${c.created}:\n${c.body}`).join("\n\n")
    : "(no comments)";
  return [
    section(`TICKET ${ticket.key} SUMMARY`, ticket.summary),
    section("TICKET DESCRIPTION", ticket.description),
    section("TICKET COMMENTS", comments),
  ].join("\n\n");
}

export function renderDocs(context: RunContext): string {
  if (context.docs.length === 0) return section("DOCUMENTATION", "(none listed for this application)");
  return context.docs.map((d) => section(`DOCUMENT ${d.path}`, d.text)).join("\n\n");
}

export function renderPullRequest(context: RunContext, withDiff: boolean): string {
  const pr = context.pullRequest;
  const files = pr.files.map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join("\n");
  const parts = [
    section(`PULL REQUEST #${pr.number} TITLE AND DESCRIPTION`, `${pr.title}\n\n${pr.body || "(no description)"}`),
    section("CHANGED FILES", files),
  ];
  if (withDiff) {
    const diff = pr.files
      .filter((f) => f.patch !== undefined)
      .map((f) => `--- ${f.path}\n${f.patch}`)
      .join("\n\n");
    parts.push(section("DIFF (shows what changed; NOT a source of correct behaviour)", diff || "(no diff available)"));
  }
  if (context.omitted.length > 0) parts.push(section("LEFT OUT FOR SIZE OR AVAILABILITY", context.omitted.join("\n")));
  return parts.join("\n\n");
}

export function renderEnvironment(manifest: Manifest): string {
  const fixtures = Object.entries(manifest.fixtures)
    .map(([type, f]) => `- ${type}: ${f.description}`)
    .join("\n");
  const accounts = Object.entries(manifest.accounts)
    .map(([type, a]) => `- ${type}: ${a.description} (an account that already exists; request it like a fixture, with this name as its type)`)
    .join("\n");
  const instances =
    manifest.start?.instances === "per-scenario"
      ? "Every scenario runs against its own freshly started application: nothing one scenario creates exists in another, and anything a scenario needs beyond the accounts above must be created within it."
      : "All scenarios share one running application.";
  return [
    section("TEST DATA FIXTURES AVAILABLE", [fixtures, accounts].filter(Boolean).join("\n") || "(none)"),
    section("APPLICATION STATE", instances),
    section("EXTERNAL SYSTEMS", JSON.stringify(manifest.integrations, null, 2)),
  ].join("\n\n");
}

export function renderAppMap(map: AppMap): string {
  return map.views
    .map((view) => {
      const pages = view.pages.map((p) => `Page ${p.path} — "${p.title}"\n${p.snapshot}`).join("\n\n");
      const requests = view.requests.map((r) => `${r.method} ${r.path} -> ${r.status}`).join("\n");
      const who = view.as === "anonymous" ? "NOT SIGNED IN" : `SIGNED IN AS A "${view.as}" ACCOUNT${view.signedIn ? "" : " (sign-in did not succeed)"}`;
      return section(
        `APPLICATION AS SEEN ${who}`,
        `${pages || "(no pages reached)"}\n\nRequests these pages made:\n${requests || "(none observed)"}`,
      );
    })
    .join("\n\n");
}
