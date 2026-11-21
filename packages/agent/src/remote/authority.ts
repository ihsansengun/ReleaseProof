/**
 * Authority: whether a criteria snapshot may set expected values.
 *
 * `request.ts` establishes that a snapshot's text is unchanged. That is not
 * authority: the request names its own approver. Authority comes from the
 * control plane, which knows who signed in, what they may do in the workspace
 * and project, and whether they approved this exact text. It states that in an
 * APPROVAL: a signed statement binding one snapshot hash to one workspace,
 * project, run and target.
 *
 * The engine holds only the control plane's PUBLIC keys, given to it by its
 * caller from outside the request. It cannot sign, so nothing that runs beside
 * an application under test can mint an approval. An approval may travel by
 * any route, including next to the request: it is believed because its
 * signature verifies against a key the request cannot influence, and for no
 * other reason.
 *
 * Nothing here calls a model or opens a browser, and all of it must pass
 * before either happens. A snapshot with no valid approval refuses the whole
 * run. Text from a ticket, a pull request or the application can never
 * approve itself: only a signature made with the control plane's key counts.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RemoteRequestRefused, type AdmittedRun, type IntactSnapshot } from "./request.ts";

/** Says how the signed statement is laid out. Part of what is signed. */
export const APPROVAL_VERSION = 1;
const DOMAIN = "releaseproof-criteria-approval-v1";

/** One line of the signed statement: no line breaks, so fields cannot run into each other. */
const Line = z.string().min(1).max(500).regex(/^[^\r\n]+$/, "must be a single line");

export const Approval = z.strictObject({
  approvalVersion: z.literal(APPROVAL_VERSION),
  /** Which of the control plane's keys signed this. */
  keyId: Line.max(100),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  /** The scheme and host the run is allowed to target, as an origin. */
  targetOrigin: z.url({ protocol: /^https?$/ }),
  snapshotId: Line.max(64),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who approved the text, as the control plane authenticated them. */
  approvedBy: Line.max(200),
  approvedAt: z.iso.datetime({ offset: true }),
  /** When the control plane signed, and until when the approval may be used. */
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  /** Ed25519 signature over `signedStatement`, base64url. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "must be an Ed25519 signature in base64url"),
});
export type Approval = z.infer<typeof Approval>;

/** The exact bytes that are signed: every bound field, one per line, in a fixed order. */
export function signedStatement(approval: Omit<Approval, "signature">): string {
  return [
    DOMAIN,
    String(approval.approvalVersion),
    approval.keyId,
    approval.workspaceId,
    approval.projectId,
    approval.runId,
    new URL(approval.targetOrigin).origin,
    approval.snapshotId,
    approval.snapshotSha256,
    approval.approvedBy,
    approval.approvedAt,
    approval.issuedAt,
    approval.expiresAt,
  ].join("\n");
}

/** The control plane's public keys, by key id. They come from the engine's caller, never from a request. */
export type TrustedKeys = ReadonlyMap<string, KeyObject>;

const TrustedKeysFile = z.strictObject({
  keys: z
    .array(z.strictObject({ keyId: Line.max(100), publicKeyPem: z.string().min(1) }))
    .min(1)
    .max(10),
});

/** Reads the file of trusted public keys. Only Ed25519 public keys are accepted. */
export async function loadTrustedKeys(file: string): Promise<TrustedKeys> {
  const parsed = TrustedKeysFile.parse(JSON.parse(await readFile(file, "utf8")));
  const keys = new Map<string, KeyObject>();
  for (const { keyId, publicKeyPem } of parsed.keys) {
    const key = createPublicKey(publicKeyPem);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error(`Trusted key "${keyId}" is not an Ed25519 public key.`);
    }
    if (keys.has(keyId)) throw new Error(`Trusted key "${keyId}" is listed more than once.`);
    keys.set(keyId, key);
  }
  return keys;
}

/** A snapshot the control plane approved for this run. Only these may set expected values. */
export type AuthoritativeSnapshot = Omit<IntactSnapshot, "approverVerified"> & {
  readonly approverVerified: true;
  readonly authority: {
    readonly keyId: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
};

export type AuthorisedRun = Omit<AdmittedRun, "snapshots"> & { snapshots: AuthoritativeSnapshot[] };

/**
 * Decides whether every snapshot of an admitted run carries a valid approval.
 * Returns the run with authoritative snapshots, or throws
 * `RemoteRequestRefused` with every reason. Pure apart from reading `now`.
 */
export function authoriseRemoteRun(
  admitted: AdmittedRun,
  evidence: unknown,
  trusted: TrustedKeys,
  now: Date = new Date(),
): AuthorisedRun {
  const reasons: string[] = [];
  if (trusted.size === 0) {
    throw new RemoteRequestRefused(["no trusted approval key was given, so no approval can be checked"]);
  }
  const list = z.array(z.unknown()).max(40).safeParse(evidence);
  if (!list.success) {
    throw new RemoteRequestRefused(["the approval evidence is missing or is not a list"]);
  }

  // Approvals that are well formed AND whose signature verifies. Nothing else is looked at.
  const genuine: Approval[] = [];
  list.data.forEach((entry, index) => {
    const parsed = Approval.safeParse(entry);
    if (!parsed.success) {
      reasons.push(`approval ${index + 1} is malformed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    const approval = parsed.data;
    const key = trusted.get(approval.keyId);
    if (!key) {
      reasons.push(`approval ${index + 1} names a key that is not trusted ("${approval.keyId}")`);
      return;
    }
    const { signature, ...statement } = approval;
    if (!verify(null, Buffer.from(signedStatement(statement), "utf8"), key, Buffer.from(signature, "base64url"))) {
      reasons.push(`approval ${index + 1} has a signature that does not verify`);
      return;
    }
    genuine.push(approval);
  });

  const { request } = admitted;
  const targetOrigin = new URL(request.target.baseUrl).origin;
  const snapshots: AuthoritativeSnapshot[] = [];

  for (const snapshot of admitted.snapshots) {
    const mine = genuine.filter((approval) => approval.snapshotId === snapshot.id);
    if (mine.length === 0) {
      reasons.push(`criteria snapshot "${snapshot.id}" has no valid approval`);
      continue;
    }
    // A genuine approval must be for exactly this run, target and text.
    const mismatches = (approval: Approval): string[] => {
      const found: string[] = [];
      if (approval.snapshotSha256 !== snapshot.sha256) found.push("it approves different text (another hash)");
      if (approval.runId !== request.runId) found.push("it is for another run");
      if (approval.workspaceId !== request.workspaceId) found.push("it is for another workspace");
      if (approval.projectId !== request.projectId) found.push("it is for another project");
      if (new URL(approval.targetOrigin).origin !== targetOrigin) found.push("it is for another target");
      if (approval.approvedBy !== snapshot.approvedBy) found.push("it names a different approver than the snapshot does");
      if (Date.parse(approval.approvedAt) !== Date.parse(snapshot.approvedAt)) found.push("it gives a different approval time than the snapshot does");
      if (Date.parse(approval.expiresAt) <= now.getTime()) found.push("it has expired");
      if (Date.parse(approval.issuedAt) > now.getTime() + 5 * 60_000) found.push("it is dated in the future");
      if (Date.parse(approval.expiresAt) - Date.parse(approval.issuedAt) > 24 * 3_600_000) found.push("it is valid for more than 24 hours");
      return found;
    };
    const fitting = mine.find((approval) => mismatches(approval).length === 0);
    if (!fitting) {
      reasons.push(`criteria snapshot "${snapshot.id}": no approval fits. The closest one is refused because ${mismatches(mine[0]).join(", and ")}`);
      continue;
    }
    snapshots.push({
      ...snapshot,
      approverVerified: true,
      authority: {
        keyId: fitting.keyId,
        approvedBy: fitting.approvedBy,
        approvedAt: fitting.approvedAt,
        issuedAt: fitting.issuedAt,
        expiresAt: fitting.expiresAt,
      },
    });
  }

  if (reasons.length > 0) throw new RemoteRequestRefused(reasons);
  return { request, snapshots };
}
