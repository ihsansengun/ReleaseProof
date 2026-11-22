/**
 * Approved checks ("bindings") and the signed statement that approves a set of
 * them for one run. Design: docs/design/TRUSTED-BINDING.md.
 *
 * NOT USED BY ANY RUN. Nothing here is called when a run starts, is carried
 * out or is reported, and no verdict depends on it. A remote run reports
 * `verdictsTrusted: false` exactly as before.
 *
 * What this file establishes, for a run whose criteria approvals have already
 * verified (`authority.ts`), is AUTHORITY over a set of bindings: that the
 * control plane signed, for this run and this revision of the criteria,
 * exactly this set. It does not yet establish that a binding is a good one,
 * or even a well-meant one: the rules about what a binding may contain that
 * need the criteria text (where its quote lies, that the expected value is
 * the number written there) and the rules about how a check is carried out
 * belong to the stage that carries checks out. What is returned here is
 * therefore called a signed set, never a verified check.
 *
 * The statement is a second kind of signed statement beside the criteria
 * approval. It has its own first line, its own version and its own list. The
 * criteria approval, the request format and their checks are not changed.
 */
import { verify } from "node:crypto";
import { z } from "zod";
import { Unit } from "../units.ts";
import { scopeSha256, type AuthorisedRun, type TrustedKeys } from "./authority.ts";
import { RemoteRequestRefused, sha256Hex } from "./request.ts";

/** How the signed statement is laid out. Its own number: not the criteria approval's. */
export const BINDING_APPROVAL_VERSION = 1;
/** How a binding is laid out. Part of what is signed. */
export const BINDING_FORMAT_VERSION = 1;
/** The first line of what is signed. A criteria approval begins with another line, so neither can verify as the other. */
const STATEMENT_DOMAIN = "releaseproof-binding-approval-v1";
/** The first member of what is hashed for a set. */
const SET_DOMAIN = "releaseproof-bindings-v1";

const MAX_STATEMENTS = 40;
const MAX_BINDINGS = 200;
const MAX_STEPS = 60;

// ---- the shape of a binding ----------------------------------------------------

/** One line, with nothing a signature or a hash could be made to read two ways. */
/**
 * Text that reads as what it is: well-formed Unicode, with no control character, no line or paragraph separator,
 * and none of the characters that are not seen or that change the direction text is read in. Such characters would
 * let one text pass for another on the screen where a person approves it.
 */
/** Half of a pair with no other half. It has no spelling of its own in bytes: written out, it becomes another character. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const plain = (text: string) => !LONE_SURROGATE.test(text) && !/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(text);
const Line = z.string().min(1).max(500).refine(plain, "must be one line of well-formed text without control or unseen characters");
const Name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/, "must be a plain name of at most 64 letters, digits, hyphens or underscores");
const KeyId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "must be letters, digits, dot, underscore or hyphen");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A static path of the target: exact, with no query, no fragment and no pattern. */
const StaticPath = z
  .string()
  .max(500)
  .regex(/^\/[^\s?#\\%]*$/, "must be a path that begins with a slash and has no query, fragment, space, backslash or percent sign")
  .refine(plain, "must be well-formed text without control or unseen characters")
  // Read by a browser against the target's address, "//host" would be another host, and "." and ".." are not where they say.
  .refine((path) => !path.includes("//") && !path.split("/").some((part) => part === "." || part === ".."), "must not hold an empty segment, or a segment that is one or two dots");
/** A number in plain decimal form. It is hashed as written: "1" and "1.0" are two texts, and two hashes. */
const Decimal = z.string().max(40).regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "must be a number in plain decimal form");
const Offset = z.number().int().min(0).max(200_000);
const Span = z.strictObject({ start: Offset, end: Offset }).refine((span) => span.end > span.start, "must end after it starts");
const WriteMethod = z.enum(["POST", "PUT", "PATCH", "DELETE"]);
const AnyMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const Locator = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("testid"), value: Line.max(200) }),
  z.strictObject({ by: z.literal("role"), role: Name, name: Line.max(200) }),
]);

const Reading = z.strictObject({
  path: StaticPath,
  locator: Locator,
  valueKind: z.enum(["number", "amount"]),
  unit: Unit,
});

/** A value that must be shown before the check goes on: from the quote by position, or a literal marked as not from it. */
const SeenValue = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("quote"), start: Offset, end: Offset, value: Decimal }),
  z.strictObject({ from: z.literal("literal"), value: Decimal }),
]);

const Step = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open"), path: StaticPath }),
  z.strictObject({
    kind: z.literal("fill"),
    path: StaticPath,
    locator: Locator,
    value: z.discriminatedUnion("from", [
      z.strictObject({ from: z.literal("literal"), text: Line.max(500) }),
      z.strictObject({ from: z.literal("fixture"), field: Name }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("act"),
    path: StaticPath,
    locator: Locator,
    expects: z.discriminatedUnion("write", [
      z.strictObject({ write: z.literal("one"), method: WriteMethod, path: StaticPath }),
      z.strictObject({ write: z.literal("none") }),
    ]),
  }),
  z.strictObject({ kind: z.literal("see"), reading: Reading, expected: SeenValue }),
]);

const Setup = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fresh-browser") }),
  // The body is sent as written, with the engine's key put where the placeholder stands.
  z.strictObject({ kind: z.literal("fixture"), method: WriteMethod, path: StaticPath, body: z.string().min(1).max(4_000) }),
]);

/** Where, in a fixture's body, the engine puts a key of its own for the run. */
export const FIXTURE_KEY_PLACEHOLDER = "{{key}}";

export const Binding = z.strictObject({
  formatVersion: z.literal(BINDING_FORMAT_VERSION),
  id: Name,
  snapshotId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  snapshotSha256: Sha256,
  /** The approved text this check is for, by position in the snapshot's text, in UTF-16 code units. */
  quote: Span,
  locale: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, "must be a language tag"),
  timezone: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, "must be a time zone name"),
  /** Requests the application sends by itself, which are not counted as writes. */
  background: z.array(z.strictObject({ method: AnyMethod, path: StaticPath })).max(20),
  /** Answers of 400 or above that the approver accepts as normal for this application. */
  tolerated: z.array(z.strictObject({ method: AnyMethod, path: StaticPath, status: z.number().int().min(400).max(599) })).max(20),
  /** How long the application may take to show a write, and how many final readings are made. */
  settling: z.strictObject({ within: z.number().int().min(1).max(120), readings: z.number().int().min(3).max(10) }),
  setup: Setup,
  steps: z.array(Step).min(1).max(MAX_STEPS),
  observation: Reading,
  /** The value compared with the observation: always from the quote, by position within it. */
  expected: z.strictObject({ start: Offset, end: Offset, value: Decimal }),
});
export type Binding = z.infer<typeof Binding>;

/**
 * What is wrong with a binding beyond its shape, as far as that can be told
 * without the criteria text and without a browser. A binding with any of these
 * is refused, never repaired.
 */
export function bindingProblems(binding: Binding): string[] {
  const problems: string[] = [];
  // Text is taken as written. A text in another Unicode form than NFC could be made to look like one that is approved.
  const texts: string[] = [];
  JSON.stringify(binding, (_key, value: unknown) => {
    if (typeof value === "string") texts.push(value);
    return value;
  });
  if (texts.some((text) => LONE_SURROGATE.test(text))) problems.push("it holds text that is not well-formed Unicode");
  else if (texts.some((text) => text !== text.normalize("NFC"))) problems.push("it holds text that is not in Unicode NFC");
  // Condition binding is mandatory: besides the final observation, something must be seen on the way.
  if (!binding.steps.some((step) => step.kind === "see")) problems.push("it has no condition: no step sees a value before the final observation");
  if (binding.setup.kind === "fixture" && !binding.setup.body.includes(FIXTURE_KEY_PLACEHOLDER)) {
    problems.push(`its fixture body has no ${FIXTURE_KEY_PLACEHOLDER}, so two runs would share what the fixture makes`);
  }
  const same = (a: { method: string; path: string }, b: { method: string; path: string }) => a.method === b.method && a.path === b.path;
  for (const step of binding.steps) {
    if (step.kind === "act" && step.expects.write === "one" && binding.background.some((entry) => same(entry, step.expects as { method: string; path: string }))) {
      problems.push("a step expects a write that is also listed as background");
    }
    if (step.kind === "fill" && step.value.from === "fixture" && binding.setup.kind !== "fixture") {
      problems.push("a step fills in a value from a fixture, and the check has no fixture");
    }
    if (step.kind === "see" && step.expected.from === "quote" && step.expected.end <= step.expected.start) {
      problems.push("a condition's expected value has a position that ends before it starts");
    }
  }
  if (binding.expected.end <= binding.expected.start) problems.push("its expected value has a position that ends before it starts");
  const length = binding.quote.end - binding.quote.start;
  if (length > 600) problems.push("its quote is longer than 600 code units");
  const within = (span: { start: number; end: number }) => span.end <= length;
  if (!within(binding.expected)) problems.push("its expected value lies outside its quote");
  if (binding.steps.some((step) => step.kind === "see" && step.expected.from === "quote" && !within(step.expected))) problems.push("a condition's expected value lies outside the quote");
  return problems;
}

// ---- the hash of a set ---------------------------------------------------------

type Encoded = string | number | Encoded[];

const locatorOf = (locator: z.infer<typeof Locator>): Encoded => (locator.by === "testid" ? ["testid", locator.value] : ["role", locator.role, locator.name]);
const readingOf = (reading: z.infer<typeof Reading>): Encoded => [reading.path, locatorOf(reading.locator), reading.valueKind, reading.unit];

/**
 * A binding as it is hashed: nested lists in one fixed sequence, with a tag for
 * each kind of setup and step. Every field of a binding is in it, and nothing
 * else. Positions and counts are whole numbers; every other number is text.
 * The sequence is part of the format: changing it changes
 * `BINDING_FORMAT_VERSION`.
 */
function encoded(binding: Binding): Encoded {
  return [
    binding.formatVersion,
    binding.id,
    binding.snapshotId,
    binding.snapshotSha256,
    [binding.quote.start, binding.quote.end],
    binding.locale,
    binding.timezone,
    binding.background.map((entry) => [entry.method, entry.path]),
    binding.tolerated.map((entry) => [entry.method, entry.path, entry.status]),
    [binding.settling.within, binding.settling.readings],
    binding.setup.kind === "fixture" ? ["fixture", binding.setup.method, binding.setup.path, binding.setup.body] : ["fresh-browser"],
    binding.steps.map((step): Encoded => {
      switch (step.kind) {
        case "open":
          return ["open", step.path];
        case "fill":
          return ["fill", step.path, locatorOf(step.locator), step.value.from === "literal" ? ["literal", step.value.text] : ["fixture", step.value.field]];
        case "act":
          return ["act", step.path, locatorOf(step.locator), step.expects.write === "one" ? ["one", step.expects.method, step.expects.path] : ["none"]];
        case "see":
          return ["see", readingOf(step.reading), step.expected.from === "quote" ? ["quote", step.expected.start, step.expected.end, step.expected.value] : ["literal", step.expected.value]];
      }
    }),
    readingOf(binding.observation),
    [binding.expected.start, binding.expected.end, binding.expected.value],
  ];
}

/** Code-unit comparison: the same on every machine, whatever its language settings. */
const byCodeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The hash of one binding, by which a result can say which exact binding something rested on. */
export function bindingSha256(binding: Binding): string {
  return sha256Hex(JSON.stringify(["releaseproof-binding-v1", encoded(binding)]));
}

/**
 * The hash of a set of bindings: what a statement signs. The bindings are
 * sorted by id, so the sequence they arrive in does not matter. Ids must be
 * unique, or the set is not one set: that is checked by the caller and here.
 */
export function bindingsSha256(bindings: readonly Binding[]): string {
  const sorted = [...bindings].sort((x, y) => byCodeUnit(x.id, y.id));
  if (sorted.some((binding, index) => index > 0 && sorted[index - 1]!.id === binding.id)) throw new Error("two bindings of one set have the same id");
  return sha256Hex(JSON.stringify([SET_DOMAIN, sorted.map(encoded)]));
}

// ---- the signed statement ------------------------------------------------------

const SignedLine = z.string().min(1).max(500).refine(plain, "must be one line of well-formed text without control or unseen characters");

export const BindingApproval = z.strictObject({
  bindingApprovalVersion: z.literal(BINDING_APPROVAL_VERSION),
  keyId: KeyId,
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  targetOrigin: z.url({ protocol: /^https?$/ }).refine((value) => new URL(value).origin === value, "must be an origin: scheme and host, nothing else"),
  /** `scopeSha256` of the request, as in a criteria approval. */
  scopeSha256: Sha256,
  snapshotId: SignedLine.max(64),
  snapshotSha256: Sha256,
  bindingFormatVersion: z.literal(BINDING_FORMAT_VERSION),
  /** How many bindings the set holds. */
  bindingCount: z.number().int().min(1).max(MAX_BINDINGS),
  /** `bindingsSha256` of the set. */
  bindingsSha256: Sha256,
  approvedBy: SignedLine.max(200),
  approvedAt: z.iso.datetime({ offset: true }),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "must be an Ed25519 signature in base64url"),
});
export type BindingApproval = z.infer<typeof BindingApproval>;

/**
 * The exact bytes that are signed: every bound field, one per line, in a fixed
 * sequence. No field is empty and none holds a line break (the shape above
 * sees to both), and every text is well-formed Unicode, so that it has one
 * spelling in bytes. No field can run into the next, and two different
 * statements cannot give the same bytes.
 */
export function signedBindingStatement(approval: Omit<BindingApproval, "signature">): string {
  return [
    STATEMENT_DOMAIN,
    String(approval.bindingApprovalVersion),
    approval.keyId,
    approval.workspaceId,
    approval.projectId,
    approval.runId,
    new URL(approval.targetOrigin).origin,
    approval.scopeSha256,
    approval.snapshotId,
    approval.snapshotSha256,
    String(approval.bindingFormatVersion),
    String(approval.bindingCount),
    approval.bindingsSha256,
    approval.approvedBy,
    approval.approvedAt,
    approval.issuedAt,
    approval.expiresAt,
  ].join("\n");
}

/** What a run is handed beside its criteria approvals, in a list of its own. */
export const BindingEvidence = z.strictObject({
  statements: z.array(z.unknown()).max(MAX_STATEMENTS),
  bindings: z.array(z.unknown()).max(MAX_BINDINGS),
});

/**
 * A set of bindings the control plane signed for this run and this revision of
 * one criteria snapshot. Signed, and in scope: not yet checked against the
 * criteria text, and not carried out.
 */
export type SignedBindingSet = {
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly bindingsSha256: string;
  /** Sorted by id. */
  readonly bindings: readonly Binding[];
  readonly authority: {
    readonly keyId: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
};

/**
 * Decides whether the binding statements a run was handed are genuine and are
 * for exactly this run and the bindings beside them.
 *
 * `evidence` undefined means the run was handed none: it returns no set, and
 * the run is what it is today. Evidence that is present and wrong in any
 * respect is a refusal of the whole, with every reason given. Unlike a
 * criteria approval, a statement that does not fit is never passed over in
 * favour of one that does: nothing is to be found in a list that should not
 * be there.
 *
 * `authorised` must come from `authoriseRemoteRun`: a binding is only ever
 * for a snapshot whose own approval has verified. Pure apart from reading `now`.
 */
export function authoriseBindings(authorised: AuthorisedRun, evidence: unknown, trusted: TrustedKeys, now: Date = new Date()): SignedBindingSet[] {
  if (evidence === undefined) return [];
  // A time that cannot be read would make every comparison with it false, and nothing would ever have expired.
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RemoteRequestRefused(["the time now cannot be read, so no binding approval can be checked"]);
  if (trusted.size === 0) throw new RemoteRequestRefused(["no trusted approval key was given, so no binding approval can be checked"]);
  for (const [keyId, key] of trusted) {
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new RemoteRequestRefused([`trusted key "${keyId.replace(/[^A-Za-z0-9._-]/g, "?")}" is not an Ed25519 public key, so no binding approval can be checked`]);
    }
  }
  const lists = BindingEvidence.safeParse(evidence);
  if (!lists.success) throw new RemoteRequestRefused(["the binding evidence is not a list of statements and a list of bindings, within their limits"]);
  if (lists.data.statements.length === 0) throw new RemoteRequestRefused(["the binding evidence holds no statement"]);

  const reasons: string[] = [];
  const { request } = authorised;
  const targetOrigin = new URL(request.target.baseUrl).origin;
  const scope = scopeSha256(request);

  // Statements: each well formed, genuinely signed, and for this run. One a snapshot.
  const statements = new Map<string, BindingApproval>();
  lists.data.statements.forEach((entry, index) => {
    const label = `binding statement ${index + 1}`;
    const parsed = BindingApproval.safeParse(entry);
    if (!parsed.success) {
      reasons.push(`${label} is malformed: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    const approval = parsed.data;
    const key = trusted.get(approval.keyId);
    if (!key) {
      reasons.push(`${label} names a key that is not trusted ("${approval.keyId}")`);
      return;
    }
    const { signature, ...statement } = approval;
    if (Buffer.from(signature, "base64url").toString("base64url") !== signature) {
      reasons.push(`${label} has a signature that is not in canonical base64url`);
      return;
    }
    if (!verify(null, Buffer.from(signedBindingStatement(statement), "utf8"), key, Buffer.from(signature, "base64url"))) {
      reasons.push(`${label} has a signature that does not verify`);
      return;
    }
    const found: string[] = [];
    if (approval.runId !== request.runId) found.push("it is for another run");
    if (approval.workspaceId !== request.workspaceId) found.push("it is for another workspace");
    if (approval.projectId !== request.projectId) found.push("it is for another project");
    if (new URL(approval.targetOrigin).origin !== targetOrigin) found.push("it is for another target");
    if (approval.scopeSha256 !== scope) found.push("it is for a different target address, set of allowed hosts, limits or set of criteria");
    const snapshot = authorised.snapshots.find((candidate) => candidate.id === approval.snapshotId);
    // The request's own criteria are what the scope hash covers. A snapshot beside them is not part of the run.
    const carried = request.criteria.filter((candidate) => candidate.id === approval.snapshotId);
    if (!snapshot || carried.length !== 1 || carried[0]!.sha256 !== snapshot.sha256) found.push("it is for a criteria snapshot this run does not carry");
    // Recomputed: this does not rely on who built `authorised`.
    else if (sha256Hex(snapshot.content) !== snapshot.sha256 || snapshot.sha256 !== approval.snapshotSha256) found.push("it is for another revision of the criteria text");
    else if (snapshot.approverVerified !== true) found.push("the snapshot it is for has no verified approval of its own");
    const approvedAt = Date.parse(approval.approvedAt);
    const issuedAt = Date.parse(approval.issuedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    if (![approvedAt, issuedAt, expiresAt].every(Number.isFinite)) found.push("one of its times cannot be read");
    else {
      if (expiresAt <= now.getTime()) found.push("it has expired");
      if (issuedAt > now.getTime() + 5 * 60_000) found.push("it is dated in the future");
      if (expiresAt <= issuedAt) found.push("it expires before it was issued");
      if (approvedAt > issuedAt) found.push("it was issued before the approval it states");
      if (expiresAt - issuedAt > 24 * 3_600_000) found.push("it is valid for more than 24 hours");
    }
    if (statements.has(approval.snapshotId)) found.push("there is more than one statement for its snapshot");
    if (found.length > 0) {
      reasons.push(`${label} is refused because ${found.join(", and ")}`);
      return;
    }
    statements.set(approval.snapshotId, approval);
  });

  // Bindings: each well formed, and each for a snapshot that has a statement.
  const bindings: Binding[] = [];
  lists.data.bindings.forEach((entry, index) => {
    const label = `binding ${index + 1}`;
    const parsed = Binding.safeParse(entry);
    if (!parsed.success) {
      reasons.push(`${label} is malformed: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    const problems = bindingProblems(parsed.data);
    if (problems.length > 0) {
      reasons.push(`${label} is refused because ${problems.join(", and ")}`);
      return;
    }
    bindings.push(parsed.data);
  });
  // One name, one binding, across every set of the run: a result names a binding by it.
  const ids = bindings.map((binding) => binding.id);
  if (new Set(ids).size !== ids.length) reasons.push("two bindings have the same id");

  // Nothing is compared with a statement unless every statement and every binding stood.
  if (reasons.length > 0) throw new RemoteRequestRefused(reasons);

  const sets: SignedBindingSet[] = [];
  for (const binding of bindings) {
    const statement = statements.get(binding.snapshotId);
    if (!statement) reasons.push(`binding "${binding.id}" is for a snapshot that no statement covers`);
    else if (binding.snapshotSha256 !== statement.snapshotSha256) reasons.push(`binding "${binding.id}" is for another revision of the criteria text than its statement`);
  }
  for (const [snapshotId, statement] of statements) {
    const mine = bindings.filter((binding) => binding.snapshotId === snapshotId).sort((x, y) => byCodeUnit(x.id, y.id));
    if (mine.length !== statement.bindingCount) {
      reasons.push(`the statement for "${snapshotId}" covers ${statement.bindingCount} ${statement.bindingCount === 1 ? "binding" : "bindings"}, and ${mine.length} ${mine.length === 1 ? "was" : "were"} presented`);
      continue;
    }
    if (reasons.length > 0) continue;
    if (bindingsSha256(mine) !== statement.bindingsSha256) {
      reasons.push(`the bindings presented for "${snapshotId}" are not the set its statement covers`);
      continue;
    }
    sets.push({
      snapshotId,
      snapshotSha256: statement.snapshotSha256,
      bindingsSha256: statement.bindingsSha256,
      bindings: mine,
      authority: { keyId: statement.keyId, approvedBy: statement.approvedBy, approvedAt: statement.approvedAt, issuedAt: statement.issuedAt, expiresAt: statement.expiresAt },
    });
  }
  if (reasons.length > 0) throw new RemoteRequestRefused(reasons);
  return sets.sort((x, y) => byCodeUnit(x.snapshotId, y.snapshotId));
}
