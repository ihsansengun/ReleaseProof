/**
 * A remote run: a deployed application and the acceptance criteria approved
 * for it, with no pull request, ticket or repository.
 *
 * This file decides one thing: whether a request may run at all. It makes no
 * model call and opens no browser, and it must be passed before either
 * happens. What it lets through is trusted by everything after it, so it is
 * strict: a request that is wrong in any respect is refused whole, with every
 * reason given.
 *
 * The criteria arrive as snapshots. A snapshot is the exact text someone
 * approved, with the SHA-256 of that text and who is said to have approved it.
 *
 * What this gate establishes is INTEGRITY: the text is the text the hash was
 * taken of, unchanged. It does not establish AUTHORITY. The approver's name is
 * a claim made by whoever wrote the request; a matching hash says nothing
 * about whether that person may approve requirements for this target. A
 * snapshot becomes authoritative, and able to set expected values, only when
 * the approver has also been checked against the owners of the source, from a
 * list this request cannot influence. That check is separate and comes after
 * this one. Until it exists, nothing admitted here is authoritative.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/** The version of the request format this engine reads. A request must state it. */
export const REMOTE_REQUEST_VERSION = 1;

const Host = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/, "must be a lowercase host name, with an optional port")
  // A name, never an address: the last label of a name is not a number.
  .refine((host) => /[a-z]/.test(host.replace(/:[0-9]+$/, "").split(".").at(-1) ?? ""), "must be a host name, not an IP address");

export const CriteriaSnapshot = z.strictObject({
  /** Identifies the snapshot in the result. Unique within a request. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  /** The approved text, exactly as it was approved. */
  content: z.string().min(1).max(200_000),
  /** SHA-256 of `content` as UTF-8, in lowercase hexadecimal. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who approved it. Required: an unapproved text is not a requirement. */
  approvedBy: z.string().trim().min(1).max(200),
  approvedAt: z.iso.datetime({ offset: true }),
});
export type CriteriaSnapshot = z.infer<typeof CriteriaSnapshot>;

export const RemoteRunRequest = z.strictObject({
  requestVersion: z.literal(REMOTE_REQUEST_VERSION),
  /** The run this request is for. It is written into the result unchanged. */
  runId: z.uuid(),
  /** The workspace and project the run belongs to. Approval evidence is bound to both. */
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  target: z.strictObject({
    baseUrl: z.url({ protocol: /^https?$/ }),
    /** Hosts the run may navigate and write to. The target's own host must be among them. */
    allowedHosts: z.array(Host).min(1).max(20),
  }),
  criteria: z.array(CriteriaSnapshot).min(1).max(20),
  limits: z.strictObject({
    maxUsd: z.number().min(0).max(100),
    maxScenarios: z.number().int().min(1).max(50),
    maxMinutes: z.number().int().min(1).max(120),
  }),
});
export type RemoteRunRequest = z.infer<typeof RemoteRunRequest>;

/**
 * A snapshot whose text matches its hash. Its integrity is established; its
 * authority is not (see the note at the top of this file).
 */
export type IntactSnapshot = CriteriaSnapshot & {
  readonly integrity: "hash-matched";
  /** Always false here. Only the ownership check may say otherwise. */
  readonly approverVerified: false;
};

export type AdmittedRun = {
  request: RemoteRunRequest;
  snapshots: IntactSnapshot[];
};

/** Why a request was refused. Every reason is listed, not only the first. */
export class RemoteRequestRefused extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`The remote run request was refused:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`);
    this.name = "RemoteRequestRefused";
    this.reasons = reasons;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Decides whether a request may run. Returns the request with its intact
 * snapshots, or throws `RemoteRequestRefused`. Pure: no network, no model, no
 * clock beyond comparing the approval time with `now`.
 */
export function admitRemoteRun(raw: unknown, now: Date = new Date()): AdmittedRun {
  const parsed = RemoteRunRequest.safeParse(raw);
  if (!parsed.success) {
    throw new RemoteRequestRefused(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  const request = parsed.data;
  const reasons: string[] = [];

  const seen = new Set<string>();
  for (const snapshot of request.criteria) {
    if (seen.has(snapshot.id)) reasons.push(`criteria snapshot "${snapshot.id}" appears more than once`);
    seen.add(snapshot.id);

    // The hash is recomputed here, from the text. The one in the request is
    // only what the text is claimed to be.
    const actual = sha256Hex(snapshot.content);
    if (actual !== snapshot.sha256) {
      reasons.push(
        `criteria snapshot "${snapshot.id}" does not match its hash: the text has SHA-256 ${actual}, the request says ${snapshot.sha256}`,
      );
    }
    if (Date.parse(snapshot.approvedAt) > now.getTime() + 5 * 60_000) {
      reasons.push(`criteria snapshot "${snapshot.id}" claims an approval in the future (${snapshot.approvedAt})`);
    }
  }

  const base = new URL(request.target.baseUrl);
  if (base.username !== "" || base.password !== "") {
    reasons.push("target.baseUrl must not carry credentials");
  }
  const targetHost = base.host.toLowerCase();
  const allowed = new Set(request.target.allowedHosts);
  if (allowed.size !== request.target.allowedHosts.length) {
    reasons.push("target.allowedHosts lists a host more than once");
  }
  if (!allowed.has(targetHost) && !allowed.has(base.hostname.toLowerCase())) {
    reasons.push(`target.allowedHosts does not include the target's own host (${targetHost})`);
  }

  if (reasons.length > 0) throw new RemoteRequestRefused(reasons);
  return {
    request,
    snapshots: request.criteria.map((snapshot) => ({
      ...snapshot,
      integrity: "hash-matched" as const,
      approverVerified: false as const,
    })),
  };
}

/** Reads a request file and decides whether it may run. */
export async function loadRemoteRequest(file: string, now: Date = new Date()): Promise<AdmittedRun> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new RemoteRequestRefused([`${file} could not be read as JSON: ${(error as Error).message.split("\n")[0]}`]);
  }
  return admitRemoteRun(raw, now);
}
