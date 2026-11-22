/**
 * The result of a remote run: one file, written by the engine, that says what
 * the run found. It is the only place a run-level verdict is stated, and
 * nothing that reads it may work one out for itself.
 *
 * The file follows the result contract's format version 1: `formatVersion`,
 * `runId` and `verdict` are where that version puts them, and everything else
 * is additional. Fields can be added without a new version. A reader that
 * does not know a field leaves it alone.
 *
 * Two things are kept apart throughout, because they are different facts:
 *
 *   OBSERVED  what the comparisons that were made showed. A comparison that
 *             matched is an observation: this element showed this value.
 *   VERIFIED  that an approved requirement holds. That needs more than an
 *             observation: it needs the expected value and the element read
 *             to be the ones the approved text means.
 *
 * While `verdictsTrusted` is false, an observation is never reported as a
 * verification. The run-level verdict is then never "passed", and no
 * requirement is "verified": where the comparisons alone would say so, the
 * result says "unverified" and gives the observation beside it. A mismatch,
 * an error and a blocked run are reported as they are: nobody releases on
 * those, and softening them would hide what was seen.
 *
 * A screenshot, a trace or any other captured file is evidence of what the
 * browser showed. Its presence proves nothing about a requirement, and this
 * file never derives a status from one.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { assess, type RequirementStatus } from "../report/readiness.ts";
import type { ScenarioResult, Verdict } from "../schema.ts";
import type { RemoteRun } from "./run.ts";

/** The result contract's format version this file follows. */
export const REMOTE_RESULT_FORMAT_VERSION = 1;
/** The version of the additional fields below. Raised when one of them changes meaning. */
export const REMOTE_RESULT_SCHEMA = 1;

/** The size of the page in a remote run. Set by the run, so that the result can say it. */
export const REMOTE_VIEWPORT = { width: 1280, height: 720 } as const;

/** How far the run got. A run that completed can still have failed or unverified requirements. */
export type ExecutionStatus = "completed" | "ended early" | "nothing executed";

export type Telemetry = "collected" | "not collected";

export type RemoteResult = {
  formatVersion: 1;
  runId: string;
  /** The engine's verdict on the run. Never "passed" while `verdictsTrusted` is false. */
  verdict: Verdict;
  /**
   * Whether "passed" and "verified" in this file may be taken as statements
   * about the approved requirements. False for every run for now.
   */
  verdictsTrusted: boolean;
  /** Why the verdict is what it is, and what the comparisons alone showed. */
  verdictBasis: {
    /** What the comparisons made would give by the same rule, trusted or not. An observation, not a verdict. */
    observed: Verdict;
    reason: string;
    /** Set when `verdict` differs from `observed`: why an observation was not taken as a verdict. */
    notTrustedBecause?: string;
  };
  executionStatus: ExecutionStatus;
  endedEarly?: { reason: string };
  /** What produced this file. */
  producer: { name: "releaseproof-engine"; resultSchema: number; kind: "remote-run"; executionMode: RemoteRun["executionMode"] };
  workspaceId: string;
  projectId: string;
  title: string;
  summary: string;
  target: RemoteRun["target"];
  /** The approved criteria snapshots the run used. */
  snapshots: RemoteRun["snapshots"];
  /** How many requirements ended in each status, and how much of the plan ran. */
  coverage: {
    requirements: { total: number } & Record<"verified" | "failed" | "errored" | "blocked" | "unverified" | "exercised" | "deferred" | "notPlanned", number>;
    /** Requirements whose comparisons all matched but are not counted as verified, because the result is not trusted. */
    observedOnly: number;
    scenarios: { planned: number; executed: number; notExecuted: number };
  };
  requirements: {
    id: string;
    /** The status the engine states. Never "verified" while `verdictsTrusted` is false. */
    status: RequirementStatus;
    /** What the comparisons alone showed for this requirement. An observation. */
    observedStatus: RequirementStatus;
    text: string;
    reason: string;
    /** Expected and observed values of the comparisons tied to this requirement, as text. Empty when none was made. */
    expected: string;
    observed: string;
    source: { document: string; revision: string; approvedBy: string; approvedAt: string } | null;
    stepIds: string[];
  }[];
  steps: {
    id: string;
    scenarioId: string;
    action: string;
    target: string;
    outcome: "ok" | "mismatch" | "error";
    requirementIds: string[];
    note: string;
    /** When the step began, in milliseconds from the start of the run's first scenario, and how long it took. Absent when not timed. */
    atMs?: number;
    durationMs?: number;
    /** A screenshot taken at this step, by the id of an entry in `evidence`. */
    screenshot?: { evidenceId: string };
  }[];
  profiles: { name: string; viewport: string; state: "tested" | "not run"; reason: string }[];
  /** For each kind of evidence, whether this run collected it. Anything not collected is absent, never empty-as-if-clean. */
  telemetry: Record<"screenshots" | "recording" | "trace" | "console" | "network" | "analytics" | "webVitals", Telemetry>;
  /**
   * Console errors and failed requests, each tied to the step during which it happened. Only errors and
   * failures are kept: an empty list beside "collected" means the run listened and heard none.
   */
  diagnostics: {
    console: { stepId: string; level: "error" | "uncaught"; text: string }[];
    /** `status` 0 means the request got no answer. `path` has no query, fragment or host. */
    network: { stepId: string; method: string; path: string; status: number; kind: string; failure?: string }[];
    analytics: unknown[];
  };
  /** How many pictures and entries the size limits left out. All zero when none was. */
  evidenceLimits: { leftOut: { screenshots: number; console: number; network: number } };
  /** Files the run wrote, by a path inside the run's output directory. What each shows, not what it proves. */
  evidence: { id: string; label: string; mediaType: string; path: string; scenarioId: string }[];
  /** For fields a later engine adds before they are part of this schema. */
  extensions: Record<string, unknown>;
};

/** First match wins: the worst outcome decides. */
const WORST_FIRST: Verdict[] = ["failed", "errored", "blocked", "unverified", "passed"];

const NOT_TRUSTED =
  "Which element a comparison reads is still chosen by the recording, and is not yet tied to the approved text. A match shows what the application displayed there, not that the requirement holds.";

type Compared = { expected: string; observed: string }[];
const matched = (made: Compared) => `${made.length} ${made.length === 1 ? "comparison" : "comparisons"} tied to this requirement matched.`;
const REASON: Record<RequirementStatus, (made: Compared) => string> = {
  verified: matched,
  failed: () => "A comparison tied to this requirement did not match.",
  errored: () => "The application answered with an error before this requirement could be compared.",
  blocked: () => "A scenario that compares this requirement could not go on.",
  unverified: (made) => (made.length > 0 ? "Not everything this requirement needs was compared." : "No comparison of this requirement was made."),
  exercised: () => "A scenario that ran lists this requirement, but no comparison is tied to it.",
  deferred: () => "Compared only by a scenario that was planned and not run because of the scenario limit.",
  "not planned": () => "No scenario in the plan compares this requirement.",
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The id of a file of evidence: the same for the same file of the same run,
 * and in the form the result contract asks of an evidence id.
 */
export function evidenceIdOf(runId: string, stepId: string, kind: string): string {
  const hex = createHash("sha256").update(["releaseproof-evidence-v1", runId, stepId, kind].join("\n"), "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The steps an executor can take. Anything else a recording calls a step is not named here. */
const ACTIONS = new Set(["navigate", "click", "fill", "select", "press", "upload", "api_request", "observe", "check", "finish"]);
const LOCATED_BY = new Set(["role", "label", "text", "testid", "labelled", "cell"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Console entries, and network entries, taken from one scenario. The same number the collector keeps. */
const ENTRIES = 200;
/** How much of a recording's own words (a locator, a path) is shown. Enough to tell steps apart. */
const WORDS = 80;

/**
 * Where a step went or what it pointed at, in a form that carries as little
 * of the recording's own text as says which step it was. A path is given
 * without its query, fragment, parameters or any host; a locator by its kind
 * and a short part of its words. What was typed, sent or answered is never
 * part of it.
 */
function describeTarget(input: unknown): string {
  const given = (input !== null && typeof input === "object" ? input : {}) as { path?: unknown; method?: unknown; element?: unknown; target?: unknown };
  if (typeof given.path === "string") {
    let pathname = "";
    try {
      pathname = new URL(given.path, "http://target.invalid").pathname;
    } catch {
      pathname = "";
    }
    const plain = pathname.split(";")[0] ?? "";
    const cut = plain !== given.path;
    const method = typeof given.method === "string" && METHODS.has(given.method) ? `${given.method} ` : "";
    return `${method}${clip(plain, WORDS)}${cut ? " (rest of the address not shown)" : ""}`;
  }
  const element = (given.element ?? given.target) as { source?: unknown; by?: unknown; role?: unknown; value?: unknown; responseId?: unknown } | undefined;
  if (element === undefined || element === null || typeof element !== "object") return "";
  if (element.source === "api") return typeof element.responseId === "string" && /^R\d{1,4}$/.test(element.responseId) ? `the answer ${element.responseId}` : "an answer";
  if (typeof element.by !== "string" || !LOCATED_BY.has(element.by)) return "";
  const role = typeof element.role === "string" && /^[a-z]{1,20}$/.test(element.role) ? ` ${element.role}` : "";
  return `${element.by}${role} "${clip(typeof element.value === "string" ? element.value : "", WORDS)}"`;
}

/**
 * Builds the result of a remote run from its record. Pure: it reads nothing
 * but the record, and states nothing the record does not hold.
 */
export function remoteResult(run: RemoteRun): RemoteResult {
  // Taken from the record, where nothing can yet set it to true.
  const trusted: boolean = (run.verdictsTrusted as unknown) === true;
  const executed = run.results.filter((result) => result.steps.length > 0);
  const assessment = assess({ analysis: run.analysis, plan: run.plan, results: run.results });

  // What the comparisons alone give, by the rule that the worst outcome decides.
  const planned = run.plan.scenarios.filter((planned) => planned.status === "runnable");
  const ran = new Set(executed.map((result) => result.scenarioId));
  const compared = (result: ScenarioResult | undefined, assertionId: string) => result?.assertionResults.some((made) => made.assertionId === assertionId) === true;
  const incomplete =
    run.endedEarly !== undefined ||
    planned.length === 0 ||
    // Every planned scenario, by its own id, ran exactly once, and made every comparison it planned.
    run.results.length !== planned.length ||
    executed.length !== planned.length ||
    new Set(planned.map((scenario) => scenario.scenario.id)).size !== planned.length ||
    planned.some((scenario) => !ran.has(scenario.scenario.id) || scenario.scenario.assertions.some((assertion) => !compared(run.results.find((result) => result.scenarioId === scenario.scenario.id), assertion.id))) ||
    run.plan.scenarios.some((scenario) => scenario.status !== "runnable") ||
    // Whatever else the assessment holds against the run: scenarios dropped under the limit, unresolved conflicts, no approved requirement.
    assessment.readiness !== "ready" ||
    assessment.requirements.some((requirement) => requirement.status !== "verified");
  const worst = WORST_FIRST.find((verdict) => run.results.some((result) => result.verdict === verdict)) ?? "unverified";
  const observed: Verdict = worst === "passed" && incomplete ? "unverified" : worst;
  const verdict: Verdict = observed === "passed" && !trusted ? "unverified" : observed;

  const snapshotOf = new Map(run.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const documented = new Map(run.analysis.requirements.map((requirement) => [requirement.id, requirement]));

  // Steps, each with an id of its own, and the comparisons each check step made.
  const steps: RemoteResult["steps"] = [];
  const evidence: RemoteResult["evidence"] = [];
  const consoleEntries: RemoteResult["diagnostics"]["console"] = [];
  const networkEntries: RemoteResult["diagnostics"]["network"] = [];
  const leftOut = { screenshots: 0, console: 0, network: 0 };
  const firstStarted = Math.min(...executed.map((result) => Date.parse(result.startedAt)).filter((time) => Number.isFinite(time)), Number.MAX_SAFE_INTEGER);
  // Console and network count as collected only if every scenario that ran collected them.
  const listened = executed.length > 0 && executed.every((result) => result.capture !== undefined);
  const stepsOf = new Map<string, string[]>();
  const comparisonsOf = new Map<string, { expected: string; observed: string }[]>();
  for (const result of executed) {
    const assertions = new Map(run.plan.scenarios.find((planned) => planned.scenario.id === result.scenarioId)?.scenario.assertions.map((assertion) => [assertion.id, assertion]) ?? []);
    const compared = new Map(result.assertionResults.map((made) => [made.assertionId, made]));
    // Times are given from the start of the first scenario, so that steps of a later one come later.
    const begun = Date.parse(result.startedAt);
    const started = Number.isFinite(begun) ? Math.max(0, begun - firstStarted) : Number.NaN;
    // What was collected is taken in again here by its own rules, not on trust: this file is what leaves the
    // machine, whoever wrote the record it is built from. An entry that does not fit is left out and counted.
    const stepOf = (value: unknown) => `${result.scenarioId}-${Math.min(Math.max(1, Number.isInteger(value) ? (value as number) : 1), Math.max(1, result.steps.length))}`;
    const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, 1_000_000) : 0);
    const said = Array.isArray(result.capture?.console) ? result.capture.console : [];
    const asked = Array.isArray(result.capture?.network) ? result.capture.network : [];
    for (const entry of said.slice(0, ENTRIES)) {
      if ((entry?.level !== "error" && entry?.level !== "uncaught") || typeof entry.text !== "string") leftOut.console += 1;
      else consoleEntries.push({ stepId: stepOf(entry.step), level: entry.level, text: clip(entry.text, 300) });
    }
    for (const entry of asked.slice(0, ENTRIES)) {
      const status = Number.isInteger(entry?.status) && entry.status >= 0 && entry.status <= 599 ? entry.status : undefined;
      if (status === undefined || typeof entry.path !== "string" || !/^\/[^?#\s]*$/.test(entry.path)) {
        leftOut.network += 1;
        continue;
      }
      networkEntries.push({
        stepId: stepOf(entry.step),
        method: typeof entry.method === "string" && METHODS.has(entry.method) ? entry.method : "OTHER",
        path: clip(entry.path, 200),
        status,
        kind: typeof entry.kind === "string" && /^[a-z]{1,20}$/.test(entry.kind) ? entry.kind : "other",
        ...(typeof entry.failure === "string" && entry.failure !== "" ? { failure: clip(entry.failure, 300) } : {}),
      });
    }
    leftOut.screenshots += count(result.capture?.leftOut?.screenshots);
    leftOut.console += count(result.capture?.leftOut?.console) + Math.max(0, said.length - ENTRIES);
    leftOut.network += count(result.capture?.leftOut?.network) + Math.max(0, asked.length - ENTRIES);
    result.steps.forEach((step, index) => {
      const id = `${result.scenarioId}-${index + 1}`;
      const assertionId = step.tool === "check" ? (step.input as { assertionId?: string } | null)?.assertionId : undefined;
      const made = assertionId && step.ok ? compared.get(assertionId) : undefined;
      const requirementId = assertionId ? assertions.get(assertionId)?.requirementId : undefined;
      const requirementIds = requirementId ? [requirementId] : [];
      // The picture taken after this step, where the run collected one. A picture taken at a comparison by the
      // shared code stays in the run's directory: it is of the whole page and nothing in it is covered.
      const captured = Array.isArray(result.capture?.steps) ? result.capture.steps.find((entry) => entry?.step === index + 1) : undefined;
      let screenshot: RemoteResult["steps"][number]["screenshot"];
      if (typeof captured?.screenshot === "string" && /^step-\d{1,3}\.(png|jpg)$/.test(captured.screenshot)) {
        const evidenceId = evidenceIdOf(run.runId, id, "screenshot");
        evidence.push({
          id: evidenceId,
          label: `What the browser showed after step ${index + 1} of ${result.scenarioId}`,
          mediaType: captured.screenshot.endsWith(".jpg") ? "image/jpeg" : "image/png",
          path: path.posix.join("scenarios", result.scenarioId, captured.screenshot),
          scenarioId: result.scenarioId,
        });
        screenshot = { evidenceId };
      }
      steps.push({
        id,
        scenarioId: result.scenarioId,
        action: ACTIONS.has(step.tool) ? step.tool : "unknown step",
        target: describeTarget(step.input),
        // A comparison step that kept no comparison did not do what it was for.
        outcome: !step.ok || (step.tool === "check" && !made) ? "error" : made && !made.pass ? "mismatch" : "ok",
        requirementIds,
        ...(captured && Number.isFinite(started + captured.atMs) && captured.atMs >= 0 ? { atMs: Math.round(started + captured.atMs) } : {}),
        ...(captured && Number.isFinite(captured.durationMs) && captured.durationMs >= 0 ? { durationMs: Math.round(captured.durationMs) } : {}),
        // Written here from the comparison. What a step printed can hold what a page or a request said, and stays in the run's record.
        note: made ? `Expected ${clip(String(made.expected), 120)}, observed ${clip(String(made.actual), 120)}: ${made.pass ? "match" : "mismatch"}.` : step.ok ? "" : "The step did not complete.",
        ...(screenshot ? { screenshot } : {}),
      });
      if (requirementId) {
        stepsOf.set(requirementId, [...(stepsOf.get(requirementId) ?? []), id]);
        // The values compared, cut to a length that shows a value and not a page of text.
        if (made) comparisonsOf.set(requirementId, [...(comparisonsOf.get(requirementId) ?? []), { expected: clip(String(made.expected), 120), observed: clip(String(made.actual), 120) }]);
      }
    });
  }

  const requirements: RemoteResult["requirements"] = assessment.requirements.map((requirement) => {
    const comparisons = comparisonsOf.get(requirement.id) ?? [];
    const source = documented.get(requirement.id)?.sourceId;
    const snapshot = source ? snapshotOf.get(source) : undefined;
    const withheld = requirement.status === "verified" && !trusted;
    return {
      id: requirement.id,
      status: withheld ? "unverified" : requirement.status,
      observedStatus: requirement.status,
      // The approved text itself, as quoted from the snapshot. How a plan put it in its own words is not shown as the requirement.
      text: requirement.quote,
      // In the engine's own words, from the comparisons made. The fuller account, which can repeat what a scenario said, is in the run's record.
      reason: withheld ? `Observed, not verified. ${matched(comparisons)} ${NOT_TRUSTED}` : REASON[requirement.status](comparisons),
      expected: comparisons.map((made) => made.expected).join("; "),
      observed: comparisons.map((made) => made.observed).join("; "),
      source: snapshot ? { document: snapshot.id, revision: snapshot.sha256, approvedBy: snapshot.approvedBy, approvedAt: snapshot.approvedAt } : null,
      stepIds: stepsOf.get(requirement.id) ?? [],
    };
  });

  const count = (status: RequirementStatus) => requirements.filter((requirement) => requirement.status === status).length;
  const screenshots = evidence.length > 0;
  const reason =
    observed === "passed"
      ? "Every planned scenario ran and every comparison matched."
      : run.endedEarly
        ? `${run.endedEarly.reason} Not everything planned was run.`
        : // In the engine's own words. What a scenario said about itself can repeat a step's input, and stays in the run's record.
          worst === "failed"
          ? "At least one comparison did not match."
          : worst === "errored"
            ? "The application answered with an error that stopped a scenario."
            : worst === "blocked"
              ? "At least one scenario could not go on."
              : "Not everything planned was run and compared, or not every approved requirement was compared and matched.";

  return {
    formatVersion: REMOTE_RESULT_FORMAT_VERSION,
    runId: run.runId,
    verdict,
    verdictsTrusted: trusted,
    verdictBasis: { observed, reason: clip(reason, 600), ...(verdict !== observed ? { notTrustedBecause: NOT_TRUSTED } : {}) },
    executionStatus: executed.length === 0 ? "nothing executed" : run.endedEarly ? "ended early" : "completed",
    ...(run.endedEarly ? { endedEarly: run.endedEarly } : {}),
    producer: { name: "releaseproof-engine", resultSchema: REMOTE_RESULT_SCHEMA, kind: "remote-run", executionMode: run.executionMode },
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    // Not the plan's own summary of the feature: that is unapproved wording.
    title: `Run against ${run.target.baseUrl}`,
    summary: clip(summaryOf(run.results, executed.length, planned.length), 600),
    target: run.target,
    snapshots: run.snapshots,
    coverage: {
      requirements: {
        total: requirements.length,
        verified: count("verified"),
        failed: count("failed"),
        errored: count("errored"),
        blocked: count("blocked"),
        unverified: count("unverified"),
        exercised: count("exercised"),
        deferred: count("deferred"),
        notPlanned: count("not planned"),
      },
      observedOnly: requirements.filter((requirement) => requirement.observedStatus === "verified" && requirement.status !== "verified").length,
      scenarios: { planned: planned.length, executed: executed.length, notExecuted: Math.max(0, planned.length - executed.length) },
    },
    requirements,
    steps,
    // The one browser the run used, at the size the run set. Nothing else was run, and nothing says it was.
    profiles: executed.length > 0 ? [{ name: "Chromium", viewport: `${REMOTE_VIEWPORT.width} × ${REMOTE_VIEWPORT.height}`, state: "tested", reason: "" }] : [],
    telemetry: {
      screenshots: screenshots ? "collected" : "not collected",
      recording: "not collected",
      // A trace is written beside each scenario and holds more than the result vouches for; it is not part of the result.
      trace: "not collected",
      // Collected means the run listened, whether or not anything was said. Only errors and failed requests are kept.
      console: listened ? "collected" : "not collected",
      network: listened ? "collected" : "not collected",
      analytics: "not collected",
      webVitals: "not collected",
    },
    diagnostics: { console: consoleEntries, network: networkEntries, analytics: [] },
    evidenceLimits: { leftOut },
    evidence,
    extensions: {},
  };
}

function summaryOf(results: ScenarioResult[], executed: number, planned: number): string {
  const matched = results.reduce((sum, result) => sum + result.assertionResults.filter((made) => made.pass).length, 0);
  const mismatched = results.reduce((sum, result) => sum + result.assertionResults.filter((made) => !made.pass).length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${executed} of ${plural(planned, "planned scenario")} ran. ${plural(matched, "comparison")} matched and ${mismatched} did not.`;
}
