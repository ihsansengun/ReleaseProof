// Read-only check of live Jira ingestion and source classification. No model.
// Run from the repository root:
//   JIRA_BASE_URL=https://api.atlassian.com/ex/jira/<site id> JIRA_EMAIL=placeholder JIRA_API_TOKEN=proxy-injected \
//     npx tsx eval/results/2026-11-19-jira/verify.mts
// Where a network proxy adds the credential, the two placeholders are never sent on as given.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { jiraCloudProvider, takeJiraCredentials } from "../../../packages/agent/src/ingest/jira.ts";
import { Authority, buildSources, fingerprint } from "../../../packages/agent/src/sources.ts";

const authority = Authority.parse(parse(readFileSync(".releaseproof/authority.yml", "utf8")));
const credentials = takeJiraCredentials(process.env);
if (!credentials) throw new Error("JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set.");
const provider = jiraCloudProvider(credentials);
const pullRequest = { repo: "x/y", number: 0, title: "", body: "", headSha: "", headRef: "", baseRef: "", files: [] };
const out: unknown[] = [];

for (const key of ["KAN-4", "KAN-5", "KAN-6", "KAN-7", "KAN-999"]) {
  const loaded = await provider.load(key);
  if (!loaded) {
    out.push({ key, found: false });
    continue;
  }
  const { ticket } = loaded;
  const classify = (t: typeof ticket) =>
    buildSources({ ticket: t, ticketProvenance: { via: "jira-api", site: (loaded as { site: string }).site }, pullRequest, authority, approvedDocs: [], protectedRevision: "n/a", headDocs: [] }).sources;
  const sources = classify(ticket);
  out.push({
    key,
    found: true,
    via: loaded.via,
    issueId: ticket.id,
    summary: ticket.summary,
    // Display names are left out of this record; account ids are what authority rests on.
    reporterAccountId: ticket.reporter?.accountId,
    updated: ticket.updated,
    descriptionCharacters: ticket.description.length,
    numberedCriteria: (ticket.description.match(/^- .+$/gm) ?? []).length,
    descriptionStart: ticket.description.slice(0, 160),
    comments: ticket.comments.map((c) => ({ id: c.id, authorId: c.authorId, created: c.created, start: c.body.slice(0, 90) })),
    sources: sources.filter((s) => s.kind !== "pr-description").map((s) => ({ id: s.id, kind: s.kind, trust: s.trust, basis: s.basis, sha256: s.sha256.slice(0, 16) })),
    fingerprint: fingerprint(sources).slice(0, 16),
    fingerprintWithoutComments: fingerprint(classify({ ...ticket, comments: [] })).slice(0, 16),
    // The same comments as if an account outside the owner list had written them (mocked identity).
    commentTrustIfWrittenBySomeoneElse: classify({ ...ticket, comments: ticket.comments.map((c) => ({ ...c, authorId: "mocked:not-an-owner" })) })
      .filter((s) => s.kind === "ticket-comment")
      .map((s) => s.trust),
    ownerListedInAuthorityFile: ticket.comments.every((c) => authority.requirementOwners.jira.some((o) => o.accountId === c.authorId)),
  });
}
const text = JSON.stringify(out, null, 2);
if (/proxy-injected|placeholder|Basic |authorization/i.test(text)) throw new Error("A credential or placeholder leaked into the output.");
console.log(text);
