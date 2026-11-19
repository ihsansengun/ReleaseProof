import { readFile } from "node:fs/promises";
import type { PullRequestComment } from "../approval.ts";
import type { PullRequest } from "../schema.ts";

async function get(path: string): Promise<unknown> {
  const request = (token: string | undefined) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "releaseproof",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  let response = await request(process.env.GITHUB_TOKEN);
  // A workflow's token belongs to one repository. Where it is refused for a
  // public repository elsewhere, the same public data is read without it.
  if (process.env.GITHUB_TOKEN && [401, 403, 404].includes(response.status)) response = await request(undefined);
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${path}.`);
  return response.json();
}

/** Reads a pull request and its changed files through the GitHub REST API. */
export async function loadPullRequest(repo: string, number: number): Promise<PullRequest> {
  const pr = (await get(`/repos/${repo}/pulls/${number}`)) as {
    title: string;
    body: string | null;
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { ref: string; sha?: string };
    draft?: boolean;
  };
  const files: PullRequest["files"] = [];
  for (let page = 1; ; page++) {
    const batch = (await get(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)) as {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[];
    for (const f of batch) {
      files.push({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch });
    }
    if (batch.length < 100) break;
  }
  return {
    repo,
    number,
    title: pr.title,
    body: pr.body ?? "",
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRepo: pr.head.repo?.full_name,
    draft: pr.draft,
    files,
  };
}

async function pages<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) as T[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** The conversation comments on a pull request, as the code host records them (author id, timestamps). */
export async function loadPullRequestComments(repo: string, number: number): Promise<PullRequestComment[]> {
  return (await pages<PullRequestComment>(`/repos/${repo}/issues/${number}/comments`)).map((c) => ({
    id: c.id,
    body: c.body ?? "",
    created_at: c.created_at,
    updated_at: c.updated_at,
    user: c.user ? { id: c.user.id, login: c.user.login, type: c.user.type } : null,
  }));
}

/** The commits that make up a pull request as it stands. */
export async function loadPullRequestCommits(repo: string, number: number): Promise<string[]> {
  return (await pages<{ sha: string }>(`/repos/${repo}/pulls/${number}/commits`)).map((c) => c.sha);
}

/** Loads a pull request saved earlier as JSON, for running without network access. */
export async function loadPullRequestFile(file: string): Promise<PullRequest> {
  const pr = JSON.parse(await readFile(file, "utf8")) as PullRequest;
  if (!pr.headSha || !Array.isArray(pr.files)) throw new Error(`${file} is not a saved pull request.`);
  return pr;
}
