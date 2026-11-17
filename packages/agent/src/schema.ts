import { z } from "zod";

/** What an assertion compares against. Fixed before any browser opens. */
export const Expected = z.union([
  z.object({ literal: z.union([z.number(), z.string()]) }),
  // Arithmetic over named observations, evaluated in code (see formula.ts).
  z.object({ formula: z.string() }),
]);
export type Expected = z.infer<typeof Expected>;

export const Assertion = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(["number_equals", "text_equals", "text_contains"]),
  expected: Expected,
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
  assertions: z.array(Assertion).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

export const Manifest = z.object({
  baseUrl: z.string().url(),
  version: z.object({ path: z.string() }).optional(),
  fixtures: z
    .record(
      z.string(),
      z.object({ description: z.string(), method: z.string().default("POST"), path: z.string() }),
    )
    .default({}),
});
export type Manifest = z.infer<typeof Manifest>;

/** One executed tool call. `input` alone is enough to replay it. */
export const Step = z.object({
  tool: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  summary: z.string(),
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

export type ScenarioResult = {
  scenarioId: string;
  title: string;
  mode: "agent" | "replay";
  verdict: Verdict;
  reason: string;
  environment: { baseUrl: string; deployedSha?: string; expectedSha?: string };
  assertionResults: AssertionResult[];
  observations: Record<string, number>;
  steps: Step[];
  evidence: { trace?: string; dir: string };
  usage?: { model: string; inputTokens: number; outputTokens: number; turns: number };
  startedAt: string;
  durationMs: number;
};
