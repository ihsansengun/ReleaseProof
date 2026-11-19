/**
 * Which model does which part of a run, and how hard it is asked to think.
 *
 * The parts differ in what they need: reading requirements and writing a plan
 * need judgement and happen once; driving a browser is many small steps. Each
 * can be set on its own. Nothing here changes what is checked: quotes,
 * source authority and comparisons are verified in code whatever model ran.
 */
export const STAGES = ["analyse", "plan", "discover", "execute", "escalate"] as const;
export type Stage = (typeof STAGES)[number];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export const OPUS = "claude-opus-5-5";
/** The models a run may use. Anything else is refused, so a typing error cannot run up a bill on an unknown model. */
export const KNOWN_MODELS = [SONNET, HAIKU, OPUS] as const;

export type Routing = {
  models: Record<Stage, string>;
  efforts: Record<Stage, Effort>;
  /** Re-run a scenario that ended without a trustworthy verdict on the `escalate` model. */
  escalation: boolean;
};

export const DEFAULT_ROUTING: Routing = {
  models: { analyse: SONNET, plan: SONNET, discover: HAIKU, execute: HAIKU, escalate: SONNET },
  efforts: { analyse: "medium", plan: "medium", discover: "low", execute: "medium", escalate: "medium" },
  escalation: true,
};

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Reads the routing from the environment:
 *
 *   RELEASEPROOF_MODEL_<STAGE>    model for one stage (ANALYSE, PLAN, DISCOVER, EXECUTE, ESCALATE)
 *   RELEASEPROOF_MODEL            model for every stage not set individually
 *   RELEASEPROOF_EFFORT_<STAGE>   effort for one stage
 *   RELEASEPROOF_EFFORT           effort for every stage not set individually
 *   RELEASEPROOF_ESCALATION=off   never re-run a scenario on the escalation model
 *   RELEASEPROOF_ALLOW_OPUS=on    permit the dearest model; without it, naming that model is an error
 *
 * A value that is not a known model or effort is an error, not a fallback.
 */
export function routingFromEnv(env: Record<string, string | undefined>, overrides: Partial<Record<Stage, string>> = {}): Routing {
  const routing: Routing = { models: { ...DEFAULT_ROUTING.models }, efforts: { ...DEFAULT_ROUTING.efforts }, escalation: env.RELEASEPROOF_ESCALATION !== "off" };
  const set = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value.trim());
  for (const stage of STAGES) {
    const model = overrides[stage] ?? set(env[`RELEASEPROOF_MODEL_${stage.toUpperCase()}`]) ?? set(env.RELEASEPROOF_MODEL);
    if (model !== undefined) {
      if (!(KNOWN_MODELS as readonly string[]).includes(model)) throw new Error(`"${model.slice(0, 60)}" is not a model this system uses for the ${stage} stage. Known: ${KNOWN_MODELS.join(", ")}.`);
      routing.models[stage] = model;
    }
    const effort = set(env[`RELEASEPROOF_EFFORT_${stage.toUpperCase()}`]) ?? set(env.RELEASEPROOF_EFFORT);
    if (effort !== undefined) {
      if (!EFFORTS.includes(effort as Effort)) throw new Error(`"${effort.slice(0, 20)}" is not an effort level for the ${stage} stage.`);
      routing.efforts[stage] = effort as Effort;
    }
  }
  if (env.RELEASEPROOF_ALLOW_OPUS !== "on") {
    const stage = STAGES.find((s) => routing.models[s] === OPUS);
    if (stage) throw new Error(`The ${stage} stage is set to ${OPUS}, which is off unless RELEASEPROOF_ALLOW_OPUS is "on".`);
  }
  return routing;
}

/** One line for logs and reports. */
export function describeRouting(routing: Routing): string {
  const m = routing.models;
  const execution = m.discover === m.execute ? `${m.execute} (discovery and execution)` : `${m.discover} (discovery), ${m.execute} (execution)`;
  const thinking = m.analyse === m.plan ? `${m.analyse} (analysis and planning)` : `${m.analyse} (analysis), ${m.plan} (planning)`;
  return `${thinking}, ${execution}${routing.escalation ? `, ${m.escalate} (escalation)` : ", no escalation"}`;
}

/** Whether the API can re-run a declined request on another model for this one. */
export const supportsFallbacks = (model: string) => model === OPUS || model === SONNET;
