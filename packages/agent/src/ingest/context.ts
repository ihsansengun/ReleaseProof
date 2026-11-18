import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppMap, Doc, Manifest, PullRequest, RunContext, Ticket } from "../schema.ts";

const DOC_BUDGET = 60_000;
const DIFF_BUDGET = 80_000;

/**
 * Assembles what was read, within a size budget. Anything that does not fit
 * is left out whole and named in `omitted`; nothing is cut silently.
 */
export async function buildContext(
  ticket: Ticket,
  pullRequest: PullRequest,
  manifest: Manifest,
  manifestFile: string,
): Promise<RunContext> {
  const omitted: string[] = [];

  const docs: Doc[] = [];
  let docChars = 0;
  for (const relative of manifest.docs) {
    const file = path.resolve(path.dirname(manifestFile), relative);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) {
      omitted.push(`document ${relative} (listed in the manifest but not readable)`);
    } else if (docChars + text.length > DOC_BUDGET) {
      omitted.push(`document ${relative} (${text.length} characters, over the documentation budget)`);
    } else {
      docs.push({ path: relative, text });
      docChars += text.length;
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

  return { ticket, pullRequest: { ...pullRequest, files }, docs, omitted };
}

/** Every piece of text that may establish intended behaviour, for quote checks. */
export function behaviourSources(context: RunContext): string {
  return [
    context.ticket.summary,
    context.ticket.description,
    ...context.ticket.comments.map((c) => c.body),
    ...context.docs.map((d) => d.text),
  ].join("\n");
}

const section = (title: string, body: string) => `<<<${title}>>>\n${body.trim()}\n<<<END ${title}>>>`;

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
  return [
    section("TEST DATA FIXTURES AVAILABLE", fixtures || "(none)"),
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
