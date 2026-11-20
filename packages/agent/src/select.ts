/**
 * Chooses which planned scenarios run when there are more than the limit.
 *
 * Two passes. First, thresholds: where an approved requirement states a
 * limit and the planner wrote scenarios just below it and exactly at it,
 * those are taken before anything else, because a rule with a threshold is
 * only tested at its threshold. They may take up to half the limit, so
 * breadth is kept. Then coverage, as described below.
 *
 * The planner proposes a pool and says, per scenario, which approved
 * requirement it probes in which way. Code then picks: each step takes the
 * candidate that adds most to what the chosen set already covers. The policy
 * is fixed arithmetic, so the same plan always yields the same choice, and
 * every choice comes with its reasons. Nothing here reads or changes an
 * expected value, and a scenario can only be credited with a requirement that
 * one of its own comparisons rests on.
 */
import type { Plan, PlannedScenario } from "./schema.ts";

export const ASPECTS = [
  "boundary-below",
  "boundary-at",
  "boundary-above",
  "access-control",
  "ownership",
  "state-transition",
  "side-effect",
  "regression",
  "main-flow",
] as const;
export type Aspect = (typeof ASPECTS)[number];

const BOUNDARY: Aspect[] = ["boundary-below", "boundary-at", "boundary-above"];
const WORDS: Record<Aspect, string> = {
  "boundary-below": "just below the threshold",
  "boundary-at": "exactly at the threshold",
  "boundary-above": "just above the threshold",
  "access-control": "access control",
  ownership: "ownership",
  "state-transition": "a state change",
  "side-effect": "a side effect",
  regression: "regression risk",
  "main-flow": "the main flow",
};
/** What one new item of each kind is worth. */
const WEIGHT = { requirement: 3, boundary: 2, access: 2, state: 1, risk: 1 } as const;

/** How many runnable candidates a plan may hold for a given limit. */
export const poolSize = (cap: number) => Math.min(cap * 2, cap + 6);

type Item = { key: string; weight: number; words: string };

/** Everything a scenario would contribute, as weighted items. */
function itemsOf(planned: PlannedScenario): Item[] {
  const items: Item[] = [];
  const requirements = new Set(planned.scenario.assertions.flatMap((a) => [a.requirementId, ...(a.alsoVerifies ?? [])]).filter((id): id is string => !!id));
  for (const id of [...requirements].sort()) items.push({ key: `requirement:${id}`, weight: WEIGHT.requirement, words: `first comparison of ${id}` });
  for (const f of planned.focus ?? []) {
    if (f.aspect === "main-flow") continue;
    const weight = BOUNDARY.includes(f.aspect) ? WEIGHT.boundary : f.aspect === "access-control" || f.aspect === "ownership" ? WEIGHT.access : f.aspect === "regression" ? WEIGHT.risk : WEIGHT.state;
    items.push({ key: `${f.aspect}:${f.requirementId}`, weight, words: `${WORDS[f.aspect]} for ${f.requirementId}` });
  }
  for (const id of planned.riskIds) items.push({ key: `risk:${id}`, weight: WEIGHT.risk, words: `risk ${id}` });
  return items;
}

/**
 * Marks which runnable scenarios run. Those over the limit become "deferred":
 * they stay in the plan whole, with what they alone would have covered.
 */
export function selectScenarios(plan: Plan, cap: number): Plan {
  const candidates = plan.scenarios.filter((s) => s.status === "runnable");
  const declared = candidates.some((s) => (s.focus ?? []).length > 0);
  const covered = new Set<string>();
  const chosen: PlannedScenario[] = [];
  const selection = new Map<string, NonNullable<PlannedScenario["selection"]>>();
  const remaining = [...candidates];

  // Pass 1: the scenarios just below and exactly at each stated threshold.
  // Only positions the planner declared, each backed by one of the scenario's
  // own comparisons, count; nothing is added here that the plan does not hold.
  const DECISIVE: Aspect[] = ["boundary-below", "boundary-at"];
  const decisive = (s: PlannedScenario) => (s.focus ?? []).filter((f) => DECISIVE.includes(f.aspect)).map((f) => `${f.aspect}:${f.requirementId}`);
  const reserved = declared ? Math.min(cap, Math.ceil(cap / 2)) : 0;
  while (chosen.length < reserved) {
    let best: PlannedScenario | undefined;
    let bestNew: Item[] = [];
    let bestScore = -1;
    for (const candidate of remaining) {
      if (!decisive(candidate).some((key) => !covered.has(key))) continue;
      const fresh = itemsOf(candidate).filter((i) => !covered.has(i.key));
      const score = fresh.reduce((sum, i) => sum + i.weight, 0);
      if (score > bestScore) [best, bestNew, bestScore] = [candidate, fresh, score];
    }
    if (!best) break;
    remaining.splice(remaining.indexOf(best), 1);
    chosen.push(best);
    for (const i of itemsOf(best)) covered.add(i.key);
    selection.set(best.scenario.id, { rank: chosen.length, score: bestScore, reasons: ["taken first because it tests a stated threshold at or just below it", ...bestNew.map((i) => i.words)] });
  }

  // Pass 2: what adds most to the scenarios already chosen.
  while (remaining.length > 0 && chosen.length < cap) {
    let best = remaining[0]!;
    let bestNew: Item[] = [];
    let bestScore = -1;
    for (const candidate of remaining) {
      const fresh = itemsOf(candidate).filter((i) => !covered.has(i.key));
      const score = declared ? fresh.reduce((sum, i) => sum + i.weight, 0) : 0;
      // Strictly greater: on a tie the scenario the planner listed first is taken.
      if (score > bestScore) [best, bestNew, bestScore] = [candidate, fresh, score];
    }
    remaining.splice(remaining.indexOf(best), 1);
    chosen.push(best);
    for (const i of itemsOf(best)) covered.add(i.key);
    selection.set(best.scenario.id, {
      rank: chosen.length,
      score: Math.max(bestScore, 0),
      reasons: !declared
        ? ["taken as the planner listed them: the plan declares no focus"]
        : bestNew.length > 0
          ? bestNew.map((i) => i.words)
          : ["adds nothing the chosen scenarios do not already cover; taken as listed"],
    });
  }
  for (const left of remaining) {
    const alone = itemsOf(left).filter((i) => !covered.has(i.key));
    selection.set(left.scenario.id, { score: alone.reduce((sum, i) => sum + i.weight, 0), reasons: alone.map((i) => i.words) });
  }

  // Thresholds: which positions the chosen set probes, and which nobody planned.
  const boundaryGaps: string[] = [];
  const positions = (list: PlannedScenario[]) => new Set(list.flatMap((s) => (s.focus ?? []).filter((f) => BOUNDARY.includes(f.aspect)).map((f) => `${f.aspect}:${f.requirementId}`)));
  const inPool = positions(candidates);
  const inChosen = positions(chosen);
  const thresholds = [...new Set(candidates.flatMap((s) => (s.focus ?? []).filter((f) => BOUNDARY.includes(f.aspect)).map((f) => f.requirementId)))].sort();
  for (const id of thresholds) {
    for (const aspect of BOUNDARY) {
      const key = `${aspect}:${id}`;
      if (!inPool.has(key)) boundaryGaps.push(`${id}: no scenario was planned ${WORDS[aspect]}`);
      else if (!inChosen.has(key)) boundaryGaps.push(`${id}: the scenario ${WORDS[aspect]} was planned and not run`);
    }
  }

  return {
    ...plan,
    scenarios: plan.scenarios.map((s) => {
      const mine = selection.get(s.scenario.id);
      if (!mine) return s;
      return mine.rank === undefined
        ? { ...s, status: "deferred" as const, blockedReason: `Not run: the scenario limit is ${cap} and ${candidates.length} were planned.`, selection: mine }
        : { ...s, selection: mine };
    }),
    selection: { cap, candidates: candidates.length, policy: declared ? "coverage" : "as planned", boundaryGaps },
  };
}
