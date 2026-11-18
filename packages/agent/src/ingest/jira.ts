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
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: AdfNode | string }[] };
  };
}): Ticket {
  if (!issue.key || !issue.fields) throw new Error("Not a Jira issue: key or fields missing.");
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    description: flattenAdf(issue.fields.description).trim(),
    comments: (issue.fields.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? "unknown",
      created: c.created ?? "",
      body: flattenAdf(c.body).trim(),
    })),
  };
}

/**
 * Loads a ticket from a file holding Jira's REST JSON, or by key from the
 * Jira REST API (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).
 */
export async function loadTicket(source: string): Promise<Ticket> {
  if (existsSync(source)) return normaliseIssue(JSON.parse(await readFile(source, "utf8")));

  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(`"${source}" is not a file, and JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set.`);
  }
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(source)}?fields=summary,description,comment`, JIRA_BASE_URL);
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
    },
  });
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status} for ${source}.`);
  return normaliseIssue((await response.json()) as Parameters<typeof normaliseIssue>[0]);
}
