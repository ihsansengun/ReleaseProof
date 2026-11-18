import type { PullRequest } from "../schema.ts";

async function get(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "releaseproof",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${path}.`);
  return response.json();
}

/** Reads a pull request and its changed files through the GitHub REST API. */
export async function loadPullRequest(repo: string, number: number): Promise<PullRequest> {
  const pr = (await get(`/repos/${repo}/pulls/${number}`)) as {
    title: string;
    body: string | null;
    head: { sha: string; ref: string };
    base: { ref: string };
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
    files,
  };
}
