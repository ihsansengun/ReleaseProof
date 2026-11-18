import Anthropic from "@anthropic-ai/sdk";
import type { Budget } from "../budget.ts";
import type { Usage } from "../schema.ts";
import { runTool, toolDefinitions, type Session, type ToolName } from "./tools.ts";

export type LoopOptions = {
  client: Anthropic;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  budget: Budget;
  /** Ask the API to re-run a declined request on a fallback model. */
  fallbacks: boolean;
};

export type SessionJob = {
  system: string;
  briefing: string;
  tools: readonly ToolName[];
  maxToolCalls: number;
};

/**
 * Bounded tool loop against the model API. Ends when the executor calls
 * finish, stops calling tools, exhausts its own or the run's budget, or the
 * API fails after the client's retries. The outcome is left on the session;
 * the verdict is computed elsewhere.
 */
export async function runAgentLoop(session: Session, job: SessionJob, options: LoopOptions): Promise<Usage> {
  const usage: Usage = { model: options.model, inputTokens: 0, outputTokens: 0, turns: 0 };
  const tools = toolDefinitions.filter((t) => job.tools.includes(t.name));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: job.briefing }];
  let toolCalls = 0;

  while (!session.outcome) {
    const over = options.budget.exceeded();
    if (over) {
      session.outcome = { kind: "stopped", reason: `Run budget exhausted: ${over}.` };
      break;
    }

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await options.client.beta.messages.create({
        model: options.model,
        max_tokens: 16000,
        system: job.system,
        tools,
        messages,
        cache_control: { type: "ephemeral" },
        output_config: { effort: options.effort },
        ...(options.fallbacks
          ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const }
          : {}),
      });
    } catch (error) {
      // Bad credentials will not get better by carrying on: fail the run.
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        options.budget.noteError(`HTTP ${error.status}: credentials rejected`);
        throw error;
      }
      // Anything else has already been retried by the client where that helps.
      const what =
        error instanceof Anthropic.APIConnectionError
          ? "could not be reached"
          : error instanceof Anthropic.APIError
            ? `returned HTTP ${error.status}`
            : `failed (${(error as Error).message.split("\n")[0]})`;
      options.budget.noteError(what);
      session.outcome = { kind: "stopped", reason: `The model API ${what} after retries.` };
      break;
    }

    options.budget.record(response.usage);
    usage.turns++;
    usage.inputTokens +=
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    usage.outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      session.outcome = { kind: "stopped", reason: "The model declined to continue." };
      break;
    }
    if (response.stop_reason === "max_tokens") {
      session.outcome = { kind: "stopped", reason: "A model response was cut off at the output limit." };
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const calls = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
    );
    if (calls.length === 0) {
      session.outcome = { kind: "stopped", reason: "The executor stopped without calling finish." };
      break;
    }

    // Browser actions depend on sequence, so calls run one after another.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      if (session.outcome || toolCalls >= job.maxToolCalls) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Not run.", is_error: true });
        continue;
      }
      toolCalls++;
      options.budget.toolCall();
      const { ok, output } = await runTool(session, call.name, call.input, job.tools);
      results.push({ type: "tool_result", tool_use_id: call.id, content: output, is_error: !ok });
    }
    messages.push({ role: "user", content: results });

    if (!session.outcome && toolCalls >= job.maxToolCalls) {
      session.outcome = { kind: "stopped", reason: `Step budget of ${job.maxToolCalls} tool calls exhausted.` };
    }
  }
  return usage;
}
