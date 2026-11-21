import { evaluateFormula, formulaVariables } from "./formula.ts";
import { poolSize, selectScenarios } from "./select.ts";
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
  /** `quoted`: an expected value must itself be stated by the approved text it cites. Set where the plan is not the engine's own. */
  options: { declared?: boolean; quoted?: boolean } = {},
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
    // Runnable candidates may outnumber the limit: code chooses among them below.
    const limit = d.status === "runnable" ? poolSize(maxScenarios) : MAX_BLOCKED;
    if (scenarios.filter((s) => s.status === d.status).length >= limit) {
      // Trimming to size is not a fault in the plan, so it is recorded but
      // does not send the plan back for repair.
      if (d.status === "runnable") trimmedRunnable++;
      trimmed.push(`Scenario ${d.id} was dropped: the plan is limited to ${limit} ${d.status} ${d.status === "runnable" ? "candidates" : "scenarios"}.`);
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
      observations.push({ name: o.name, what: o.what, when: o.when, unit: o.type === "text" ? "plain" : o.unit, ...(o.type === "text" ? { type: "text" as const } : {}) });
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
            const textual = variables.filter((v) => observed.get(v)?.type === "text");
            if (textual.length > 0) {
              fault = `uses ${textual.join(", ")} in its formula, which ${textual.length === 1 ? "holds" : "hold"} text and cannot be calculated with`;
            } else if (undeclared.length > 0) {
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
      if (!fault && options.quoted === true) {
        // The kind of comparison is part of what is expected. "At least", "at most" and
        // "absent" are satisfied by many values, so the approved text must say so itself.
        const said = source.quote.toLowerCase();
        const bound =
          a.kind === "number_at_least"
            ? /\b(at least|or more|minimum|no less than|not less than|or greater|or above)\b/
            : a.kind === "number_at_most"
              ? /\b(at most|or less|maximum|no more than|not more than|up to|or fewer|or below)\b/
              : a.kind === "absent"
                ? /\b(not|no|never|without|hidden|removed|absent|cannot|can't|isn't|doesn't)\b/
                : a.kind === "present"
                  ? /\b(shown|shows|show|displayed|displays|display|visible|appears?|present|sees?|listed|lists)\b/
                  : undefined;
        if (bound && !bound.test(said)) {
          problems.push(`${where} is a "${a.kind}" comparison, and the approved text it cites does not word the requirement that way ("${source.quote.slice(0, 200)}"). It was removed.`);
          continue;
        }
      }
      if (!fault && options.quoted === true && expected && "formula" in expected) {
        // What a calculation means cannot be checked against the text: one can cancel its
        // recorded values and arrive at any number. Until that can be checked, there are none.
        problems.push(`${where} expects a calculated value. In this run an expected value must be written in the approved text itself; calculations are not accepted yet. It was removed.`);
        continue;
      }
      if (!fault && options.quoted === true && expected) {
        // The expected value itself must be in the approved text the comparison
        // cites, not only the requirement. What a plan expects beyond that is its own.
        const missing = notQuoted(expected, source.quote, a.unit ?? "plain");
        if (missing) {
          problems.push(`${where} expects ${missing}, which the approved text it cites does not state ("${source.quote.slice(0, 200)}"); an expected value must be stated by the approved text. It was removed.`);
          clarifications.push({ scenarioId: d.id, question: `What is the intended outcome for: ${a.description}? The approved text cited does not state the value expected.` });
          continue;
        }
      }
      if (fault) {
        problems.push(`${where} ${fault}; it was removed.`);
        continue;
      }
      assertionIds.add(a.id);
      // Further requirements the comparison is credited to. Only approved,
      // uncontested ones count; anything else is dropped and noted.
      // Where the expected value must be stated by the text cited, a comparison is credited to that text alone.
      if (options.quoted === true && (a.alsoVerifies ?? []).some((id) => id !== a.requirementId)) {
        trimmed.push(`${where} lists further requirements as also verified. In this run a comparison counts for the requirement it cites and no other; the links were removed.`);
      }
      const alsoVerifies = [...new Set(options.quoted === true ? [] : (a.alsoVerifies ?? []))].filter((id) => {
        const other = requirement.get(id);
        const usable = id !== a.requirementId && other?.kind === "documented" && other.trust === "authoritative" && !other.contested;
        if (!usable && id !== a.requirementId) trimmed.push(`${where} lists "${id}" as also verified, which is not an approved requirement; the link was removed.`);
        return usable;
      });
      // The stated examples this comparison runs: only those of its own requirement.
      const own = new Set((requirement.get(a.requirementId)?.examples ?? []).map((e) => e.id));
      const exampleIds = [...new Set(a.exampleIds ?? [])].filter((id) => {
        if (!own.has(id)) trimmed.push(`${where} cites example "${id}", which is not an example of ${a.requirementId}; the citation was removed.`);
        return own.has(id);
      });
      const numeric = a.kind === "number_equals" || a.kind === "number_at_least" || a.kind === "number_at_most";
      // An assertion about an earlier moment compares what was recorded then.
      // The observation must exist in the plan and be of the kind compared.
      const about = a.actualObservation ? observed.get(a.actualObservation) : undefined;
      if (a.actualObservation) {
        const unitOfExpected = a.unit ?? "plain";
        const fault = !about
          ? `is about observation "${a.actualObservation}", which the scenario does not declare`
          : a.kind === "present" || a.kind === "absent"
            ? "is a presence check, which cannot be about a recorded observation"
            : numeric !== (about.type !== "text")
              ? `compares ${numeric ? "a number" : "text"} with observation "${about.name}", which holds ${about.type === "text" ? "text" : "a number"}`
              : numeric && about.unit !== unitOfExpected && about.unit !== "plain" && unitOfExpected !== "plain"
                ? `expects a value in ${unitOfExpected} and is about observation "${about.name}", recorded in ${about.unit}`
                : expected && "formula" in expected && expected.formula.trim() === about.name
                  ? `compares observation "${about.name}" with itself`
                  : undefined;
        if (fault) {
          problems.push(`${where} ${fault}; it was removed.`);
          continue;
        }
      }
      assertions.push({
        id: a.id,
        description: a.description,
        kind: a.kind,
        ...(numeric && a.unit && a.unit !== "plain" ? { unit: a.unit } : {}),
        ...(a.subject && a.subject !== "value" && a.kind !== "present" && a.kind !== "absent" && !about ? { subject: a.subject } : {}),
        ...(about ? { actual: { observation: about.name } } : {}),
        expected,
        requirementId: a.requirementId,
        ...(alsoVerifies.length ? { alsoVerifies } : {}),
        ...(exampleIds.length ? { exampleIds } : {}),
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

    // A scenario is credited with probing a requirement only where one of its
    // own comparisons rests on that requirement. A tag alone covers nothing.
    const compared = new Set(assertions.flatMap((a) => [a.requirementId, ...(a.alsoVerifies ?? [])]));
    const focus: NonNullable<PlannedScenario["focus"]> = [];
    for (const f of d.focus ?? []) {
      if (status !== "runnable") continue;
      if (!compared.has(f.requirementId)) {
        trimmed.push(`Scenario ${d.id} claims to probe ${f.requirementId} (${f.aspect}) without a comparison that rests on it; the claim was removed.`);
      } else if (!focus.some((x) => x.requirementId === f.requirementId && x.aspect === f.aspect)) {
        focus.push({ requirementId: f.requirementId, aspect: f.aspect });
      }
    }

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
      ...(focus.length > 0 ? { focus } : {}),
    });
  }
  // More candidates than may run: code chooses, and the rest stay in the plan as deferred.
  const plan = selectScenarios(
    { scenarios, notes: [...problems, ...trimmed], clarifications, trimmedRunnable },
    maxScenarios,
    analysis.requirements.filter((r) => r.kind === "documented").flatMap((r) => (r.examples ?? []).map((e) => ({ ...e, requirementId: r.id }))),
  );
  return { plan, problems };
}

// A number as the text writes it. It ends where its digits end: "160px" states no number, and neither does a part of "1600".
// Not a number the text states either: part of a reference ("KAN-160", "#160"), of a fraction, a range, a date or a time.
const QUOTED_NUMBER = /(?<![\p{L}\p{N}_.,#/:]|[\p{L}\p{N}]-)-?\d+(?:,\d{3})*(?:\.\d+)?(?![\p{L}\p{N}_/:]|[.,]\d|-\d)/gu;
/** A list marker at the start of a line ("2. After…") numbers the line; it states nothing. */
const unnumbered = (quote: string) =>
  quote
    // Every kind of hyphen and dash reads as one: "KAN‑160" and "100–160" are a reference and a range too.
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/^[ \t]*\d+[.)][ \t]+(?=\S)/gm, "");

/**
 * Says what part of an expected value the quoted text does not state, if any.
 * A number must be written in the text, in the unit expected or as the same
 * amount in whole units or hundredths. A text must be in it word for word. A
 * formula may calculate with recorded values, but every number written in it
 * must be in the text (as written, or as a percentage of it).
 */
export function notQuoted(expected: NonNullable<Assertion["expected"]>, quote: string, unit: string): string | undefined {
  quote = unnumbered(quote);
  const stated = (quote.match(QUOTED_NUMBER) ?? []).map((n) => Number(n.replace(/,/g, "")));
  const has = (n: number, scales: number[]) => stated.some((s) => scales.some((scale) => Math.abs(s * scale - n) < 1e-9));
  if ("literal" in expected) {
    if (typeof expected.literal === "number") {
      // An amount in hundredths may be written in whole units, and only an amount: a number with a decimal point.
      const amounts = (quote.match(QUOTED_NUMBER) ?? []).filter((n) => /\.\d{2}$/.test(n)).map((n) => Number(n.replace(/,/g, "")));
      const converted = unit === "currency-hundredths" && amounts.some((s) => Math.abs(s * 100 - Number(expected.literal)) < 1e-9);
      return has(expected.literal, [1]) || converted ? undefined : `the number ${expected.literal}`;
    }
    const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = squash(expected.literal);
    // Whole words, and enough of them to be a statement: "active" is not stated by "inactive".
    const found = wanted.length >= 4 && new RegExp(`(?<![\\p{L}\\p{N}])${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(squash(quote));
    return found ? undefined : `the text ${JSON.stringify(expected.literal.slice(0, 80))}`;
  }
  // A calculation with no recorded value in it is a number of the plan's own making.
  if (formulaVariables(expected.formula).length === 0) return "a calculation that uses no recorded value";
  // Numbers written in the formula. A name such as "total2" is a recorded value, not a number.
  const written = (expected.formula.match(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_.])/gu) ?? []).map(Number);
  // As written, or as the fraction of a stated percentage (20 percent is 0.2).
  const absent = written.filter((n) => !has(n, [1, 0.01]));
  return absent.length > 0 ? `a calculation with ${absent.join(", ")}` : undefined;
}
