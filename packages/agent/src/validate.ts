import { evaluateFormula, formulaVariables } from "./formula.ts";
import type { Analysis, Assertion, Manifest, Observation, Plan, PlanDraft, PlannedScenario } from "./schema.ts";

/** Blocked scenarios are not executed, so the allowance for them is generous. */
const MAX_BLOCKED = 20;

/**
 * Checks a drafted plan against rules that must hold whatever the model
 * wrote, and returns the plan with offending parts removed or blocked.
 * `problems` lists everything found, for a repair attempt and for the record.
 */
export function validatePlan(
  draft: PlanDraft,
  analysis: Analysis,
  manifest: Manifest,
  maxScenarios: number,
  /** `declared`: formulas may only use observations the plan declares. Set for a live model; off for plans recorded before that rule. */
  options: { declared?: boolean } = {},
): { plan: Plan; problems: string[] } {
  const problems: string[] = [];
  const trimmed: string[] = [];
  let trimmedRunnable = 0;
  const clarifications: Plan["clarifications"] = [];
  const requirement = new Map(analysis.requirements.map((r) => [r.id, r]));
  const ambiguityIds = new Set(analysis.ambiguities.map((a) => a.id));
  const riskIds = new Set(analysis.risks.map((k) => k.id));
  const scenarios: PlannedScenario[] = [];
  const seen = new Set<string>();

  for (const d of draft.scenarios) {
    if (!/^[A-Za-z0-9_-]+$/.test(d.id) || seen.has(d.id)) {
      problems.push(`Scenario id "${d.id}" is duplicated or not a simple identifier; the scenario was dropped.`);
      continue;
    }
    // The limit is on what gets executed. Blocked scenarios cost nothing to
    // keep and are results in their own right, so they have their own allowance.
    const limit = d.status === "runnable" ? maxScenarios : MAX_BLOCKED;
    if (scenarios.filter((s) => s.status === d.status).length >= limit) {
      // Trimming to size is not a fault in the plan, so it is recorded but
      // does not send the plan back for repair.
      if (d.status === "runnable") trimmedRunnable++;
      trimmed.push(`Scenario ${d.id} was dropped: the plan is limited to ${limit} ${d.status} scenarios.`);
      continue;
    }
    seen.add(d.id);

    let status = d.status;
    let blockedReason = d.blockedReason.trim();
    const block = (reason: string) => {
      status = "blocked";
      blockedReason = blockedReason ? `${blockedReason} ${reason}` : reason;
    };
    const known = (ids: string[], valid: { has(id: string): boolean }, what: string) =>
      ids.filter((id) => {
        if (valid.has(id)) return true;
        problems.push(`Scenario ${d.id} refers to unknown ${what} "${id}"; the reference was removed.`);
        return false;
      });

    const fixtures: Record<string, string> = {};
    for (const f of d.fixtures) {
      if (!manifest.fixtures[f.type] && !manifest.accounts[f.type]) {
        problems.push(`Scenario ${d.id} needs a "${f.type}" fixture, which this environment does not declare.`);
        block(`Needs test data of type "${f.type}", which the environment cannot prepare.`);
      } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(f.alias) || fixtures[f.alias]) {
        problems.push(`Scenario ${d.id} has an unusable or repeated fixture alias "${f.alias}".`);
      } else {
        fixtures[f.alias] = f.type;
      }
    }

    // Every value a formula uses is declared, with the one moment it is read at.
    const observations: Observation[] = [];
    for (const o of d.observations ?? []) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(o.name) || observations.some((x) => x.name === o.name)) {
        problems.push(
          `Scenario ${d.id} declares observation "${o.name}" more than once or with an unusable name. One name is one moment: the same value read at two moments needs two names.`,
        );
        continue;
      }
      observations.push({ name: o.name, what: o.what, when: o.when, unit: o.unit });
    }
    const observed = new Map(observations.map((o) => [o.name, o]));
    // Plans recorded before observations were declared carry none; their formulas are taken as they are.
    const declares = options.declared === true || (d.observations ?? []).length > 0;

    const assertions: Assertion[] = [];
    const assertionIds = new Set<string>();
    let contested = false;
    for (const a of d.assertions) {
      const where = `Assertion ${d.id}/${a.id}`;
      if (assertionIds.has(a.id)) {
        problems.push(`${where} repeats an id; it was removed.`);
        continue;
      }
      // An expected value may rest only on a requirement that code attributed
      // to an authoritative source. What the plan says about it is not read.
      const source = requirement.get(a.requirementId);
      const authoritative =
        source?.kind === "documented" && source.trust === "authoritative" && source.sourceId !== undefined && source.origin !== undefined;
      if (source && authoritative && source.contested) {
        problems.push(`${where} cites ${a.requirementId}, which contradicts another approved requirement and has not been settled; it cannot set an expected value. It was removed.`);
        clarifications.push({
          scenarioId: d.id,
          question: `Which approved rule holds for: ${a.description}? ${a.requirementId} ("${source.quote}") is contradicted by another approved requirement.`,
        });
        contested = true;
        continue;
      }
      if (!source || !authoritative) {
        const what = !source
          ? `unknown requirement "${a.requirementId}"`
          : source.kind === "claimed"
            ? `${a.requirementId}, which is a claim from ${source.trust ?? "unapproved"} material, not an approved requirement`
            : `${source.kind} requirement ${a.requirementId}`;
        problems.push(`${where} cites ${what}; an expected value must come from an approved requirement. It was removed.`);
        clarifications.push({
          scenarioId: d.id,
          question: `What is the intended outcome for: ${a.description}? No approved requirement source states it.`,
        });
        continue;
      }
      const provenance = { sourceId: source.sourceId!, trust: "authoritative" as const, origin: source.origin!, quote: source.quote };

      let expected: Assertion["expected"];
      let fault: string | undefined;
      if (a.kind === "number_equals" || a.kind === "number_at_least" || a.kind === "number_at_most") {
        if ((a.expectedNumber === null) === (a.expectedFormula === null)) {
          fault = "needs exactly one of expectedNumber and expectedFormula";
        } else if (a.expectedNumber !== null) {
          expected = { literal: a.expectedNumber };
        } else {
          try {
            const formula = a.expectedFormula!;
            const variables = formulaVariables(formula);
            evaluateFormula(formula, Object.fromEntries(variables.map((v) => [v, 1])));
            expected = { formula };
            const unit = a.unit ?? "plain";
            const undeclared = declares ? variables.filter((v) => !observed.has(v)) : [];
            // A formula may combine values of the assertion's own unit with plain
            // numbers. Anything else would add or compare amounts in different units.
            const mixed = variables.filter((v) => observed.has(v) && observed.get(v)!.unit !== "plain" && observed.get(v)!.unit !== unit);
            if (undeclared.length > 0) {
              fault = `uses ${undeclared.join(", ")} in its formula without declaring ${undeclared.length === 1 ? "it as an observation" : "them as observations"} with the moment to record ${undeclared.length === 1 ? "it" : "them"}`;
            } else if (mixed.length > 0) {
              fault = `combines ${mixed.map((v) => `${v} (${observed.get(v)!.unit})`).join(", ")} with an expected value in ${unit}; values in different units cannot be compared`;
              clarifications.push({ scenarioId: d.id, question: `In which unit is this value shown: ${a.description}?` });
            }
          } catch (error) {
            fault = `has a formula that cannot be evaluated (${(error as Error).message})`;
          }
        }
      } else if (a.kind === "text_equals" || a.kind === "text_contains") {
        if (!a.expectedText) fault = "needs expectedText";
        else expected = { literal: a.expectedText };
      }
      if (fault) {
        problems.push(`${where} ${fault}; it was removed.`);
        continue;
      }
      assertionIds.add(a.id);
      // Further requirements the comparison is credited to. Only approved,
      // uncontested ones count; anything else is dropped and noted.
      const alsoVerifies = [...new Set(a.alsoVerifies ?? [])].filter((id) => {
        const other = requirement.get(id);
        const usable = id !== a.requirementId && other?.kind === "documented" && other.trust === "authoritative" && !other.contested;
        if (!usable && id !== a.requirementId) trimmed.push(`${where} lists "${id}" as also verified, which is not an approved requirement; the link was removed.`);
        return usable;
      });
      const numeric = a.kind === "number_equals" || a.kind === "number_at_least" || a.kind === "number_at_most";
      assertions.push({
        id: a.id,
        description: a.description,
        kind: a.kind,
        ...(numeric && a.unit && a.unit !== "plain" ? { unit: a.unit } : {}),
        expected,
        requirementId: a.requirementId,
        ...(alsoVerifies.length ? { alsoVerifies } : {}),
        provenance,
      });
    }

    if (status === "runnable" && assertions.length === 0) {
      problems.push(`Scenario ${d.id} is marked runnable but has no usable assertion; it is blocked.`);
      block(
        contested
          ? "The approved requirements this scenario rests on contradict each other; a requirement owner must say which holds."
          : "No approved requirement states the expected outcome of this scenario.",
      );
    }
    if (status === "blocked" && !blockedReason) blockedReason = "The plan gave no reason.";

    scenarios.push({
      scenario: {
        id: d.id,
        title: d.title,
        basis: d.basis,
        requirementIds: known(d.requirementIds, requirement, "requirement"),
        intent: d.intent,
        setup: d.setup?.trim() || undefined,
        fixtures,
        ...(declares ? { observations } : {}),
        assertions: status === "runnable" ? assertions : [],
      },
      status,
      blockedReason: status === "blocked" ? blockedReason : "",
      ambiguityIds: known(d.ambiguityIds, ambiguityIds, "ambiguity"),
      riskIds: known(d.riskIds, riskIds, "risk"),
    });
  }
  return { plan: { scenarios, notes: [...problems, ...trimmed], clarifications, trimmedRunnable }, problems };
}
