import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { Budget, BudgetExceeded, pricesFor } from "../budget.ts";
import { describeRouting, supportsFallbacks, type Routing, type Stage } from "../routing.ts";
import { runAgentLoop, type SessionJob } from "../execute/loop.ts";
import type { Session } from "../execute/tools.ts";
import type { Usage } from "../schema.ts";

export type TaskJob<T> = {
  /** Short name, for logs and timings. */
  name: string;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
};

/**
 * Everything the system asks of a model goes through this interface: one-shot
 * structured tasks (analysis, planning) and tool-using sessions (sign-in,
 * scenario execution). Stages do not know which implementation is attached.
 */
export interface Driver {
  readonly label: string;
  /** True if a model decides things as the run happens; false if earlier decisions are replayed. */
  readonly live: boolean;
  task<T>(job: TaskJob<T>): Promise<T>;
  /** Runs until the session has an outcome. */
  session(session: Session, job: SessionJob & { name: string }): Promise<Usage | undefined>;
  close(): Promise<void>;
}

/** A model API failure in a few words, without any request content. */
export function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionError) return "connection failed";
  if (error instanceof Anthropic.APIError) {
    const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
    return `HTTP ${error.status}${type ? ` ${type}` : ""}: ${error.message.split("\n")[0]!.slice(0, 200)}`;
  }
  return (error as Error).message.split("\n")[0]!.slice(0, 200);
}

export type ApiDriverOptions = {
  /** Which model and effort each stage uses. */
  routing: Routing;
  budget: Budget;
  /** Defaults to true. Turn off if the API rejects the fallback parameters. */
  fallbacks?: boolean;
  /** The model key, when the caller holds it instead of the environment. */
  apiKey?: string;
  /** For tests: point the client somewhere else. Credentials otherwise come from the environment. */
  client?: { baseURL: string; apiKey: string };
};

/** How long one API request may take, and how often the client retries it. */
const REQUEST_TIMEOUT_MS = 180_000;
const TASK_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 4;
/** Output allowance of an analysis or planning call, and the least that is worth starting one with. */
const TASK_MAX_TOKENS = 32_000;
const TASK_MIN_TOKENS = 4_000;

/**
 * Calls the model API directly. The client retries rate limits, overload and
 * connection errors with backoff; every response's token usage is charged to
 * the run's budget, and no call is made once the budget is spent.
 */
export class ApiDriver implements Driver {
  readonly label: string;
  readonly live = true;
  private client: Anthropic;

  constructor(private options: ApiDriverOptions) {
    this.label = describeRouting(options.routing);
    this.client = new Anthropic({
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...options.client,
    });
  }

  async task<T>(job: TaskJob<T>): Promise<T> {
    const stage: Stage = job.name === "analyse" ? "analyse" : "plan";
    const model = this.options.routing.models[stage];
    const { budget } = this.options;
    // The prompt's size is estimated generously (three characters a token),
    // and the output allowance is cut to what the remaining budget can pay
    // for, so this call cannot take the run past its limit.
    const promptTokens = Math.ceil((job.instructions.length + job.input.length) / 3);
    const prices = pricesFor(model, promptTokens);
    const affordable = Math.floor(((budget.remainingUsd() - Budget.worstCase(model, promptTokens, 0)) * 1_000_000) / prices.output);
    const maxTokens = Math.min(TASK_MAX_TOKENS, affordable);
    const over = budget.exceeded() ?? (maxTokens < TASK_MIN_TOKENS ? `what is left of the cost limit ($${budget.remainingUsd().toFixed(2)}) does not cover the ${job.name} task` : undefined);
    if (over) throw new BudgetExceeded(over);
    const stream = this.client.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: job.instructions,
        messages: [{ role: "user", content: job.input }],
        output_config: { effort: this.options.routing.efforts[stage], format: zodOutputFormat(job.schema) },
      },
      { timeout: TASK_TIMEOUT_MS },
    );
    const response = await stream.finalMessage().catch((error: unknown) => {
      this.options.budget.noteError(describeApiError(error));
      throw error;
    });
    this.options.budget.record(response.usage, response.model);
    if (response.stop_reason === "refusal") throw new Error(`The model declined the ${job.name} task.`);
    if (response.stop_reason === "max_tokens") throw new Error(`The ${job.name} output was cut off at the output limit.`);
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`The ${job.name} task did not return JSON.`);
    }
    return job.schema.parse(parsed);
  }

  session(session: Session, job: SessionJob & { name: string }): Promise<Usage> {
    const stage: Stage = job.stage ?? "execute";
    const model = this.options.routing.models[stage];
    return runAgentLoop(session, job, {
      client: this.client,
      model,
      effort: this.options.routing.efforts[stage],
      budget: this.options.budget,
      fallbacks: (this.options.fallbacks ?? true) && supportsFallbacks(model),
    });
  }

  async close(): Promise<void> {}
}
