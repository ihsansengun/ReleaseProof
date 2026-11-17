import type { Step } from "../schema.ts";
import { runTool, type Session } from "./tools.ts";

/**
 * Re-runs recorded tool calls with no model involved. Steps that failed when
 * recorded were dead ends and are skipped. If a step that used to work now
 * fails, the replay stops: the recording no longer fits the application.
 */
export async function replaySteps(session: Session, recorded: Step[]): Promise<void> {
  for (const step of recorded.filter((s) => s.ok)) {
    const { ok, output } = await runTool(session, step.tool, step.input);
    if (!ok) {
      session.outcome = {
        kind: "stopped",
        reason: `Replay diverged at ${step.tool} ${JSON.stringify(step.input)}: ${output}`,
      };
      return;
    }
    if (session.outcome) return;
  }
  session.outcome ??= { kind: "stopped", reason: "Recording ended without a finish step." };
}
