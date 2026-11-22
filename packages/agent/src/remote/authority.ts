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
import { statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RemoteRequestRefused, sha256Hex, type AdmittedRun, type IntactSnapshot, type RemoteRunRequest } from "./request.ts";

/** Says how the signed statement is laid out. Part of what is signed. */
export const APPROVAL_VERSION = 1;
const DOMAIN = "releaseproof-criteria-approval-v1";

/** One line of the signed statement: no line breaks, so fields cannot run into each other. */
/**
 * Half of a surrogate pair with no other half. It has no spelling of its own in bytes: written out as UTF-8 it
 * becomes U+FFFD, so two different texts would be signed as the same bytes.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const Line = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/, "must be a single line")
  .refine((text) => !LONE_SURROGATE.test(text), "must be well-formed Unicode");
/** A key id is printed in refusals, so it is kept to characters that are safe to print. */
const KeyId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "must be letters, digits, dot, underscore or hyphen");
const MAX_APPROVALS = 40;

/**
 * A digest of what the run is: its target address, the hosts it may reach, its
 * limits, and the exact set of criteria snapshots it carries. An approval is
 * bound to it, so whoever writes a request cannot widen an approved run, and
 * cannot leave out or add criteria either. Hosts and snapshots are sorted, so
 * their sequence in the request does not matter.
 */
export function scopeSha256(request: Pick<RemoteRunRequest, "target" | "limits" | "criteria">): string {
  return sha256Hex(
    JSON.stringify([
      "releaseproof-run-scope-v2",
      new URL(request.target.baseUrl).href,
      [...request.target.allowedHosts].sort(),
      request.limits.maxUsd,
      request.limits.maxScenarios,
      request.limits.maxMinutes,
      request.criteria.map((snapshot) => [snapshot.id, snapshot.sha256]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
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
  /** The scheme and host the run is allowed to target, as an origin and in exactly that spelling. */
  targetOrigin: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value, "must be an origin: scheme and host, nothing else"),
  /** `scopeSha256` of the request this approval is for: its address, allowed hosts, limits and set of criteria. */
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
  // A time that cannot be read would make every comparison with it false, and nothing would ever have expired.
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RemoteRequestRefused(["the time now cannot be read, so no approval can be checked"]);
  }
  if (trusted.size === 0) {
    throw new RemoteRequestRefused(["no trusted approval key was given, so no approval can be checked"]);
  }
  for (const [keyId, key] of trusted) {
    // Checked here as well as where keys are loaded: a caller may build the map itself.
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new RemoteRequestRefused([`trusted key "${keyId.replace(/[^A-Za-z0-9._-]/g, "?")}" is not an Ed25519 public key, so no approval can be checked`]);
    }
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
  // What is authorised below must be exactly what the request carries and the
  // scope digest covers: every snapshot, once, and at least one. This holds
  // for anything `admitRemoteRun` returns; it is checked for any other caller.
  const carried = request.criteria.map((snapshot) => `${snapshot.id}\n${snapshot.sha256}`);
  const admittedOnes = admitted.snapshots.map((snapshot) => `${snapshot.id}\n${snapshot.sha256}`);
  if (request.criteria.some((snapshot) => sha256Hex(snapshot.content) !== snapshot.sha256)) {
    throw new RemoteRequestRefused(["a criteria snapshot in the request does not match its hash"]);
  }
  if (
    carried.length === 0 ||
    new Set(request.criteria.map((snapshot) => snapshot.id)).size !== carried.length ||
    admittedOnes.length !== carried.length ||
    admittedOnes.some((entry, index) => entry !== carried[index])
  ) {
    throw new RemoteRequestRefused(["the admitted snapshots are not exactly the criteria the request carries"]);
  }
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
      if (approval.scopeSha256 !== scope) found.push("it is for a different target address, set of allowed hosts, limits or set of criteria");
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
 * Remembers which runs have started. `claim` returns true the first time it
 * is given a key and false ever after. It must be kept outside
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

/**
 * A ledger kept as one file per claim. Creating the file is the claim, so two
 * claims cannot both succeed. The directory must already exist: a mistyped or
 * wiped path is an error, never a fresh, empty ledger.
 */
export function directoryLedger(directory: string): ApprovalLedger {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("the ledger directory does not exist. It is created once, by whoever operates the engine, and never by a run.");
  }
  return {
    claim(key) {
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("a ledger key is a SHA-256 in hexadecimal");
      try {
        writeFileSync(path.join(directory, key), "", { flag: "wx", mode: 0o600, flush: true });
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

declare const startable: unique symbol;

/**
 * A run that may start. Only `authoriseForExecution` produces one. The type
 * stops code from passing a merely checked run by mistake, but a type can be
 * cast, so whatever starts a run must also call `isStartable`: that asks
 * whether this very object came out of `authoriseForExecution`, and no cast
 * or copy can make it say yes.
 */
export type StartableRun = AuthorisedRun & { readonly [startable]: true };

const started = new WeakSet<object>();

/** Whether this exact object was returned by `authoriseForExecution` in this process. */
export function isStartable(run: unknown): run is StartableRun {
  return typeof run === "object" && run !== null && started.has(run);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  // Only plain objects and arrays: freezing does not reach inside a Map, a Set or a Date.
  const kind = Object.getPrototypeOf(value) as unknown;
  if (kind !== Object.prototype && kind !== Array.prototype) {
    throw new RemoteRequestRefused(["the request holds a value that is not plain data"]);
  }
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

/** The ledger key of a run. One run starts once, whatever approvals it is presented with. */
export function runStartKey(run: ExpectedRun): string {
  const ids = [run.workspaceId, run.projectId, run.runId];
  // Ids are compared as lowercase hexadecimal, so one run has one key however it is spelled.
  if (!ids.every((id) => /^[0-9a-fA-F-]{36}$/.test(id))) throw new Error("a run is named by three ids");
  return sha256Hex(["releaseproof-run-start-v1", ...ids.map((id) => id.toLowerCase())].join("\n"));
}

/**
 * The check a run must pass before it may start, and the only way to a
 * `StartableRun`. `authoriseRemoteRun` alone is a check: it says whether the
 * approvals are valid, and what it returns cannot start anything.
 *
 * On top of that check it requires that the run is the one the caller asked
 * for, and that this run has not started before. The run is claimed in the
 * ledger with one claim, made only after everything else has passed: a refused
 * attempt claims nothing, and a second start of the same run is refused
 * whatever request and approvals it brings, including re-issued ones.
 */
export function authoriseForExecution(
  admitted: AdmittedRun,
  evidence: unknown,
  trusted: TrustedKeys,
  caller: { readonly expected: ExpectedRun; readonly ledger: ApprovalLedger; readonly now?: Date },
): StartableRun {
  // The run is checked and returned as a copy of its own, so that nothing the
  // caller still holds can change it afterwards.
  const own = structuredClone(admitted);
  const mismatch = unexpected(own, caller.expected);
  if (mismatch.length > 0) throw new RemoteRequestRefused(mismatch);
  const authorised = authoriseRemoteRun(own, evidence, trusted, caller.now ?? new Date());
  // Frozen all the way down: what was authorised is what runs. Before the
  // claim, so that a request that cannot be frozen uses nothing up.
  deepFreeze(authorised);
  // The key comes from the checked copy, which was just found to name the expected run.
  const { runId, workspaceId, projectId } = own.request;
  if (!caller.ledger.claim(runStartKey({ runId, workspaceId, projectId }))) {
    throw new RemoteRequestRefused(["this run has already been started once, and a run starts once"]);
  }
  started.add(authorised);
  return authorised as StartableRun;
}
