import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Ticket } from "../schema.ts";

type AdfNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[] };

/** Turns Atlassian Document Format into plain text that keeps list and line structure. */
export function flattenAdf(node: AdfNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  const children = () => (node.content ?? []).map(flattenAdf).join("");
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
      return `${children().trimEnd()}\n`;
    case "listItem":
      return `- ${children().trim()}\n`;
    case "tableRow":
      return `${(node.content ?? []).map((cell) => flattenAdf(cell).trim()).join(" | ")}\n`;
    case "mention":
    case "emoji":
    case "status":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "inlineCard":
      return String(node.attrs?.url ?? "");
    default:
      return children();
  }
}

/** Reduces a Jira REST issue (API v2 or v3) to the fields the analysis uses. */
export function normaliseIssue(issue: {
  key?: string;
  fields?: {
    summary?: string;
    description?: AdfNode | string | null;
    reporter?: { displayName?: string; accountId?: string } | null;
    updated?: string;
    comment?: {
      total?: number;
      comments?: {
        id?: string;
        author?: { displayName?: string; accountId?: string };
        created?: string;
        updated?: string;
        body?: AdfNode | string;
      }[];
    };
  };
  id?: string;
}): Ticket {
  if (!issue.key || !issue.fields) throw new Error("Not a Jira issue: key or fields missing.");
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    description: flattenAdf(issue.fields.description).trim(),
    id: issue.id,
    updated: issue.fields.updated,
    reporter: issue.fields.reporter
      ? { name: issue.fields.reporter.displayName ?? "unknown", accountId: issue.fields.reporter.accountId }
      : undefined,
    comments: (issue.fields.comment?.comments ?? []).map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? "unknown",
      authorId: c.author?.accountId,
      created: c.created ?? "",
      updated: c.updated,
      body: flattenAdf(c.body).trim(),
    })),
  };
}

/** A ticket together with how it was obtained, which decides how far it is trusted. */
export type LoadedTicket = { ticket: Ticket } & ({ via: "jira-api"; site: string } | { via: "file"; path: string });

/** Where tickets come from. Implementations must not follow redirects or read anything but the record asked for. */
export interface TicketProvider {
  readonly name: string;
  /** The ticket, or undefined if this provider has no such ticket. Throws if it cannot tell. */
  load(key: string): Promise<LoadedTicket | undefined>;
}

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** Ticket fixtures: one Jira REST JSON file per key in a directory. */
export function fileTicketProvider(dir: string): TicketProvider {
  return {
    name: "ticket files",
    async load(key) {
      if (!KEY.test(key)) return undefined;
      const file = `${dir.replace(/\/$/, "")}/${key}.json`;
      if (!existsSync(file)) return undefined;
      return { ticket: normaliseIssue(JSON.parse(await readFile(file, "utf8"))), via: "file", path: file };
    },
  };
}

export type JiraCredentials = { baseUrl: string; email: string; token: string };

/** Reads Jira credentials from the environment and removes the token from it, so no later child process inherits it. */
export function takeJiraCredentials(env: NodeJS.ProcessEnv): JiraCredentials | undefined {
  const { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: token } = env;
  delete env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) return undefined;
  return { baseUrl, email, token };
}

/**
 * Jira Cloud over its REST API (v3), authenticated with an API token. Reads
 * one issue: summary, description, reporter and every comment with its
 * author's account id. The token is sent only to the configured site, over
 * HTTPS, and redirects are not followed.
 */
export function jiraCloudProvider(credentials: JiraCredentials, fetchImpl: typeof fetch = fetch): TicketProvider {
  const site = new URL(credentials.baseUrl);
  if (site.protocol !== "https:") throw new Error("JIRA_BASE_URL must be an https address.");
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;
  // The base address may carry a path: a token limited to chosen scopes is
  // used through Atlassian's API gateway (…/ex/jira/<site id>), not the site.
  const prefix = site.pathname.replace(/\/+$/, "");
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const url = new URL(`${prefix}${path}`, site.origin);
    if (url.origin !== site.origin || !url.pathname.startsWith(`${prefix}/rest/api/3/issue/`)) {
      throw new Error("Jira request left the configured site.");
    }
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  };
  return {
    name: `Jira Cloud (${site.host}${prefix})`,
    async load(key) {
      if (!KEY.test(key)) return undefined;
      const issue = await get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,comment,reporter,updated`);
      if (issue.status === 404) return undefined;
      if (issue.status === 401 || issue.status === 403) throw new Error(`Jira refused the request for ${key} (HTTP ${issue.status}): check the account's access and the API token.`);
      if (issue.status !== 200) throw new Error(`Jira returned HTTP ${issue.status} for ${key}.`);
      const raw = issue.body as Parameters<typeof normaliseIssue>[0];
      // The issue carries only the first page of comments; read the rest.
      const comments = [...(raw.fields?.comment?.comments ?? [])];
      const total = raw.fields?.comment?.total ?? comments.length;
      while (comments.length < total && comments.length < 1000) {
        const page = await get(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${comments.length}&maxResults=100&orderBy=created`);
        if (page.status !== 200) throw new Error(`Jira returned HTTP ${page.status} for the comments of ${key}.`);
        const batch = (page.body as { comments?: typeof comments }).comments ?? [];
        if (batch.length === 0) break;
        comments.push(...batch);
      }
      const ticket = normaliseIssue({ ...raw, fields: { ...raw.fields, comment: { comments } } });
      return { ticket, via: "jira-api", site: `${site.host}${prefix}` };
    },
  };
}

/** Asks each provider in turn. A provider that cannot tell (network, credentials) stops the search: nothing is guessed. */
export async function loadFromProviders(key: string, providers: TicketProvider[]): Promise<LoadedTicket | undefined> {
  for (const provider of providers) {
    const found = await provider.load(key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Loads a ticket from a file holding Jira's REST JSON, or by key from the
 * Jira REST API (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).
 */
export async function loadTicketWithProvenance(source: string): Promise<LoadedTicket> {
  if (existsSync(source)) return { ticket: normaliseIssue(JSON.parse(await readFile(source, "utf8"))), via: "file", path: source };
  const credentials = takeJiraCredentials(process.env);
  if (!credentials) throw new Error(`"${source}" is not a file, and JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set.`);
  const found = await jiraCloudProvider(credentials).load(source);
  if (!found) throw new Error(`Jira has no issue ${source}, or the key is not well-formed.`);
  return found;
}

export async function loadTicket(source: string): Promise<Ticket> {
  return (await loadTicketWithProvenance(source)).ticket;
}
