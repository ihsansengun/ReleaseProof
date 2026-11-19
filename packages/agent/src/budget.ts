/** Hard limits for one run. Any of them stops further model work. */
export type Limits = {
  maxTokens: number;
  maxUsd: number;
  maxMinutes: number;
  /** Optional ceilings for single stages, by the stage names a run reports ("execute", "escalate", ...). */
  stageUsd?: Record<string, number>;
};

/** US dollars per million tokens. */
export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** List prices for the default model. An estimate: the invoice is authoritative. */
export const DEFAULT_PRICES: Prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
/** List prices per model. A model not listed here is charged at the default, which is the dearest. */
export const MODEL_PRICES: Record<string, Prices> = {
  "claude-opus-5-5": DEFAULT_PRICES,
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Cache reads at 0.1 of the input rate and 5-minute cache writes at 1.25 of it.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
/**
 * Models with a second, dearer rate card for long prompts. The whole request
 * is billed on it once the prompt (uncached, cache-read and cache-written
 * tokens together) is over the threshold.
 */
export const LONG_PROMPT_PRICES: Record<string, { over: number; prices: Prices }> = {
  "claude-haiku-5-5": { over: 100_000, prices: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
};
export const DEFAULT_LIMITS: Limits = { maxTokens: 3_000_000, maxUsd: 2, maxMinutes: 25 };

/**
 * Ceilings for single stages, from RELEASEPROOF_MAX_USD_<STAGE> (for example
 * RELEASEPROOF_MAX_USD_EXECUTE). Escalation, which re-runs scenarios on a
 * dearer model, is held to two fifths of the run's limit unless set.
 */
export function stageLimitsFromEnv(env: Record<string, string | undefined>, maxUsd: number): Record<string, number> {
  const caps: Record<string, number> = { escalate: Math.round(maxUsd * 0.4 * 100) / 100 };
  for (const stage of ["discover", "analyse", "plan", "execute", "escalate", "retest"]) {
    const value = Number(env[`RELEASEPROOF_MAX_USD_${stage.toUpperCase()}`]);
    if (Number.isFinite(value) && value > 0) caps[stage] = Math.min(value, maxUsd);
  }
  return caps;
}

/** The prices one request is billed at, given the size of its prompt. */
export function pricesFor(model: string | undefined, promptTokens: number, fallback: Prices = DEFAULT_PRICES): Prices {
  const long = model ? LONG_PROMPT_PRICES[model] : undefined;
  if (long && promptTokens > long.over) return long.prices;
  return (model && MODEL_PRICES[model]) || fallback;
}

export type StageUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  /** Estimated cost of this stage's calls, each at the price of the model that served it. */
  usd: number;
};

export type UsageSummary = {
  byStage: Record<string, StageUsage>;
  total: StageUsage;
  estimatedUsd: number;
  minutes: number;
  limits: Limits;
  prices: Prices;
  /** Model API failures that were not cured by the client's retries. */
  apiErrors: { stage: string; error: string }[];
};

const empty = (): StageUsage => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
  usd: 0,
});

/** What a model API response reports about its own size. */
export type ReportedUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * Counts what a run spends and says when it must stop. Checked before every
 * model call, so a run can overshoot a limit by at most one call per
 * concurrent scenario.
 */
export class Budget {
  private byStage: Record<string, StageUsage> = {};
  private stage = "setup";
  private apiErrors: { stage: string; error: string }[] = [];
  private readonly startedAt = Date.now();

  constructor(
    readonly limits: Limits = DEFAULT_LIMITS,
    readonly prices: Prices = DEFAULT_PRICES,
  ) {}

  enter(stage: string) {
    this.stage = stage;
  }

  private current(): StageUsage {
    return (this.byStage[this.stage] ??= empty());
  }

  record(usage: ReportedUsage, model?: string) {
    const s = this.current();
    const prompt = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const p = pricesFor(model, prompt, this.prices);
    s.usd +=
      (usage.input_tokens * p.input +
        usage.output_tokens * p.output +
        (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
        (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
      1_000_000;
    s.calls++;
    s.inputTokens += usage.input_tokens;
    s.outputTokens += usage.output_tokens;
    s.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    s.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  }

  noteError(error: string) {
    this.apiErrors.push({ stage: this.stage, error });
  }

  toolCall() {
    this.current().toolCalls++;
  }

  total(): StageUsage {
    const t = empty();
    for (const s of Object.values(this.byStage)) {
      for (const key of Object.keys(t) as (keyof StageUsage)[]) t[key] += s[key];
    }
    return t;
  }

  costUsd(): number {
    return this.total().usd;
  }

  minutes(): number {
    return (Date.now() - this.startedAt) / 60_000;
  }

  /**
   * The most a call can cost: every prompt token billed as a cache write, the
   * dearest way to send it, and the whole output allowance used.
   */
  static worstCase(model: string, promptTokens: number, maxOutputTokens: number, fallback: Prices = DEFAULT_PRICES): number {
    const p = pricesFor(model, promptTokens, fallback);
    return (promptTokens * Math.max(p.cacheWrite, p.input) + maxOutputTokens * p.output) / 1_000_000;
  }

  /**
   * Whether a call of at most this cost may be made. Asked before every model
   * call, so that the run stops before a limit and not one call after it.
   * Returns the reason it may not, or undefined if it may.
   */
  refuses(worstCaseUsd: number): string | undefined {
    const over = this.exceeded();
    if (over) return over;
    const cost = this.costUsd();
    if (cost + worstCaseUsd > this.limits.maxUsd) {
      return `cost limit of $${this.limits.maxUsd} would be passed by the next model call (about $${cost.toFixed(2)} spent, up to $${worstCaseUsd.toFixed(2)} more)`;
    }
    const cap = this.limits.stageUsd?.[this.stage];
    if (cap !== undefined && this.current().usd + worstCaseUsd > cap) {
      return `the ${this.stage} stage's limit of $${cap} would be passed by the next model call (about $${this.current().usd.toFixed(2)} spent in it)`;
    }
    return undefined;
  }

  /** What is left of the run's cost limit, and of the current stage's if it has one. */
  remainingUsd(): number {
    const cap = this.limits.stageUsd?.[this.stage];
    const run = this.limits.maxUsd - this.costUsd();
    return Math.max(0, cap === undefined ? run : Math.min(run, cap - this.current().usd));
  }

  /** The limit that has been reached, in words, or undefined if none has. */
  exceeded(): string | undefined {
    const t = this.total();
    const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    if (tokens >= this.limits.maxTokens) return `token limit of ${this.limits.maxTokens} reached (${tokens} used)`;
    const cost = this.costUsd();
    if (cost >= this.limits.maxUsd) return `cost limit of $${this.limits.maxUsd} reached (about $${cost.toFixed(2)} spent)`;
    const cap = this.limits.stageUsd?.[this.stage];
    if (cap !== undefined && this.current().usd >= cap) return `the ${this.stage} stage's limit of $${cap} reached`;
    const minutes = this.minutes();
    if (minutes >= this.limits.maxMinutes) return `time limit of ${this.limits.maxMinutes} minutes reached`;
    return undefined;
  }

  summary(): UsageSummary {
    return {
      byStage: this.byStage,
      total: this.total(),
      estimatedUsd: Math.round(this.costUsd() * 10_000) / 10_000,
      minutes: Math.round(this.minutes() * 10) / 10,
      limits: this.limits,
      prices: this.prices,
      apiErrors: this.apiErrors,
    };
  }
}

export class BudgetExceeded extends Error {
  constructor(reason: string) {
    super(`Run budget exhausted: ${reason}`);
  }
}
