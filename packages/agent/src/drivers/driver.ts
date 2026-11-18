import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
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

/** Calls the model API directly. */
export class ApiDriver implements Driver {
  readonly label: string;
  private client = new Anthropic();

  constructor(
    private model: string,
    private effort: "low" | "medium" | "high" | "xhigh" | "max",
  ) {
    this.label = model;
  }

  async task<T>(job: TaskJob<T>): Promise<T> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 64000,
      system: job.instructions,
      messages: [{ role: "user", content: job.input }],
      output_config: { effort: "high", format: zodOutputFormat(job.schema) },
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error(`The model declined the ${job.name} task.`);
    if (response.stop_reason === "max_tokens") throw new Error(`The ${job.name} output was cut off.`);
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return job.schema.parse(JSON.parse(text));
  }

  session(session: Session, job: SessionJob & { name: string }): Promise<Usage> {
    return runAgentLoop(session, job, { client: this.client, model: this.model, effort: this.effort });
  }

  async close(): Promise<void> {}
}
