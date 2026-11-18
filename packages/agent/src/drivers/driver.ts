import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { BudgetExceeded, type Budget } from "../budget.ts";
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
  task<T>(job: TaskJob<T>): Promise<T>;
  /** Runs until the session has an outcome. */
  session(session: Session, job: SessionJob & { name: string }): Promise<Usage | undefined>;
  close(): Promise<void>;
}

export type ApiDriverOptions = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  budget: Budget;
  /** Defaults to true. Turn off if the API rejects the fallback parameters. */
  fallbacks?: boolean;
  /** For tests: point the client somewhere else. Credentials otherwise come from the environment. */
  client?: { baseURL: string; apiKey: string };
};

/** How long one API request may take, and how often the client retries it. */
const REQUEST_TIMEOUT_MS = 180_000;
const TASK_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 4;

/**
 * Calls the model API directly. The client retries rate limits, overload and
 * connection errors with backoff; every response's token usage is charged to
 * the run's budget, and no call is made once the budget is spent.
 */
export class ApiDriver implements Driver {
  readonly label: string;
  private client: Anthropic;

  constructor(private options: ApiDriverOptions) {
    this.label = options.model;
    this.client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES, ...options.client });
  }

  async task<T>(job: TaskJob<T>): Promise<T> {
    const over = this.options.budget.exceeded();
    if (over) throw new BudgetExceeded(over);
    const stream = this.client.messages.stream(
      {
        model: this.options.model,
        max_tokens: 32000,
        system: job.instructions,
        messages: [{ role: "user", content: job.input }],
        output_config: { effort: "high", format: zodOutputFormat(job.schema) },
      },
      { timeout: TASK_TIMEOUT_MS },
    );
    const response = await stream.finalMessage();
    this.options.budget.record(response.usage);
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
    return runAgentLoop(session, job, {
      client: this.client,
      model: this.options.model,
      effort: this.options.effort,
      budget: this.options.budget,
      fallbacks: this.options.fallbacks ?? true,
    });
  }

  async close(): Promise<void> {}
}
