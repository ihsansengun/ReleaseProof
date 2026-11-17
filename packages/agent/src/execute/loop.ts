import Anthropic from "@anthropic-ai/sdk";
import type { Manifest } from "../schema.ts";
import { briefing, SYSTEM } from "./briefing.ts";
import { runTool, toolDefinitions, type Session } from "./tools.ts";

export type LoopOptions = {
  client: Anthropic;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxToolCalls: number;
};

export type LoopUsage = { model: string; inputTokens: number; outputTokens: number; turns: number };

/**
 * Bounded tool loop. Ends when the executor calls finish, stops calling tools,
 * or exhausts its budget. The outcome is left on the session; the verdict is
 * computed elsewhere.
 */
export async function runAgentLoop(
  session: Session,
  manifest: Manifest,
  fixtures: Record<string, unknown>,
  options: LoopOptions,
): Promise<LoopUsage> {
  const usage: LoopUsage = { model: options.model, inputTokens: 0, outputTokens: 0, turns: 0 };
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: briefing(session.scenario, manifest, fixtures) },
  ];
  let toolCalls = 0;

  while (!session.outcome) {
    const response = await options.client.beta.messages.create({
      model: options.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: toolDefinitions,
      messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: options.effort },
      // If the primary model declines a request, let the API re-run it on a
      // fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
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
      if (session.outcome || toolCalls >= options.maxToolCalls) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Not run.", is_error: true });
        continue;
      }
      toolCalls++;
      const { ok, output } = await runTool(session, call.name, call.input);
      results.push({ type: "tool_result", tool_use_id: call.id, content: output, is_error: !ok });
    }
    messages.push({ role: "user", content: results });

    if (!session.outcome && toolCalls >= options.maxToolCalls) {
      session.outcome = { kind: "stopped", reason: `Step budget of ${options.maxToolCalls} tool calls exhausted.` };
    }
  }
  return usage;
}
