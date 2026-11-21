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
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RemoteRequestRefused, sha256Hex, type AdmittedRun, type IntactSnapshot, type RemoteRunRequest } from "./request.ts";

/** Says how the signed statement is laid out. Part of what is signed. */
export const APPROVAL_VERSION = 1;
const DOMAIN = "releaseproof-criteria-approval-v1";

/** One line of the signed statement: no line breaks, so fields cannot run into each other. */
const Line = z.string().min(1).max(500).regex(/^[^\r\n]+$/, "must be a single line");
/** A key id is printed in refusals, so it is kept to characters that are safe to print. */
const KeyId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "must be letters, digits, dot, underscore or hyphen");
const MAX_APPROVALS = 40;

/**
 * A digest of where the run may go and how much it may spend: the target
 * address, the hosts it may reach and its limits. An approval is bound to it,
 * so whoever writes a request cannot widen an approved run. The hosts are
 * sorted, so their sequence in the request does not matter.
 */
export function scopeSha256(request: Pick<RemoteRunRequest, "target" | "limits">): string {
  return sha256Hex(
    JSON.stringify([
      "releaseproof-run-scope-v1",
      new URL(request.target.baseUrl).href,
      [...request.target.allowedHosts].sort(),
      request.limits.maxUsd,
      request.limits.maxScenarios,
      request.limits.maxMinutes,
    ]),
  );
}

export const Approval = z.strictObject({
  approvalVersion: z.literal(APPROVAL_VERSION),
  /** Which of the control plane's keys signed this. */
  keyId: KeyId,
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  /** The scheme and host the run is allowed to target, as an origin. */
  targetOrigin: z.url({ protocol: /^https?$/ }),
  /** `scopeSha256` of the request this approval is for: its address, allowed hosts and limits. */
  scopeSha256: z.string().regex(/^[0-9a-f]{64}$/),
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

/** The exact bytes that are signed: every bound field, one per line, in a fixed sequence. */
export function signedStatement(approval: Omit<Approval, "signature">): string {
  return [
    DOMAIN,
    String(approval.approvalVersion),
    approval.keyId,
    approval.workspaceId,
    approval.projectId,
    approval.runId,
    new URL(approval.targetOrigin).origin,
    approval.scopeSha256,
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
    .array(z.strictObject({ keyId: KeyId, publicKeyPem: z.string().min(1) }))
    .min(1)
    .max(10),
});

/** Reads the file of trusted public keys. Only Ed25519 public keys are accepted. */
export async function loadTrustedKeys(file: string): Promise<TrustedKeys> {
  const parsed = TrustedKeysFile.parse(JSON.parse(await readFile(file, "utf8")));
  const keys = new Map<string, KeyObject>();
  for (const { keyId, publicKeyPem } of parsed.keys) {
    // A private key would be read as its public half. It has no place here: the engine never holds one.
    if (!publicKeyPem.trimStart().startsWith("-----BEGIN PUBLIC KEY-----")) {
      throw new Error(`Trusted key "${keyId}" is not a public key in PEM form.`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: publicKeyPem, format: "pem", type: "spki" });
    } catch {
      throw new Error(`Trusted key "${keyId}" could not be read as a public key.`);
    }
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
    /** The signature that was verified. It identifies this approval in the ledger of used ones. */
    readonly signature: string;
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
  const list = z.array(z.unknown()).safeParse(evidence);
  if (!list.success) {
    throw new RemoteRequestRefused(["the approval evidence is missing or is not a list"]);
  }
  if (list.data.length > MAX_APPROVALS) {
    throw new RemoteRequestRefused([`the approval evidence lists more than ${MAX_APPROVALS} approvals`]);
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
    // One spelling per signature: the spare bits of the last character must be zero.
    if (Buffer.from(signature, "base64url").toString("base64url") !== signature) {
      reasons.push(`approval ${index + 1} has a signature that is not in canonical base64url`);
      return;
    }
    if (!verify(null, Buffer.from(signedStatement(statement), "utf8"), key, Buffer.from(signature, "base64url"))) {
      reasons.push(`approval ${index + 1} has a signature that does not verify`);
      return;
    }
    genuine.push(approval);
  });

  const { request } = admitted;
  const targetOrigin = new URL(request.target.baseUrl).origin;
  const scope = scopeSha256(request);
  const snapshots: AuthoritativeSnapshot[] = [];

  for (const snapshot of admitted.snapshots) {
    // Recomputed here as well: this check does not rely on who built `admitted`.
    if (sha256Hex(snapshot.content) !== snapshot.sha256) {
      reasons.push(`criteria snapshot "${snapshot.id}" does not match its hash`);
      continue;
    }
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
      if (approval.scopeSha256 !== scope) found.push("it is for a different target address, set of allowed hosts or limits");
      if (approval.approvedBy !== snapshot.approvedBy) found.push("it names a different approver than the snapshot does");
      if (Date.parse(approval.approvedAt) !== Date.parse(snapshot.approvedAt)) found.push("it gives a different approval time than the snapshot does");
      const approvedAt = Date.parse(approval.approvedAt);
      const issuedAt = Date.parse(approval.issuedAt);
      const expiresAt = Date.parse(approval.expiresAt);
      if (![approvedAt, issuedAt, expiresAt].every(Number.isFinite)) {
        found.push("one of its times cannot be read");
        return found;
      }
      if (expiresAt <= now.getTime()) found.push("it has expired");
      if (issuedAt > now.getTime() + 5 * 60_000) found.push("it is dated in the future");
      if (expiresAt <= issuedAt) found.push("it expires before it was issued");
      if (approvedAt > issuedAt) found.push("it was issued before the approval it states");
      if (expiresAt - issuedAt > 24 * 3_600_000) found.push("it is valid for more than 24 hours");
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
        signature: fitting.signature,
      },
    });
  }

  if (reasons.length > 0) throw new RemoteRequestRefused(reasons);
  return { request, snapshots };
}

/**
 * What the engine's caller asked for, stated by the caller itself and never
 * read from the request. A genuine request and approval for some other run,
 * workspace or project is refused, however valid its signature.
 */
export interface ExpectedRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

/**
 * Remembers which approvals have been used. `claim` returns true the first
 * time it is given a key and false ever after. It must be kept outside
 * anything a request can write to.
 */
export interface ApprovalLedger {
  claim(key: string): boolean;
}

/** A ledger kept in memory, for one process. */
export function memoryLedger(): ApprovalLedger {
  const used = new Set<string>();
  return {
    claim(key) {
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}

/** A ledger kept as one file per used approval. Creating the file is the claim, so two claims cannot both succeed. */
export function directoryLedger(directory: string): ApprovalLedger {
  mkdirSync(directory, { recursive: true });
  return {
    claim(key) {
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("a ledger key is a SHA-256 in hexadecimal");
      try {
        writeFileSync(path.join(directory, key), "", { flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    },
  };
}

/** Whether the admitted run is the one the caller asked for. Returns the reasons it is not. */
export function unexpected(admitted: AdmittedRun, expected: ExpectedRun): string[] {
  const { request } = admitted;
  const reasons: string[] = [];
  if (request.runId !== expected.runId) reasons.push("the request is for a run this engine was not asked to do");
  if (request.workspaceId !== expected.workspaceId) reasons.push("the request is for another workspace than the caller named");
  if (request.projectId !== expected.projectId) reasons.push("the request is for another project than the caller named");
  return reasons;
}

/**
 * The check a run must pass before it may start: the only way to an
 * `AuthorisedRun` that is allowed to reach a model or a browser.
 *
 * On top of `authoriseRemoteRun` it requires that the run is the one the
 * caller asked for, and that none of its approvals was used before. An
 * approval is claimed only once everything else has passed, so a refused
 * attempt uses nothing up. Presenting the same request and approvals a second
 * time is refused.
 */
export function authoriseForExecution(
  admitted: AdmittedRun,
  evidence: unknown,
  trusted: TrustedKeys,
  caller: { readonly expected: ExpectedRun; readonly ledger: ApprovalLedger; readonly now?: Date },
): AuthorisedRun {
  const mismatch = unexpected(admitted, caller.expected);
  if (mismatch.length > 0) throw new RemoteRequestRefused(mismatch);
  const authorised = authoriseRemoteRun(admitted, evidence, trusted, caller.now ?? new Date());
  const replayed = authorised.snapshots
    // Every snapshot is claimed, so a second attempt is refused whichever one it reuses.
    .map((snapshot) => ({ snapshot, fresh: caller.ledger.claim(sha256Hex(`releaseproof-approval-use-v1\n${snapshot.authority.signature}`)) }))
    .filter(({ fresh }) => !fresh)
    .map(({ snapshot }) => `the approval for criteria snapshot "${snapshot.id}" has already been used for a run`);
  if (replayed.length > 0) throw new RemoteRequestRefused(replayed);
  return authorised;
}
