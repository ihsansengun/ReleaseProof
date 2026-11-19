/**
 * Requirement-source authority.
 *
 * Authority comes from where a text was read, never from what it says. This
 * module builds a record for every text that enters a run and assigns its
 * trust level in code, before any model is involved. A model may point at a
 * record and quote it; nothing a model returns can assign or raise trust.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Doc, PullRequest, Ticket } from "./schema.ts";

export type Trust = "authoritative" | "pr-controlled" | "unverified";

export type SourceKind =
  | "ticket-summary"
  | "ticket-description"
  | "ticket-comment"
  | "approved-doc"
  | "amendment"
  | "pr-description"
  | "pr-doc-change";

export type SourceRecord = {
  id: string;
  kind: SourceKind;
  trust: Trust;
  /** Where the text was read, in words a reader can check. */
  origin: string;
  /** Why this trust level was assigned. */
  basis: string;
  text: string;
  sha256: string;
  /** For text a pull request adds to a document: the change it belongs to. */
  changeHash?: string;
  /** For documents: the path, as the manifest lists it. */
  path?: string;
  /**
   * Position in the ticket's thread: 0 for the summary and description, then
   * comments in the sequence the ticket system returned them. Absent for
   * sources outside the ticket, which have no sequence relative to it.
   */
  thread?: number;
  /** When the text was last written, as the ticket system reports it. */
  writtenAt?: string;
  /**
   * Who wrote it, as the ticket system identifies them: display name and
   * account id. Kept apart from `origin`, which is shown in public reports,
   * and written only to the audit trail.
   */
  identity?: string;
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Who may state or approve requirements. Read only from the protected revision. */
export const Authority = z.object({
  requirementOwners: z
    .object({
      /** GitHub users by immutable numeric id. The login is for readers only. */
      github: z.array(z.object({ id: z.number().int().positive(), login: z.string().optional() })).default([]),
      /** Jira users by account id. */
      jira: z.array(z.object({ accountId: z.string().min(1), name: z.string().optional() })).default([]),
      /**
       * Comment authors in ticket fixture files, by display name. A display
       * name is not an identity: this list is honoured only for fixture files
       * read from the protected revision, never for live Jira.
       */
      fixtureAuthors: z.array(z.string().min(1)).default([]),
    })
    .default({ github: [], jira: [], fixtureAuthors: [] }),
});
export type Authority = z.infer<typeof Authority>;
export const NO_AUTHORITY: Authority = { requirementOwners: { github: [], jira: [], fixtureAuthors: [] } };

/** How the ticket itself reached this run. */
export type TicketProvenance =
  /** Fetched by the trusted stage over Jira's authenticated API. */
  | { via: "jira-api"; site: string }
  /** A fixture file read from the protected revision. */
  | { via: "protected-file"; revision: string; path: string }
  /** A local file whose revision could not be established. */
  | { via: "local-file"; path: string; trustedByFlag: boolean };

/** One change a pull request makes to the documents that count as requirements. */
export type DocChange = {
  path: string;
  kind: "modified" | "added-to-list" | "removed";
  /** Identifies exactly this change: the path, the protected text and the pull request's text. */
  hash: string;
  removedLines: string[];
  addedLines: string[];
  /** Set when a listed requirement owner approved exactly this change. */
  approval?: { approver: string; approverId: number; commentId: number; commit: string };
};

export const changeHash = (path: string, baseText: string | undefined, headText: string | undefined) =>
  sha256(`${path}\0${baseText === undefined ? "absent" : sha256(baseText)}\0${headText === undefined ? "absent" : sha256(headText)}`);

/** Lines only in `a` and lines only in `b`, by longest common subsequence. */
export function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) removed.push(x[i++]!);
    else added.push(y[j++]!);
  }
  while (i < n) removed.push(x[i++]!);
  while (j < m) added.push(y[j++]!);
  return { removed, added };
}

export type SourceInputs = {
  ticket: Ticket;
  ticketProvenance: TicketProvenance;
  pullRequest: PullRequest;
  authority: Authority;
  /** Documents listed by the manifest at the protected revision, read at that revision. */
  approvedDocs: Doc[];
  /** Commit the approved documents and the authority file were read from, or a description. */
  protectedRevision: string;
  /** The same paths, plus any the pull request's manifest adds, as the pull request has them. */
  headDocs: Doc[];
  /** Development-mode override: local documents count as approved. Never set in CI. */
  trustLocalDocs?: boolean;
};

export type SourceSet = {
  sources: SourceRecord[];
  docChanges: DocChange[];
  /** Things a reader must know about how trust was assigned. */
  notices: string[];
};

/**
 * Builds every source record of a run. This is the only place trust is
 * assigned, and it reads no model output.
 */
export function buildSources(input: SourceInputs): SourceSet {
  const { ticket, ticketProvenance: prov, authority } = input;
  const sources: SourceRecord[] = [];
  const notices: string[] = [];
  const add = (record: Omit<SourceRecord, "sha256">) => {
    if (record.text.trim() !== "") sources.push({ ...record, sha256: sha256(record.text) });
  };

  // ---- the ticket -----------------------------------------------------------
  const ticketTrusted = prov.via === "jira-api" || prov.via === "protected-file" || prov.trustedByFlag;
  const ticketTrust: Trust = ticketTrusted ? "authoritative" : "unverified";
  const where =
    prov.via === "jira-api"
      ? `Jira issue ${ticket.key} on ${prov.site}, fetched over the authenticated API`
      : prov.via === "protected-file"
        ? `ticket file ${prov.path} at protected revision ${prov.revision.slice(0, 12)}`
        : `local file ${prov.path}`;
  const ticketBasis =
    prov.via === "jira-api"
      ? "issue fields of an authenticated Jira record"
      : prov.via === "protected-file"
        ? "ticket fixture read from the protected revision"
        : prov.trustedByFlag
          ? "local file, trusted by the development-mode flag --trust-local-docs"
          : "local file whose revision could not be established";
  if (prov.via === "jira-api") {
    notices.push(
      "The ticket's summary and description are trusted because Jira returned them over its authenticated API. Jira's own permissions decide who may edit an issue, and that can include people outside the configured requirement owners. Comments are checked against the owner list; the description is not.",
    );
  }
  if (prov.via === "local-file") {
    notices.push(
      prov.trustedByFlag
        ? "Development mode: local requirement files were trusted by --trust-local-docs. This run does not establish trusted requirements."
        : `The ticket was read from a local file (${prov.path}) whose revision could not be established, so it is unverified and cannot set an expected value.`,
    );
  }
  add({ id: "T1", kind: "ticket-summary", trust: ticketTrust, origin: `${where}: summary`, basis: ticketBasis, text: ticket.summary, thread: 0 });
  add({ id: "T2", kind: "ticket-description", trust: ticketTrust, origin: `${where}: description`, basis: ticketBasis, text: ticket.description, thread: 0 });

  const jiraOwners = new Set(authority.requirementOwners.jira.map((o) => o.accountId));
  const fixtureAuthors = new Set(authority.requirementOwners.fixtureAuthors);
  ticket.comments.forEach((comment, index) => {
    let owner = false;
    let basis: string;
    if (!ticketTrusted) basis = "comment on an unverified ticket";
    else if (prov.via === "jira-api") {
      owner = comment.authorId !== undefined && jiraOwners.has(comment.authorId);
      basis = owner ? "comment by a listed requirement owner (Jira account id)" : "comment by someone who is not a listed requirement owner";
    } else if (comment.authorId !== undefined && jiraOwners.has(comment.authorId)) {
      owner = true;
      basis = "comment by a listed requirement owner (Jira account id)";
    } else {
      // Fixture files usually carry display names only.
      owner = fixtureAuthors.has(comment.author);
      basis = owner ? "comment in a protected ticket fixture by a listed fixture author" : "comment by someone who is not a listed requirement owner";
    }
    add({
      id: `T3.${index + 1}`,
      kind: "ticket-comment",
      trust: owner ? "authoritative" : "unverified",
      origin: `${where}: comment ${comment.id ?? index + 1} by ${owner ? "a listed requirement owner" : "someone who is not a listed requirement owner"}${comment.created ? ` at ${comment.created}` : ""}`,
      identity: `${comment.author}${comment.authorId ? ` (${comment.authorId})` : ""}`,
      basis,
      text: comment.body,
      thread: index + 1,
      writtenAt: comment.updated ?? comment.created,
    });
  });

  // ---- documents ------------------------------------------------------------
  const docChanges: DocChange[] = [];
  const head = new Map(input.headDocs.map((d) => [d.path, d.text]));
  const approvedPaths = new Set(input.approvedDocs.map((d) => d.path));
  input.approvedDocs.forEach((doc, index) => {
    add({
      id: `D${index + 1}`,
      kind: "approved-doc",
      trust: "authoritative",
      origin: `document ${doc.path} at protected revision ${input.protectedRevision.slice(0, 12)}`,
      basis: "listed by the manifest at the protected revision and read at that revision",
      text: doc.text,
      path: doc.path,
    });
    const headText = head.get(doc.path);
    if (headText === undefined) {
      docChanges.push({ path: doc.path, kind: "removed", hash: changeHash(doc.path, doc.text, undefined), removedLines: doc.text.split("\n"), addedLines: [] });
    } else if (headText !== doc.text) {
      const { removed, added } = lineDiff(doc.text, headText);
      docChanges.push({ path: doc.path, kind: "modified", hash: changeHash(doc.path, doc.text, headText), removedLines: removed, addedLines: added });
    }
  });
  for (const doc of input.headDocs) {
    if (approvedPaths.has(doc.path)) continue;
    if (input.trustLocalDocs) {
      add({
        id: `D${sources.filter((s) => s.kind === "approved-doc").length + 1}`,
        kind: "approved-doc",
        trust: "authoritative",
        origin: `local document ${doc.path}`,
        basis: "local file, trusted by the development-mode flag --trust-local-docs",
        text: doc.text,
      });
      continue;
    }
    // Listed only by the pull request's manifest, or not on the protected branch yet.
    docChanges.push({ path: doc.path, kind: "added-to-list", hash: changeHash(doc.path, undefined, doc.text), removedLines: [], addedLines: doc.text.split("\n") });
  }
  if (input.trustLocalDocs && !notices.some((n) => n.startsWith("Development mode"))) {
    notices.push("Development mode: local documents were trusted by --trust-local-docs. This run does not establish trusted requirements.");
  }

  // ---- what the pull request says ------------------------------------------
  add({
    id: "P1",
    kind: "pr-description",
    trust: "pr-controlled",
    origin: `title and description of pull request #${input.pullRequest.number}`,
    basis: "written by the pull request's author",
    text: `${input.pullRequest.title}\n\n${input.pullRequest.body}`,
  });
  docChanges.forEach((change, index) => {
    if (change.addedLines.join("").trim() === "") return;
    add({
      id: `P${index + 2}`,
      kind: "pr-doc-change",
      trust: "pr-controlled",
      origin: `text this pull request ${change.kind === "added-to-list" ? "adds as a new document" : "adds or changes in"} ${change.path}`,
      basis: "changed by the pull request and not on the protected branch",
      text: change.addedLines.join("\n"),
      changeHash: change.hash,
      path: change.path,
    });
  });

  return { sources, docChanges, notices };
}

/**
 * Turns approved document changes into authoritative sources. Called after
 * approval commands have been verified in code; a change without a verified
 * approval is left exactly as it was.
 */
export function applyApprovals(set: SourceSet, headDocs: Doc[] = []): SourceSet {
  const approvedChange = (path: string | undefined) => set.docChanges.find((c) => c.path === path && c.approval);
  const sources = set.sources.flatMap((source): SourceRecord[] => {
    // Precedence: once a change to an approved document is approved, the
    // document as amended is what counts. The superseded text stops being a
    // source, so a requirement can no longer rest on a rule that was removed.
    if (source.kind === "approved-doc") {
      const change = approvedChange(source.path);
      if (!change?.approval) return [source];
      if (change.kind === "removed") return [];
      const amended = headDocs.find((d) => d.path === source.path)?.text;
      if (amended === undefined) return [source];
      return [
        {
          ...source,
          text: amended,
          sha256: sha256(amended),
          origin: `${source.origin}, as amended in this pull request with the approval of ${change.approval.approver} (GitHub user ${change.approval.approverId}, comment ${change.approval.commentId})`,
          basis: `approved document with an amendment approved by a listed requirement owner; approval bound to change ${change.hash.slice(0, 12)}`,
        },
      ];
    }
    if (source.kind !== "pr-doc-change") return [source];
    const change = set.docChanges.find((c) => c.hash === source.changeHash && c.approval);
    if (!change?.approval) return [source];
    return [{
      ...source,
      kind: "amendment" as const,
      trust: "authoritative" as const,
      origin: `change to ${change.path} in this pull request, approved by ${change.approval.approver} (GitHub user ${change.approval.approverId}) in comment ${change.approval.commentId} for commit ${change.approval.commit.slice(0, 12)}`,
      basis: `approved by a listed requirement owner; approval bound to change ${change.hash.slice(0, 12)}`,
    }];
  });
  return { ...set, sources };
}

/** Changes whenever an authoritative source changes, and only then. */
export function fingerprint(sources: SourceRecord[]): string {
  const parts = sources
    .filter((s) => s.trust === "authoritative")
    .map((s) => `${s.kind}:${s.sha256}`)
    .sort();
  return sha256(parts.join("\n"));
}

/** Loose comparison form: the same words in the same sequence, whatever the formatting. */
export const normalise = (text: string) =>
  text
    .replace(/[*_`#>]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const MIN_QUOTE = 8;

// ---- precedence between authoritative sources --------------------------------

/**
 * One rule that a later authoritative source replaces.
 *
 *   owner-line  a requirement owner wrote `Supersedes: "<text>"`; found and
 *               retired by code alone
 *   inferred    the analyst model read a later source as replacing the text;
 *               code checked everything about it except that reading
 */
export type Supersession = {
  retiredText: string;
  retiredSourceId: string;
  bySourceId: string;
  how: "owner-line" | "inferred";
};

const SUPERSEDES_LINE = /^[ \t>*-]*Supersedes:[ \t]*["“](.+)["”][ \t]*$/gim;

/** The `Supersedes:` lines of a text, each with the text it names. */
export function supersedesLines(text: string): string[] {
  return [...text.matchAll(SUPERSEDES_LINE)].map((m) => m[1]!.trim());
}

/**
 * What may be quoted from a source: its text without `Supersedes:` lines.
 * Such a line repeats the old rule word for word, and must not make that
 * rule quotable from the very comment that retires it.
 */
export const quotable = (text: string) => text.replace(SUPERSEDES_LINE, "");

/**
 * Whether `older` was written before `newer`, as far as code can establish.
 * Only sources of the ticket have a sequence: the summary and description
 * come first, then comments by the time the ticket system reports, or by
 * their position when it reports none. Anything else is not ordered.
 */
export function precedes(older: SourceRecord, newer: SourceRecord): boolean {
  if (older.thread === undefined || newer.thread === undefined || older.id === newer.id) return false;
  if (older.thread === 0) return newer.thread > 0;
  if (newer.thread === 0) return false;
  const a = older.writtenAt ? Date.parse(older.writtenAt) : NaN;
  const b = newer.writtenAt ? Date.parse(newer.writtenAt) : NaN;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a < b;
  return older.thread < newer.thread;
}

export type SupersessionProblem = { bySourceId: string; text: string; problem: string };

/**
 * Checks one proposed supersession. Everything here is a fact about the
 * records: both sources exist and are authoritative, the retiring one is
 * later, and the retired text is really in the earlier one.
 */
export function checkSupersession(
  proposal: { retiredText: string; retiredSourceId: string; bySourceId: string },
  sources: SourceRecord[],
): string | undefined {
  const by = sources.find((s) => s.id === proposal.bySourceId);
  const retired = sources.find((s) => s.id === proposal.retiredSourceId);
  if (!by || !retired) return "it names a source that does not exist";
  if (by.trust !== "authoritative") return `${by.id} is not an approved source, so it cannot replace a rule`;
  if (retired.trust !== "authoritative") return `${retired.id} is not an approved source`;
  if (!precedes(retired, by)) return `${by.id} is not established to be later than ${retired.id}`;
  const needle = normalise(proposal.retiredText);
  if (needle.length < MIN_QUOTE) return "the text it names is too short to identify a rule";
  if (!normalise(quotable(retired.text)).includes(needle)) return `the text it names is not in ${retired.id}`;
  return undefined;
}

/**
 * Supersessions that requirement owners stated themselves. Reads no model
 * output. A line that cannot be honoured is returned as a problem, never
 * silently dropped.
 */
export function ownerSupersessions(sources: SourceRecord[]): { supersessions: Supersession[]; problems: SupersessionProblem[] } {
  const supersessions: Supersession[] = [];
  const problems: SupersessionProblem[] = [];
  for (const by of sources) {
    if (by.thread === undefined || by.thread === 0) continue;
    for (const text of supersedesLines(by.text)) {
      if (by.trust !== "authoritative") {
        problems.push({ bySourceId: by.id, text, problem: `${by.id} is not from a listed requirement owner, so its "Supersedes:" line retires nothing` });
        continue;
      }
      const needle = normalise(text);
      const targets = sources.filter(
        (s) => s.trust === "authoritative" && precedes(s, by) && needle.length >= MIN_QUOTE && normalise(quotable(s.text)).includes(needle),
      );
      if (targets.length === 0) {
        problems.push({ bySourceId: by.id, text, problem: `the text named by the "Supersedes:" line in ${by.id} was not found in any earlier approved source of the ticket` });
        continue;
      }
      for (const target of targets) supersessions.push({ retiredText: text, retiredSourceId: target.id, bySourceId: by.id, how: "owner-line" });
    }
  }
  return { supersessions, problems };
}

/** Start positions of every occurrence of `needle` in `hay`. */
const occurrences = (hay: string, needle: string) => {
  const found: number[] = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) found.push(at);
  return found;
};

/** True if the quote can only be found, in this source, inside or across retired text. */
function restsOnRetired(source: SourceRecord, needle: string, retired: Supersession[]): Supersession | undefined {
  const mine = retired.filter((r) => r.retiredSourceId === source.id);
  if (mine.length === 0) return undefined;
  const hay = normalise(quotable(source.text));
  const spans = mine.flatMap((r) => {
    const text = normalise(r.retiredText);
    return occurrences(hay, text).map((start) => ({ start, end: start + text.length, r }));
  });
  let hit: Supersession | undefined;
  for (const start of occurrences(hay, needle)) {
    const overlap = spans.find((span) => start < span.end && span.start < start + needle.length);
    if (!overlap) return undefined;
    hit = overlap.r;
  }
  return hit;
}

export type Attribution =
  | { kind: "documented"; source: SourceRecord }
  | { kind: "claimed"; source: SourceRecord }
  | { kind: "inferred"; problem: string; superseded?: Supersession };

/**
 * Decides what a quoted statement is worth. The quote is checked against the
 * one source the model named. Trust comes from that source's record.
 *
 * Text that the pull request also copies elsewhere stays authoritative if it
 * is in the authoritative source named. Text found only in pull-request
 * material can never be documented, whichever id the model cites.
 */
export function attributeQuote(sourceId: string, quote: string, sources: SourceRecord[], retired: Supersession[] = []): Attribution {
  const needle = normalise(quote);
  if (needle.length < MIN_QUOTE) return { kind: "inferred", problem: "it has no usable quote" };
  const contains = (s: SourceRecord) => normalise(quotable(s.text)).includes(needle) && !restsOnRetired(s, needle, retired);

  let source = sources.find((s) => s.id === sourceId);
  if (sourceId === "") {
    // Analyses recorded before sources had ids: find where the text is, best trust first.
    source = sources.find((s) => s.trust === "authoritative" && contains(s)) ?? sources.find(contains);
    if (!source) return { kind: "inferred", problem: "its quote does not appear in any source" };
  } else if (!source) {
    return { kind: "inferred", problem: `it cites a source that does not exist ("${sourceId.slice(0, 20)}")` };
  } else if (!contains(source)) {
    const gone = restsOnRetired(source, needle, retired);
    if (gone) return { kind: "inferred", superseded: gone, problem: `its quote is a rule in ${source.id} that ${gone.bySourceId} replaced` };
    return { kind: "inferred", problem: `its quote does not appear in source ${source.id}` };
  }
  return source.trust === "authoritative" ? { kind: "documented", source } : { kind: "claimed", source };
}
