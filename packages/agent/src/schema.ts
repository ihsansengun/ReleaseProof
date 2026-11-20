import type { ApprovalDecision } from "./approval.ts";
import type { Authority, DocChange, SourceRecord, Supersession, Trust } from "./sources.ts";
import { z } from "zod";
import { ASPECTS, type Aspect } from "./select.ts";
import { Unit } from "./units.ts";
import type { UsageSummary } from "./budget.ts";

// ---- scenarios and assertions (what the engine executes) --------------------

/** What an assertion compares against. Fixed before any browser opens. */
export const Expected = z.union([
  z.object({ literal: z.union([z.number(), z.string()]) }),
  // Arithmetic over named observations, evaluated in code (see formula.ts).
  z.object({ formula: z.string() }),
]);
export type Expected = z.infer<typeof Expected>;

/**
 * What kind of thing a comparing assertion is about. Almost always a value
 * the application shows. "heading" and "label" are for the rare assertion
 * whose requirement is about the wording of a heading or a field's label.
 */
export const Subject = z.enum(["value", "heading", "label"]);
export type Subject = z.infer<typeof Subject>;

export const AssertionKind = z.enum([
  "number_equals",
  "number_at_least",
  "number_at_most",
  "text_equals",
  "text_contains",
  "present",
  "absent",
]);

/** One value the executor records at one moment of a scenario, for use in formulas. */
export const Observation = z.object({
  name: z.string(),
  /** What is read. */
  what: z.string(),
  /** The moment in the scenario at which it is read. One name is one moment. */
  when: z.string(),
  unit: Unit.default("plain"),
  /** A number, usable in formulas, or a piece of text such as a status. Absent means a number. */
  type: z.enum(["number", "text"]).optional(),
});
export type Observation = z.infer<typeof Observation>;

export const Assertion = z.object({
  id: z.string(),
  description: z.string(),
  kind: AssertionKind,
  /** For numeric kinds: the unit of the expected value. Absent in plans made before units were declared. */
  unit: Unit.optional(),
  /** Set only when the assertion is about a heading or a label itself. Absent means a value. */
  subject: Subject.optional(),
  /** Required for the comparing kinds; unused for present and absent. */
  expected: Expected.optional(),
  /**
   * Set when the assertion is about a value at an earlier moment: the named
   * observation, as it was recorded then, is what is compared. Such an
   * assertion never reads the page as it is when the comparison is made.
   */
  actual: z.object({ observation: z.string() }).optional(),
  requirementId: z.string().optional(),
  /**
   * Other approved requirements this same comparison also verifies. The
   * expected value still rests on `requirementId` alone.
   */
  alsoVerifies: z.array(z.string()).optional(),
  /**
   * Where the expected value's authority comes from. Copied on by the plan
   * validator from the source record; never written by a model.
   */
  provenance: z
    .object({ sourceId: z.string(), trust: z.literal("authoritative"), origin: z.string(), quote: z.string() })
    .optional(),
});
export type Assertion = z.infer<typeof Assertion>;

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  basis: z.enum(["requirement", "risk", "exploratory"]),
  requirementIds: z.array(z.string()).default([]),
  /** What to do, in plain language. Never contains expected values. */
  intent: z.string(),
  /**
   * Data the scenario needs that no fixture provides, to be created through
   * the application's own interface before the checks. Plain language.
   */
  setup: z.string().optional(),
  /** alias -> fixture type declared in the environment manifest. */
  fixtures: z.record(z.string(), z.string()).default({}),
  /**
   * The values to record, each at its own moment. Absent in plans made before
   * observations were declared; then any name may be recorded.
   */
  observations: z.array(Observation).optional(),
  assertions: z.array(Assertion),
});
export type Scenario = z.infer<typeof Scenario>;

// ---- environment manifest ---------------------------------------------------

export const Manifest = z.object({
  baseUrl: z.string().url(),
  version: z.object({ path: z.string() }).optional(),
  fixtures: z
    .record(
      z.string(),
      z.object({
        description: z.string(),
        method: z.string().default("POST"),
        path: z.string(),
        /**
         * Request body in whatever shape the application expects. The string
         * "{{key}}" anywhere inside it is replaced with a key that is unique
         * to the scenario and alias, and the same on every run.
         */
        body: z.unknown().optional(),
        /** True if the fixture yields credentials someone can sign in with. */
        account: z.boolean().default(false),
        /** Response fields to hide from the model, beyond the obvious ones. */
        secretFields: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  /** External systems the application talks to, and how they behave here. */
  integrations: z
    .record(
      z.string(),
      z.object({ mode: z.enum(["real", "simulated", "unavailable"]), notes: z.string().optional() }),
    )
    .default({}),
  /**
   * Accounts the application already has when it starts, for applications
   * that offer no way to create test accounts on request. These are test
   * credentials of a throwaway installation, kept in a file anyone with the
   * repository can read: never real ones.
   */
  accounts: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
      z.object({ description: z.string(), username: z.string().min(1), password: z.string().min(1) }),
    )
    .default({}),
  /** How to build and start the application in an isolated container. */
  start: z
    .object({
      install: z.string().optional(),
      build: z.string().optional(),
      /** Command that starts the application. Not used with `dockerfile`, where the image says how it starts. */
      run: z.string().optional(),
      /**
       * A Dockerfile of the application's own, relative to the manifest,
       * for applications the generic image cannot run. It is built with the
       * manifest's directory as its context. Whatever it says about user,
       * volumes or network, the container is started with the sandbox's
       * restrictions.
       */
      dockerfile: z
        .string()
        .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
        .refine((p) => !p.split("/").includes(".."), "must stay inside the application directory")
        .optional(),
      /**
       * Directories the application must be able to write to. Each becomes a
       * temporary in-memory directory; everything else stays read-only.
       */
      writable: z
        .array(
          z
            .string()
            .regex(/^(\/[A-Za-z0-9._-]+)+$/)
            .refine((p) => !p.split("/").some((part) => part === ".." || part === "."), "must be a plain absolute path"),
        )
        .max(5)
        .default([]),
      /**
       * shared        one application for the whole run
       * per-scenario  a new application for every scenario and every repeat,
       *               so scenarios cannot affect each other and each starts
       *               from the same state
       */
      instances: z.enum(["shared", "per-scenario"]).default("shared"),
      port: z.number().int().min(1).max(65535),
      /** Environment for the application process. Never secrets. */
      env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
      /** Name of the variable through which the application learns its commit. */
      commitEnv: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/)
        .optional(),
    })
    .refine((s) => (s.dockerfile === undefined) !== (s.run === undefined), "needs exactly one of run and dockerfile")
    .refine((s) => s.dockerfile === undefined || (s.install === undefined && s.build === undefined), "install and build are not used with dockerfile")
    .optional(),
  /** Documentation and API contracts to read, relative to the manifest. */
  docs: z.array(z.string()).default([]),
  /** Requests allowed to leave the browser while signing in during discovery, e.g. "POST /sign-in". */
  signIn: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
  discovery: z
    .object({
      /** Extra link text or path fragments never to follow. */
      deny: z.array(z.string()).default([]),
      maxPages: z.number().int().positive().default(12),
    })
    .default({ deny: [], maxPages: 12 }),
});
export type Manifest = z.infer<typeof Manifest>;

// ---- execution records ------------------------------------------------------

/** One executed tool call. `input` alone is enough to replay it. */
export const Step = z.object({
  tool: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  summary: z.string(),
  /** The executor's stated reason for the step. Informational only. */
  rationale: z.string().optional(),
});
export type Step = z.infer<typeof Step>;

/**
 * What stands behind one comparison, assembled by code at the moment it was
 * made. It does not depend on the step listing, and nothing in it is written
 * by a model. Identities are fixture aliases; secrets never enter it.
 */
export const Evidence = z.object({
  /** The step of the scenario at which the comparison was made. */
  step: z.number(),
  /** The approved requirement the expected value rests on. */
  requirement: z.object({ id: z.string(), sourceId: z.string().optional(), quote: z.string().optional() }).optional(),
  /** The expected value as the plan fixed it, and for a formula the observations it was computed from. */
  expected: z.object({ literal: z.union([z.number(), z.string()]).optional(), formula: z.string().optional(), kind: z.string(), unit: z.string().optional() }),
  /** Whose credentials were last entered in this browser session: a fixture alias, and the step. */
  actor: z.object({ alias: z.string(), step: z.number() }).optional(),
  /** What was looked at: the page, or the API call whose response was read. */
  resource: z.object({
    page: z.string().optional(),
    request: z.object({ step: z.number(), method: z.string(), path: z.string(), status: z.number(), body: z.string().optional() }).optional(),
  }),
  /** Observations the comparison used: the state read earlier, each at its declared moment. */
  before: z.array(z.object({ name: z.string(), when: z.string().optional(), value: z.number(), step: z.number().optional() })),
  /** The last step before the comparison that could change the application's state. */
  action: z.object({ step: z.number(), tool: z.string(), what: z.string() }).optional(),
  /** How the thing compared was identified. */
  target: z.object({
    locatedBy: z.string(),
    within: z.string().optional(),
    matched: z.number().optional(),
    visible: z.boolean().optional(),
    element: z.object({ tag: z.string(), role: z.string().optional(), context: z.string().optional() }).optional(),
  }),
  /** The text as read, before a pattern or a unit conversion. */
  raw: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const AssertionResult = z.object({
  assertionId: z.string(),
  expected: z.union([z.number(), z.string()]),
  actual: z.union([z.number(), z.string()]),
  pass: z.boolean(),
  target: z.unknown(),
  /** The number as it was read, when it was converted to the assertion's unit before comparing. */
  readAs: z.number().optional(),
  /** For a mismatch: what stands behind it besides this one reading. Set by code after the run. */
  standing: z.enum(["state", "corroborated", "re-resolved", "single"]).optional(),
  evidence: Evidence.optional(),
  screenshot: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

export const Verdict = z.enum(["passed", "failed", "blocked", "unverified"]);
export type Verdict = z.infer<typeof Verdict>;

export type Outcome =
  | { kind: "completed"; reason: string }
  | { kind: "blocked"; reason: string }
  /** The run ended without the executor declaring an outcome. */
  | { kind: "stopped"; reason: string };

export type Usage = { model: string; inputTokens: number; outputTokens: number; turns: number };

export type ScenarioResult = {
  scenarioId: string;
  title: string;
  mode: "agent" | "replay";
  /** What chose the steps: a model id, or how an external model was attached. */
  driver?: string;
  verdict: Verdict;
  reason: string;
  environment: {
    baseUrl: string;
    deployedSha?: string;
    expectedSha?: string;
    /** How the commit was established when the application cannot report it. */
    commitEstablished?: string;
  };
  assertionResults: AssertionResult[];
  /**
   * Comparisons taken out of the verdict because two attempts, each locating
   * the value its own way, disagreed about them. They stay on record here.
   */
  setAside?: { assertionId: string; expected: number | string; actual: number | string; target: unknown; otherActual: number | string; otherTarget: unknown }[];
  observations: Record<string, number>;
  /** Observations that hold text, such as a status read at one moment. */
  textObservations?: Record<string, string>;
  steps: Step[];
  evidence: { trace?: string; dir: string };
  usage?: Usage;
  startedAt: string;
  durationMs: number;
};

// ---- ingestion --------------------------------------------------------------

export type Ticket = {
  key: string;
  summary: string;
  description: string;
  comments: { author: string; created: string; body: string; id?: string; authorId?: string; updated?: string }[];
  /** Jira's numeric issue id, and who reported the issue, when the record carries them. */
  id?: string;
  reporter?: { name: string; accountId?: string };
  updated?: string;
};

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha?: string;
  /** "owner/name" of the repository the head branch lives in. */
  headRepo?: string;
  draft?: boolean;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
};

export type Doc = { path: string; text: string };

/** Everything read before any model is involved. */
export type RunContext = {
  ticket: Ticket;
  pullRequest: PullRequest;
  /** Approved documents, as read at the protected revision. */
  docs: Doc[];
  /** The same documents as the pull request has them. Never authoritative by themselves. */
  headDocs: Doc[];
  protectedRevision: string;
  /** Every text of the run with the trust level code assigned to it. */
  sources: SourceRecord[];
  /** What the pull request changes in the documents that count as requirements. */
  docChanges: DocChange[];
  /** How approval commands on the pull request were judged. */
  approvals: ApprovalDecision[];
  /** Things a reader must know about how trust was assigned. */
  authorityNotices: string[];
  /** Material left out to stay within the size budget. Never silent. */
  omitted: string[];
};

// ---- discovery --------------------------------------------------------------

export type AppMap = {
  views: {
    /** "anonymous", or the alias of the account that was signed in. */
    as: string;
    signedIn: boolean;
    pages: { path: string; title: string; snapshot: string }[];
    /** Same-origin requests the pages made while being viewed. */
    requests: { method: string; path: string; status: number }[];
    skippedLinks: string[];
  }[];
};

// ---- analysis and plan (shapes the model fills in) ----------------------------

/** What the analyst model returns. It names a source and quotes it; it has no field for trust. */
export const AnalysisDraft = z.object({
  featureSummary: z.string(),
  requirements: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      kind: z.enum(["documented", "inferred"]),
      /** Id of the one source the quote is copied from. Empty for inferred requirements. */
      sourceId: z.string(),
      /** Exact text copied from that source. Empty for inferred requirements. */
      quote: z.string(),
      /**
       * Only for statements quoted from pull-request material: how the
       * statement relates to the approved requirements.
       */
      relation: z.enum(["none", "consistent", "contradicts", "adds", "removes"]),
      /** The approved requirement the relation refers to, or empty. */
      relatedRequirementId: z.string(),
    }),
  ),
  ambiguities: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      why: z.string(),
      relatedRequirementIds: z.array(z.string()),
    }),
  ),
  risks: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      basis: z.string(),
      relatedRequirementIds: z.array(z.string()),
    }),
  ),
  /**
   * Rules in an earlier approved source that a later approved source
   * replaces. A proposal only: code checks the sources, their sequence and
   * the text before anything is retired.
   */
  supersessions: z.array(
    z.object({
      /** Exact text of the replaced rule, copied from the earlier source. */
      retiredText: z.string(),
      retiredSourceId: z.string(),
      /** The later approved source that replaces it. */
      bySourceId: z.string(),
    }),
  ),
  /** Pairs of approved requirements that cannot both hold and that no supersession settles. */
  contradictions: z.array(
    z.object({
      firstRequirementId: z.string(),
      secondRequirementId: z.string(),
      why: z.string(),
    }),
  ),
});
export type AnalysisDraft = z.infer<typeof AnalysisDraft>;

export type Requirement = {
  id: string;
  text: string;
  /**
   * documented  quoted from an authoritative source; may set an expected value
   * claimed     quoted from pull-request or unverified material; never sets one
   * inferred    no verifiable quote
   */
  kind: "documented" | "claimed" | "inferred";
  quote: string;
  /** Set by code from the source record the quote was verified against. */
  sourceId?: string;
  trust?: Trust;
  origin?: string;
  relation?: "none" | "consistent" | "contradicts" | "adds" | "removes";
  relatedRequirementId?: string;
  /** Present only in analyses recorded before sources had ids. */
  sourceType?: string;
  /**
   * Set by code when this approved requirement contradicts another and no
   * verified supersession says which holds. It cannot set an expected value
   * until a requirement owner settles it.
   */
  contested?: boolean;
};

/** A disagreement between pull-request material and the approved requirements, or a change nobody accounted for. */
export type Conflict = {
  id: string;
  kind:
    | "contradiction"
    | "unstated-addition"
    | "removal"
    | "unclassified"
    | "rule-changed"
    | "change-not-analysed"
    /** Two approved requirements disagree and nothing verified says which holds. */
    | "authoritative-contradiction"
    /** A "Supersedes:" line that could not be honoured. */
    | "supersession-invalid";
  description: string;
  claimId?: string;
  requirementId?: string;
  docPath?: string;
};

export type Analysis = Omit<AnalysisDraft, "requirements" | "supersessions" | "contradictions"> & {
  requirements: Requirement[];
  /** Approved requirements the analyst reported as disagreeing. Kept so a replay finds the same conflicts. */
  contradictions?: AnalysisDraft["contradictions"];
  /** Every rule taken as replaced, after code checked it. Absent in runs made before precedence was enforced. */
  supersessions?: Supersession[];
  /** Computed by code. A run with any entry here cannot be reported as ready. */
  conflicts?: Conflict[];
};

/** Flat on purpose: easy for a model to fill and for code to check. */
export const PlanDraft = z.object({
  scenarios: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      basis: z.enum(["requirement", "risk"]),
      requirementIds: z.array(z.string()),
      riskIds: z.array(z.string()),
      intent: z.string(),
      /** Data to create through the application's interface first. Empty if none. */
      setup: z.string(),
      fixtures: z.array(z.object({ alias: z.string(), type: z.string() })),
      /**
       * Every value a formula uses, each recorded at ONE moment. The same value
       * read at two moments is two observations with two names.
       */
      observations: z.array(
        z.object({
          name: z.string(),
          what: z.string(),
          when: z.string(),
          unit: Unit,
          /** "text" for a value that is not a number, such as a status. Omit for a number. */
          type: z.enum(["number", "text"]).optional(),
        }),
      ),
      /**
       * Which approved requirement this scenario probes, and how. Used by code to choose
       * what runs when there are more scenarios than the limit.
       */
      focus: z.array(z.object({ requirementId: z.string(), aspect: z.enum(ASPECTS) })).optional(),
      status: z.enum(["runnable", "blocked"]),
      /** Why it cannot run, if blocked. Empty otherwise. */
      blockedReason: z.string(),
      ambiguityIds: z.array(z.string()),
      assertions: z.array(
        z.object({
          id: z.string(),
          description: z.string(),
          kind: AssertionKind,
          expectedNumber: z.number().nullable(),
          expectedText: z.string().nullable(),
          expectedFormula: z.string().nullable(),
          /** Unit of the expected value for numeric kinds; "plain" for anything that is not money. */
          unit: Unit,
          /** "heading" or "label" only when the requirement is about that wording itself. Omit for a value. */
          subject: Subject.optional(),
          /** Name of a declared observation, when the assertion is about that recorded value and not about the page at the time of checking. */
          actualObservation: z.string().nullable().optional(),
          requirementId: z.string(),
          /** Ids of other documented requirements this same comparison verifies. Empty if none. */
          alsoVerifies: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

export type PlannedScenario = {
  scenario: Scenario;
  /** "deferred": runnable, but not chosen under the scenario limit. It stays in the plan whole. */
  status: "runnable" | "blocked" | "deferred";
  blockedReason: string;
  ambiguityIds: string[];
  riskIds: string[];
  /** Which approved requirement the scenario probes in which way, as the planner declared it and the validator kept it. */
  focus?: { requirementId: string; aspect: Aspect }[];
  /** Set by the selection: its rank among those chosen (absent if deferred), and what it adds. */
  selection?: { rank?: number; score: number; reasons: string[] };
};

export type Plan = {
  scenarios: PlannedScenario[];
  /** What validation changed or removed, and why. */
  notes: string[];
  /** Questions raised because the plan needed an expectation no source states. */
  clarifications: { scenarioId: string; question: string }[];
  /** Runnable scenarios the planner wrote that were dropped to respect the limit. */
  trimmedRunnable?: number;
  /** How the scenarios that run were chosen from the candidates. */
  selection?: { cap: number; candidates: number; policy: "coverage" | "as planned"; boundaryGaps: string[] };
};

// ---- the whole run ----------------------------------------------------------

export type RunReport = {
  ticketKey: string;
  pullRequest: { repo: string; number: number; headSha: string; title: string };
  environment: {
    baseUrl: string;
    deployedSha?: string;
    /** How the commit was established when the application cannot report it. */
    commitEstablished?: string;
    /** Whether every scenario ran against its own freshly started application. */
    instances?: "shared" | "per-scenario";
  };
  driver: string;
  context: {
    docs: string[];
    changedFiles: string[];
    omitted: string[];
    /** Every source with its trust level and origin; texts are in context.json. */
    sources?: { id: string; kind: string; trust: Trust; origin: string; basis: string; sha256?: string; identity?: string }[];
    /** The requirement owners in force for this run, as read from the protected revision. */
    owners?: Authority["requirementOwners"];
    docChanges?: DocChange[];
    approvals?: ApprovalDecision[];
    authorityNotices?: string[];
    /** Commit the approved documents and the owner list were read from. */
    protectedRevision?: string;
  };
  analysis: Analysis;
  analysisNotes: string[];
  plan: Plan;
  results: ScenarioResult[];
  confirmations: Record<string, "reproduced" | "not reproduced" | "replay diverged">;
  timings: { stage: string; seconds: number }[];
  startedAt: string;
  /**
   * Who decided what to test and how, in this run:
   *   autonomous  a live model analysed, planned and executed
   *   replay      an earlier autonomous run's scenarios were re-run
   *   recorded    no live model; an earlier run's decisions were replayed
   */
  executionMode?: "autonomous" | "replay" | "recorded";
  /** Model spend and the limits it ran under. Absent for runs made before budgets existed. */
  usage?: UsageSummary;
  /** Why the run ended early, if it did. */
  stopped?: string;
  /**
   * Scenarios re-run on the escalation model because their first run gave no
   * trustworthy verdict. A failure that repeats and rests on more than one
   * page observation is never among them.
   */
  escalations?: {
    scenarioId: string;
    why: string;
    before: string;
    after: string;
    kept: "escalated run" | "first run";
    /** The run whose result was NOT kept, whole: its reason, steps and comparisons stay inspectable. */
    other?: ScenarioResult;
  }[];
  /** Fingerprint of every authoritative source, to tell whether requirements changed between runs. */
  ticketHash?: string;
  /** Set when this run re-ran an earlier run's scenarios instead of planning afresh. */
  retestOf?: {
    headSha: string;
    rows: { scenarioId: string; before: string; after: string; how: "replay" | "model" }[];
  };
};
