/** Hard limits for one run. Any of them stops further model work. */
export type Limits = { maxTokens: number; maxUsd: number; maxMinutes: number };

/** US dollars per million tokens. */
export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** List prices for the default model. An estimate: the invoice is authoritative. */
export const DEFAULT_PRICES: Prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
/** List prices per model. A model not listed here is charged at the default, which is the dearest. */
export const MODEL_PRICES: Record<string, Prices> = {
  "claude-opus-5-5": DEFAULT_PRICES,
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
export const DEFAULT_LIMITS: Limits = { maxTokens: 3_000_000, maxUsd: 8, maxMinutes: 25 };

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
    const p = (model && MODEL_PRICES[model]) || this.prices;
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

  /** The limit that has been reached, in words, or undefined if none has. */
  exceeded(): string | undefined {
    const t = this.total();
    const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    if (tokens >= this.limits.maxTokens) return `token limit of ${this.limits.maxTokens} reached (${tokens} used)`;
    const cost = this.costUsd();
    if (cost >= this.limits.maxUsd) return `cost limit of $${this.limits.maxUsd} reached (about $${cost.toFixed(2)} spent)`;
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
