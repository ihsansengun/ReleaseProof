import { z } from "zod";

// ---- scenarios and assertions (what the engine executes) --------------------

/** What an assertion compares against. Fixed before any browser opens. */
export const Expected = z.union([
  z.object({ literal: z.union([z.number(), z.string()]) }),
  // Arithmetic over named observations, evaluated in code (see formula.ts).
  z.object({ formula: z.string() }),
]);
export type Expected = z.infer<typeof Expected>;

export const AssertionKind = z.enum(["number_equals", "text_equals", "text_contains", "present", "absent"]);

export const Assertion = z.object({
  id: z.string(),
  description: z.string(),
  kind: AssertionKind,
  /** Required for the comparing kinds; unused for present and absent. */
  expected: Expected.optional(),
  requirementId: z.string().optional(),
});
export type Assertion = z.infer<typeof Assertion>;

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  basis: z.enum(["requirement", "risk", "exploratory"]),
  requirementIds: z.array(z.string()).default([]),
  /** What to do, in plain language. Never contains expected values. */
  intent: z.string(),
  /** alias -> fixture type declared in the environment manifest. */
  fixtures: z.record(z.string(), z.string()).default({}),
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

export const AssertionResult = z.object({
  assertionId: z.string(),
  expected: z.union([z.number(), z.string()]),
  actual: z.union([z.number(), z.string()]),
  pass: z.boolean(),
  target: z.unknown(),
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
  environment: { baseUrl: string; deployedSha?: string; expectedSha?: string };
  assertionResults: AssertionResult[];
  observations: Record<string, number>;
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
  comments: { author: string; created: string; body: string }[];
};

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
};

export type Doc = { path: string; text: string };

/** Everything read before any model is involved. */
export type RunContext = {
  ticket: Ticket;
  pullRequest: PullRequest;
  docs: Doc[];
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

export const Analysis = z.object({
  featureSummary: z.string(),
  requirements: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      kind: z.enum(["documented", "inferred"]),
      sourceType: z.enum(["ticket-description", "ticket-comment", "doc", "pull-request", "none"]),
      /** Exact text copied from the source. Empty for inferred requirements. */
      quote: z.string(),
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
});
export type Analysis = z.infer<typeof Analysis>;

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
      fixtures: z.array(z.object({ alias: z.string(), type: z.string() })),
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
          requirementId: z.string(),
        }),
      ),
    }),
  ),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

export type PlannedScenario = {
  scenario: Scenario;
  status: "runnable" | "blocked";
  blockedReason: string;
  ambiguityIds: string[];
  riskIds: string[];
};

export type Plan = {
  scenarios: PlannedScenario[];
  /** What validation changed or removed, and why. */
  notes: string[];
  /** Questions raised because the plan needed an expectation no source states. */
  clarifications: { scenarioId: string; question: string }[];
};

// ---- the whole run ----------------------------------------------------------

export type RunReport = {
  ticketKey: string;
  pullRequest: { repo: string; number: number; headSha: string; title: string };
  environment: { baseUrl: string; deployedSha?: string };
  driver: string;
  context: { docs: string[]; changedFiles: string[]; omitted: string[] };
  analysis: Analysis;
  analysisNotes: string[];
  plan: Plan;
  results: ScenarioResult[];
  confirmations: Record<string, "reproduced" | "not reproduced" | "replay diverged">;
  timings: { stage: string; seconds: number }[];
  startedAt: string;
};
