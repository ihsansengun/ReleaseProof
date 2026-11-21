import type { Step } from "../schema.ts";
import { runTool, type Session } from "./tools.ts";

export type ReplayLimits = {
  /**
   * The one origin the page may be on. A redirect is followed by the browser
   * before any request filter sees it, so where the page ended up is checked
   * here, before and after every step. Nothing read on another origin is kept.
   */
  confineTo?: string;
  /** Says whether the time allowed has run out. Asked before every step. */
  expired?: () => boolean;
};

/** The page's origin if it has left the one it is confined to. A page not yet opened has left nothing. */
function strayed(session: Session, confineTo: string | undefined): string | undefined {
  if (confineTo === undefined) return undefined;
  const address = session.page.url();
  if (address === "about:blank") return undefined;
  let origin: string;
  try {
    origin = new URL(address).origin;
  } catch {
    origin = "an address that could not be read";
  }
  return origin === confineTo ? undefined : origin;
}

/**
 * Re-runs recorded tool calls with no model involved. Steps that failed when
 * recorded were dead ends and are skipped. If a step that used to work now
 * fails, the replay stops: the recording no longer fits the application.
 */
export async function replaySteps(session: Session, recorded: Step[], limits: ReplayLimits = {}): Promise<void> {
  const left = (origin: string, when: string): void => {
    session.outcome = {
      kind: "blocked",
      reason: `The page was on ${origin.slice(0, 200)} ${when}, not on the application under test (${limits.confineTo}). Nothing read there was kept, and the scenario was stopped.`,
    };
  };
  for (const step of recorded.filter((s) => s.ok)) {
    if (limits.expired?.()) {
      session.outcome = { kind: "stopped", reason: "The run reached its time limit before this scenario finished." };
      return;
    }
    const before = strayed(session, limits.confineTo);
    if (before !== undefined) return left(before, `before ${step.tool}`);
    const compared = session.assertionResults.length;
    const { ok, output } = await runTool(session, step.tool, step.input);
    const after = strayed(session, limits.confineTo);
    if (after !== undefined) {
      // A comparison made during a step that ended somewhere else is not evidence about the application.
      session.assertionResults.length = compared;
      return left(after, `after ${step.tool}`);
    }
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
