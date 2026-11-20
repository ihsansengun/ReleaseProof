import type { SessionJob } from "../execute/loop.ts";
import { replaySteps } from "../execute/replay.ts";
import type { Session } from "../execute/tools.ts";
import type { PlanDraft, RunReport, Usage } from "../schema.ts";
import type { Driver, TaskJob } from "./driver.ts";

/** Turns a validated plan back into the flat shape a model would have produced. */
export function planToDraft(plan: RunReport["plan"]): PlanDraft {
  return {
    scenarios: plan.scenarios.map((p) => ({
      id: p.scenario.id,
      title: p.scenario.title,
      basis: p.scenario.basis === "risk" ? "risk" : "requirement",
      requirementIds: p.scenario.requirementIds,
      riskIds: p.riskIds,
      intent: p.scenario.intent,
      setup: p.scenario.setup ?? "",
      fixtures: Object.entries(p.scenario.fixtures).map(([alias, type]) => ({ alias, type })),
      observations: (p.scenario.observations ?? []).map((o) => ({ name: o.name, what: o.what, when: o.when, unit: o.unit ?? "plain", ...(o.type ? { type: o.type } : {}) })),
      ...(p.focus ? { focus: p.focus } : {}),
      // A deferred scenario was runnable when planned; the selection is made again by code.
      status: p.status === "deferred" ? "runnable" : p.status,
      blockedReason: p.blockedReason,
      ambiguityIds: p.ambiguityIds,
      assertions: p.scenario.assertions.map((a) => ({
        id: a.id,
        description: a.description,
        kind: a.kind,
        expectedNumber: a.expected && "literal" in a.expected && typeof a.expected.literal === "number" ? a.expected.literal : null,
        expectedText: a.expected && "literal" in a.expected && typeof a.expected.literal === "string" ? a.expected.literal : null,
        expectedFormula: a.expected && "formula" in a.expected ? a.expected.formula : null,
        unit: a.unit ?? "plain",
        ...(a.subject ? { subject: a.subject } : {}),
        ...(a.actual ? { actualObservation: a.actual.observation } : {}),
        requirementId: a.requirementId ?? "",
        alsoVerifies: a.alsoVerifies ?? [],
        ...(a.exampleIds?.length ? { exampleIds: a.exampleIds } : {}),
      })),
    })),
  };
}

/**
 * Stands in for a model by replaying what a model did in an earlier real run:
 * its analysis, its plan and each scenario's recorded steps. No model is
 * involved, so nothing here adapts to the application: a recording that no
 * longer fits ends as unverified. Reports must say this driver was used.
 */
export class RecordedDriver implements Driver {
  readonly label: string;
  readonly live = false;

  constructor(private recording: RunReport) {
    this.label = `recorded responses from the ${recording.ticketKey} run of ${recording.startedAt.slice(0, 10)} (no live model)`;
  }

  async task<T>(job: TaskJob<T>): Promise<T> {
    if (job.name === "analyse") {
      // Older recordings name no source: the quote is then located in code,
      // and takes its trust from wherever it is actually found.
      const a = this.recording.analysis;
      return job.schema.parse({
        ...a,
        requirements: a.requirements.map((r) => ({
          ...r,
          kind: r.kind === "inferred" ? "inferred" : "documented",
          sourceId: r.sourceId ?? "",
          relation: r.relation ?? "none",
          relatedRequirementId: r.relatedRequirementId ?? "",
        })),
        // Only what the model proposed is replayed; owners' own lines are found again by code.
        supersessions: (a.supersessions ?? []).filter((s) => s.how === "inferred"),
        contradictions: a.contradictions ?? [],
      });
    }
    if (job.name === "plan" || job.name === "plan-repair") return job.schema.parse(planToDraft(this.recording.plan));
    throw new Error(`The recording has no answer for task "${job.name}".`);
  }

  async session(session: Session, job: SessionJob & { name: string }): Promise<Usage | undefined> {
    const recorded = this.recording.results.find((r) => r.scenarioId === job.name);
    if (!recorded) {
      session.outcome = { kind: "blocked", reason: `The recording holds no steps for "${job.name}".` };
      return undefined;
    }
    await replaySteps(session, recorded.steps);
    return undefined;
  }

  async close(): Promise<void> {}
}
