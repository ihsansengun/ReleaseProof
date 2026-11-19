import { evaluateFormula, formulaVariables } from "./formula.ts";
import type { Analysis, Assertion, Manifest, Plan, PlanDraft, PlannedScenario } from "./schema.ts";

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
      if (!manifest.fixtures[f.type]) {
        problems.push(`Scenario ${d.id} needs a "${f.type}" fixture, which this environment does not declare.`);
        block(`Needs test data of type "${f.type}", which the environment cannot prepare.`);
      } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(f.alias) || fixtures[f.alias]) {
        problems.push(`Scenario ${d.id} has an unusable or repeated fixture alias "${f.alias}".`);
      } else {
        fixtures[f.alias] = f.type;
      }
    }

    const assertions: Assertion[] = [];
    const assertionIds = new Set<string>();
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
            evaluateFormula(formula, Object.fromEntries(formulaVariables(formula).map((v) => [v, 1])));
            expected = { formula };
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
      assertions.push({ id: a.id, description: a.description, kind: a.kind, expected, requirementId: a.requirementId, provenance });
    }

    if (status === "runnable" && assertions.length === 0) {
      problems.push(`Scenario ${d.id} is marked runnable but has no usable assertion; it is blocked.`);
      block("No approved requirement states the expected outcome of this scenario.");
    }
    if (status === "blocked" && !blockedReason) blockedReason = "The plan gave no reason.";

    scenarios.push({
      scenario: {
        id: d.id,
        title: d.title,
        basis: d.basis,
        requirementIds: known(d.requirementIds, requirement, "requirement"),
        intent: d.intent,
        fixtures,
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
