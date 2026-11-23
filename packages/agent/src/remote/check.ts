/**
 * Carrying out one approved check ("binding"). Design: docs/design/TRUSTED-BINDING.md,
 * "How the engine carries out a check" and "What a check's outcome is".
 *
 * NOT USED BY ANY RUN. Nothing here is called when a run starts, is carried
 * out or is reported, and no verdict depends on it. A remote run reports
 * `verdictsTrusted: false` exactly as before. What this file returns is a
 * record for the engine's own working notes.
 *
 * The engine does everything itself: it opens a browser context with nothing
 * stored, applies the setup, carries out the approved steps and nothing else,
 * and reads the approved place. No step comes from a plan or a model.
 *
 * What it establishes about a page it establishes from outside the page's own
 * script: addresses and requests from the browser's events, elements and
 * their text in the browser's isolated world (where script of the page cannot
 * replace what is asked), and what lies on top of an element from the
 * browser's own hit test.
 *
 * NOT YET CHECKED HERE: the rules that need the criteria text (that the quote
 * lies on whole lines, that the expected value is the number written at its
 * position, that the quote holds no bound or negation). Until they are, an
 * outcome of this file says what the application showed against the value in
 * the binding, and nothing about the criteria.
 */
import { selectors, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Request } from "playwright";
import { SECRET_FIELDS } from "../execute/capture.ts";
import { bindingProblems, bindingSha256, FIXTURE_KEY_PLACEHOLDER, type Binding } from "./binding.ts";
import { sha256Hex } from "./request.ts";

// ---- outcomes ------------------------------------------------------------------

/** Why a check is unverified. A fixed list: a record never holds free text. */
export const UNVERIFIED_REASONS = [
  /** The binding breaks a rule. It was not carried out. */
  "binding-refused",
  "setup-failed",
  "fixture-value-unusable",
  "step-not-done",
  "address-not-bound",
  "page-not-at-rest",
  "element-missing",
  "element-not-single",
  "element-not-displayed",
  /** The element is a heading, a label or a field: not a place a value is shown. */
  "element-not-a-value",
  "reading-not-a-number",
  "secret-field-literal",
  "write-not-as-expected",
  "uncounted-write",
  /** A `see` did not show its expected value: a precondition is unmet. Never a failure of the requirement. */
  "condition-not-met",
  "final-readings-disagree",
  "error-answer",
  "request-failed",
  "page-error",
  "time-ran-out",
  "engine-error",
] as const;
export type UnverifiedReason = (typeof UNVERIFIED_REASONS)[number];

export type FinalReading = {
  /** Milliseconds since the check began. */
  readonly afterMs: number;
  /** The number read, in plain decimal form; absent if the reading was not clean. */
  readonly value?: string;
  readonly problem?: UnverifiedReason;
};

export type CheckRecord = {
  readonly bindingId: string;
  readonly bindingSha256: string;
  readonly outcome: "verified" | "failed" | "unverified";
  /** Present exactly when the outcome is unverified. */
  readonly reason?: UnverifiedReason;
  /** For `binding-refused`: which rules, in the engine's own fixed sentences. */
  readonly refused?: readonly string[];
  /**
   * A final reading showed another value than the expected one. In an
   * unverified check this is "contradiction seen, preconditions not
   * established", and is not a failure.
   */
  readonly contradictionSeen: boolean;
  /** The expected value, in the one spelling of its unit. */
  readonly expected?: string;
  readonly finalReadings: readonly FinalReading[];
  readonly stepsDone: number;
  readonly writesCounted: number;
  readonly durationMs: number;
};

// ---- numbers -------------------------------------------------------------------

type Reading = Binding["observation"];
type BoundLocator = Reading["locator"];

const CURRENCY_MARK = "(?:[$€£¥₹₩₺₽]|USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|INR)";
const DIGITS = "(0|[1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)";

/**
 * Reads a number by the one strict grammar of its unit: ASCII digits, an
 * optional minus at the very start, groups of exactly three if grouped, no
 * decimals for a plain number or for hundredths, exactly two for an amount in
 * units. An amount may carry one currency sign or code, before or after,
 * which is not compared. Any other spelling is not a number here: the reading
 * is then unverified, never a mismatch.
 *
 * Returns the number in plain decimal form, or undefined.
 */
export function readStrictNumber(text: string, valueKind: Reading["valueKind"], unit: Reading["unit"]): string | undefined {
  const decimals = unit === "currency-units" ? "\\.[0-9]{2}" : "";
  const mark = valueKind === "amount" ? CURRENCY_MARK : "(?!)";
  const forms = [`^(-?)${DIGITS}(${decimals})$`, `^(-?)${mark} ?${DIGITS}(${decimals})$`, `^(-?)${DIGITS}(${decimals}) ?${mark}$`];
  for (const form of forms) {
    const match = new RegExp(form).exec(text);
    if (!match) continue;
    const whole = match[2]!.replaceAll(",", "");
    const value = `${whole}${match[3]!}`;
    // Nothing is less than nothing: "-0" is not a spelling of zero.
    if (match[1] === "-" && /^[0.]*$/.test(value)) return undefined;
    return `${match[1]!}${value}`;
  }
  return undefined;
}

/** An expected value in the one spelling of its unit, or undefined if the unit cannot spell it. */
export function expectedInUnit(value: string, unit: Reading["unit"]): string | undefined {
  if (/^-[0.]*$/.test(value)) return undefined;
  if (unit !== "currency-units") return /^-?[0-9]+$/.test(value) ? value : undefined;
  const match = /^(-?[0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const spelled = `${match[1]!}.${(match[2] ?? "").padEnd(2, "0")}`;
  return /^-[0.]*$/.test(spelled) ? undefined : spelled;
}

/** Whether a text holds a number as a whole: not as part of a longer one. */
function mentions(text: string, value: string): boolean {
  const escaped = value.replace(/[.\\-]/g, "\\$&");
  return new RegExp(`(?<![0-9.])${escaped}(?![0-9]|\\.[0-9])`).test(text.replaceAll(",", ""));
}

// ---- rules about a check as a whole --------------------------------------------

const readingKey = (reading: Reading) => JSON.stringify([reading.path, reading.locator.by === "testid" ? ["testid", reading.locator.value] : ["role", reading.locator.role, reading.locator.name], reading.valueKind, reading.unit]);
const locatorText = (locator: BoundLocator) => (locator.by === "testid" ? locator.value : locator.name);

/**
 * What is wrong with a binding as a check to carry out, as far as that can be
 * told without the criteria text and without a browser: the rules of
 * `bindingProblems`, and the rules about the journey. A binding with any of
 * these is refused, never repaired.
 */
export function checkProblems(binding: Binding): string[] {
  const problems = bindingProblems(binding);
  const { steps } = binding;

  // Values that the unit of their reading can spell.
  const finalExpected = expectedInUnit(binding.expected.value, binding.observation.unit);
  if (finalExpected === undefined) problems.push("its expected value cannot be written in the unit of its observation");
  const seen = steps.map((step) => (step.kind === "see" ? expectedInUnit(step.expected.value, step.reading.unit) : undefined));
  if (steps.some((step, index) => step.kind === "see" && seen[index] === undefined)) problems.push("a condition's expected value cannot be written in the unit of its reading");

  // A locator that holds the value would find it wherever it is.
  if (mentions(locatorText(binding.observation.locator), binding.expected.value)) problems.push("the observation's locator contains its expected value");
  if (steps.some((step) => step.kind === "see" && mentions(locatorText(step.reading.locator), step.expected.value))) problems.push("a condition's locator contains its expected value");

  // What follows what. A fill and an act work in the page of the open before them.
  let openAt: string | undefined;
  for (const step of steps) {
    if (step.kind === "open") openAt = step.path;
    else if (step.kind === "see") openAt = undefined;
    else {
      if (openAt === undefined) problems.push(`a ${step.kind} does not follow an open of its page: after a reading or a write, the page is opened again`);
      else if (openAt !== step.path) problems.push(`a ${step.kind} names another path than the open before it`);
      if (step.kind === "act" && step.expects.write === "one") openAt = undefined;
    }
  }

  // Writes and their witnesses. The first `see` is the starting state: writes before it are those it witnesses itself.
  const isWrite = (index: number) => {
    const step = steps[index]!;
    return step.kind === "act" && step.expects.write === "one";
  };
  const writes = steps.map((_step, index) => index).filter(isWrite);
  const firstSee = steps.findIndex((step) => step.kind === "see");
  const later = writes.filter((index) => firstSee !== -1 && index > firstSee);
  const observed = readingKey(binding.observation);
  for (const write of later) {
    const before = Math.max(-1, ...writes.filter((index) => index < write));
    const after = Math.min(steps.length, ...writes.filter((index) => index > write));
    const sees = (from: number, to: number) => {
      const found = new Map<string, string>();
      for (let index = from + 1; index < to; index++) {
        const step = steps[index]!;
        if (step.kind === "see" && seen[index] !== undefined) found.set(readingKey(step.reading), seen[index]!);
      }
      return found;
    };
    // The last sight of each reading before the write, and the last after it, before the next write.
    const earlier = sees(before, write);
    const afterwards = sees(write, after);
    const witnessed = [...earlier].some(([key, value]) => key !== observed && afterwards.has(key) && afterwards.get(key) !== value);
    if (!witnessed) problems.push("a write has no witness: no reading other than the observation's is seen before it with one value and after it with another");
  }
  if (later.length > 0 && finalExpected !== undefined) {
    const first = later[0]!;
    const seenBefore = steps.some((step, index) => index < first && step.kind === "see" && readingKey(step.reading) === observed && seen[index] !== undefined && seen[index] !== finalExpected);
    if (!seenBefore) problems.push("the observation's reading is not seen, with another value than the final one, before the first write of the journey");
  }
  return problems;
}

// ---- the browser's isolated world ----------------------------------------------

/**
 * Where a node is: the position of each ancestor among its siblings, from the
 * document down. Written once, as text, because it runs in two places: in the
 * selector engine below and through the browser's debugging interface.
 */
const PATH_OF = `function pathOf(node) {
  const parts = [];
  let at = node;
  while (at) {
    const parent = at.parentNode;
    if (parent) { parts.push(String(Array.prototype.indexOf.call(parent.childNodes, at))); at = parent; }
    else if (at.host) { parts.push("s"); at = at.host; }
    else break;
  }
  return parts.reverse().join("/");
}`;

/**
 * Facts about one element, asked in the browser's isolated world. Script of
 * the page cannot reach that world: replacing `getComputedStyle` or
 * `getBoundingClientRect` in the page changes nothing here. A selector
 * `<engine>=<fact>` keeps the element if the fact holds.
 */
const ENGINE = "rpcheck";
const ENGINE_SOURCE = `({
  query(root, body) { return this.queryAll(root, body)[0]; },
  queryAll(root, body) {
    ${PATH_OF}
    if (!(root instanceof Element)) return [];
    const box = root.getBoundingClientRect();
    const facts = {
      box: () => box.width > 0 && box.height > 0,
      seen: () => {
        if (getComputedStyle(root).visibility !== "visible") return false;
        for (let at = root; at; at = at.parentElement || (at.getRootNode() instanceof ShadowRoot ? at.getRootNode().host : null)) {
          const style = getComputedStyle(at);
          if (style.display === "none" || Number(style.opacity) === 0) return false;
        }
        return true;
      },
      inview: () => {
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
      },
      value: () => !root.closest("h1, h2, h3, h4, h5, h6, label, legend, caption, th, dt, summary, option, [role=heading]") && !root.matches("input, textarea, select, button, [contenteditable]"),
      secret: () => root.matches(${JSON.stringify(SECRET_FIELDS)}),
      under: () => { const mine = pathOf(root), hit = body.slice(6); return hit === mine || hit.startsWith(mine + "/"); },
    };
    const fact = facts[body.startsWith("under:") ? "under" : body];
    return fact && fact() ? [root] : [];
  }
})`;

let engineRegistered: Promise<void> | undefined;
/** Once in a process: the browser library keeps selector engines for every context made afterwards. */
const registerEngine = () => (engineRegistered ??= selectors.register(ENGINE, ENGINE_SOURCE, { contentScript: true }));

// ---- carrying a check out ------------------------------------------------------

/** Limits of the engine's own, which are not the application's settling time. They only ever end a check as unverified. */
export const CHECK_LIMITS = {
  /** One action of the browser. */
  actionMs: 10_000,
  /** How long a page must have no request in flight to be at rest. */
  quietMs: 300,
  /** How long a page is given to come to rest. */
  restMs: 10_000,
  /** Between two tries of a `see` after a write. */
  retryMs: 500,
  /** The fixture call, and the size of its answer. */
  fixtureMs: 15_000,
  fixtureAnswerBytes: 65_536,
  fixtureValueLength: 500,
} as const;

export type CheckOptions = {
  readonly browser: Browser;
  /** The target's address. Only its origin is used: a binding's paths are paths of the origin. */
  readonly baseUrl: string;
  readonly runId: string;
  readonly binding: Binding;
  /** The whole check may take this long. Default: a time worked out from the binding. */
  readonly limitMs?: number;
};

/** Ends a check as unverified. Thrown inside, never out of `carryOutCheck`. */
class Stop extends Error {
  constructor(readonly reason: UnverifiedReason) {
    super(reason);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The key the engine puts into a fixture's body: its own for the run and the exact binding. */
export const fixtureKey = (runId: string, binding: Binding) => `rp-${sha256Hex(`${runId}\n${bindingSha256(binding)}`).slice(0, 24)}`;

/** How long a check may take if the caller sets no limit: its steps and readings at the engine's limits, and the approved settling time. */
export function defaultLimitMs(binding: Binding): number {
  const pages = binding.steps.length + binding.settling.readings;
  return 30_000 + pages * 20_000 + binding.settling.within * 2_000;
}

/**
 * Carries out one approved check and says how it ended. Never throws for
 * anything the application or the binding does: every such thing is an
 * outcome. The outcome is `verified` or `failed` only by the rules of the
 * design; everything else is `unverified` with one reason.
 */
export async function carryOutCheck(options: CheckOptions): Promise<CheckRecord> {
  const { binding } = options;
  const began = Date.now();
  const base = {
    bindingId: binding.id,
    bindingSha256: bindingSha256(binding),
  };
  const record = (rest: Pick<CheckRecord, "outcome" | "reason" | "refused" | "contradictionSeen" | "expected" | "finalReadings" | "stepsDone" | "writesCounted">): CheckRecord => ({ ...base, ...rest, durationMs: Date.now() - began });
  const nothing = { contradictionSeen: false, finalReadings: [], stepsDone: 0, writesCounted: 0 } as const;

  const refused = checkProblems(binding);
  if (refused.length > 0) return record({ outcome: "unverified", reason: "binding-refused", refused, ...nothing });
  const expected = expectedInUnit(binding.expected.value, binding.observation.unit)!;

  let origin: string;
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not a web address");
    origin = url.origin;
  } catch {
    return record({ outcome: "unverified", reason: "setup-failed", expected, ...nothing });
  }

  const deadline = began + (options.limitMs ?? defaultLimitMs(binding));
  const inTime = () => {
    if (Date.now() >= deadline) throw new Stop("time-ran-out");
  };

  // What the check has come to so far. Kept outside the try so that a stop can report it.
  const progress = { stepsDone: 0, writesCounted: 0, contradictionSeen: false, finalReadings: [] as FinalReading[] };
  let context: BrowserContext | undefined;
  try {
    // 1. Setup. The fixture call is made from here, outside any browser context: nothing it sets is carried into one.
    let fixtureAnswer: Record<string, unknown> | undefined;
    if (binding.setup.kind === "fixture") fixtureAnswer = await callFixture(origin, binding.setup, fixtureKey(options.runId, binding), deadline);

    // 2. A browser context with nothing stored, set as the approver saw the application.
    await registerEngine();
    try {
      // A language or a time zone that is not one: the browser would only say so when a page is opened.
      Intl.getCanonicalLocales(binding.locale);
      new Intl.DateTimeFormat("en", { timeZone: binding.timezone });
      context = await options.browser.newContext({ locale: binding.locale, timezoneId: binding.timezone, serviceWorkers: "block", viewport: { width: 1280, height: 720 } });
    } catch {
      throw new Stop("setup-failed");
    }
    const watch = watchRequests(context, origin, binding);

    /** Stops the check if anything has gone wrong anywhere in it so far. */
    const sound = () => {
      if (watch.wrong !== undefined) throw new Stop(watch.wrong);
      inTime();
    };

    // 3. The steps, in sequence, and nothing else.
    let current: Page | undefined;
    let lastWriteAt: number | undefined;
    const firstStepAt = Date.now();
    for (const step of binding.steps) {
      sound();
      if (step.kind === "open") {
        if (current) await closeByEngine(watch, current);
        current = await openPage(context, watch, origin, step.path, deadline);
      } else if (step.kind === "fill") {
        const page = pageAt(current, origin, step.path);
        const field = await displayed(page, watch, step.locator, deadline);
        let text: string;
        if (step.value.from === "literal") {
          // No credentials in a binding: a secret is never written out to be signed and shown.
          if ((await field.locator(`${ENGINE}=secret`).count()) > 0) throw new Stop("secret-field-literal");
          text = step.value.text;
        } else {
          text = fixtureValue(fixtureAnswer, step.value.field);
        }
        await field.fill(text, { timeout: CHECK_LIMITS.actionMs }).catch(() => {
          throw new Stop("step-not-done");
        });
        await atRest(page, watch, deadline);
      } else if (step.kind === "act") {
        const page = pageAt(current, origin, step.path);
        const control = await displayed(page, watch, step.locator, deadline);
        const window = watch.openWindow(page);
        await control.click({ timeout: CHECK_LIMITS.actionMs }).catch(() => {
          throw new Stop("step-not-done");
        });
        await atRest(page, watch, deadline);
        const written = watch.closeWindow(window);
        if (step.expects.write === "none") {
          if (written.length > 0) throw new Stop("write-not-as-expected");
        } else {
          const { method, path } = step.expects;
          if (written.length !== 1 || written[0]!.method !== method || written[0]!.path !== path || written[0]!.status === undefined || written[0]!.status >= 400) throw new Stop("write-not-as-expected");
          progress.writesCounted += 1;
          lastWriteAt = written[0]!.answeredAt ?? Date.now();
          // After a write the page may have gone anywhere on the target: it is not worked in again.
          await closeByEngine(watch, page);
          current = undefined;
        }
      } else {
        // A reading is always made on a page the engine has just opened, with nothing done in it.
        if (current) await closeByEngine(watch, current);
        current = undefined;
        const want = expectedInUnit(step.expected.value, step.reading.unit)!;
        for (;;) {
          sound();
          let problem: UnverifiedReason | undefined;
          let value: string | undefined;
          try {
            value = await readOnce(context, watch, origin, step.reading, deadline);
          } catch (stop) {
            if (!(stop instanceof Stop)) throw stop;
            problem = stop.reason;
          }
          sound();
          if (value === want) break;
          // After a write the application may take the approved time to show it. Before any write, there is nothing to wait for.
          const until = lastWriteAt === undefined ? 0 : lastWriteAt + binding.settling.within * 1_000;
          const waitable = problem === undefined || problem === "element-missing" || problem === "element-not-displayed" || problem === "reading-not-a-number";
          if (!waitable) throw new Stop(problem!);
          if (Date.now() >= until) throw new Stop(problem ?? "condition-not-met");
          await sleep(Math.min(CHECK_LIMITS.retryMs, until - Date.now(), deadline - Date.now()));
        }
      }
      progress.stepsDone += 1;
    }
    sound();
    if (current) await closeByEngine(watch, current);

    // 4. The final readings: the first at once, the last not before the approved time has passed since the last
    // write (in a check with no write, since its first step), the others spread between.
    const count = binding.settling.readings;
    const from = Date.now();
    const to = Math.max(from, (lastWriteAt ?? firstStepAt) + binding.settling.within * 1_000);
    let unclean: UnverifiedReason | undefined;
    for (let index = 0; index < count; index++) {
      const due = from + ((to - from) * index) / (count - 1);
      if (due > deadline) throw new Stop("time-ran-out");
      await sleep(due - Date.now());
      sound();
      const afterMs = Date.now() - began;
      try {
        const value = await readOnce(context, watch, origin, binding.observation, deadline);
        progress.finalReadings.push({ afterMs, value });
        if (value !== expected) progress.contradictionSeen = true;
      } catch (stop) {
        if (!(stop instanceof Stop)) throw stop;
        progress.finalReadings.push({ afterMs, problem: stop.reason });
        unclean ??= stop.reason;
      }
      sound();
    }
    // Every final reading clean, or the check says nothing.
    if (unclean !== undefined) throw new Stop(unclean);
    await context.close();
    context = undefined;
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);

    const values = progress.finalReadings.map((reading) => reading.value!);
    // Verified: from some reading on, through the last, the expected value, at least twice.
    let tail = 0;
    while (tail < values.length && values[values.length - 1 - tail] === expected) tail += 1;
    if (tail >= 2) return record({ outcome: "verified", expected, ...progress });
    // Failed: every reading, from the first to the last after the whole approved time, the same other value.
    if (values.every((value) => value === values[0]) && values[0] !== expected) return record({ outcome: "failed", expected, ...progress });
    throw new Stop("final-readings-disagree");
  } catch (error) {
    // Past its time limit, whatever stopped a check may only have been the limit: an action of the browser cut short.
    const reason: UnverifiedReason = !(error instanceof Stop) ? "engine-error" : Date.now() >= deadline ? "time-ran-out" : error.reason;
    return record({ outcome: "unverified", reason, expected, ...progress });
  } finally {
    await context?.close().catch(() => {});
  }
}

// ---- setup ---------------------------------------------------------------------

async function callFixture(origin: string, setup: Extract<Binding["setup"], { kind: "fixture" }>, key: string, deadline: number): Promise<Record<string, unknown>> {
  try {
    const answer = await fetch(`${origin}${setup.path}`, {
      method: setup.method,
      headers: { "content-type": "application/json" },
      body: setup.body.replaceAll(FIXTURE_KEY_PLACEHOLDER, key),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, Math.min(CHECK_LIMITS.fixtureMs, deadline - Date.now()))),
    });
    if (answer.status < 200 || answer.status > 299) throw new Error("not answered with success");
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (bytes.length > CHECK_LIMITS.fixtureAnswerBytes) throw new Error("answer too long");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("answer is not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Stop("setup-failed");
  }
}

/** A value of the fixture's answer, by an own field of it. Treated as a secret: it goes into the page and nowhere else. */
function fixtureValue(answer: Record<string, unknown> | undefined, field: string): string {
  if (!answer || !Object.hasOwn(answer, field)) throw new Stop("fixture-value-unusable");
  const value = answer[field];
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  if (text === undefined || text.length === 0 || text.length > CHECK_LIMITS.fixtureValueLength) throw new Stop("fixture-value-unusable");
  return text;
}

// ---- requests, seen from the browser -------------------------------------------

type Written = { method: string; path: string; status?: number; answeredAt?: number };
type ActWindow = { page: Page; written: Written[]; aborted: number; navigated: boolean; onNavigated: (frame: unknown) => void };

type Watch = {
  /** The first thing that went wrong anywhere in the check. */
  wrong: UnverifiedReason | undefined;
  readonly inFlight: Set<Request>;
  readonly closing: Set<Page>;
  openWindow(page: Page): ActWindow;
  closeWindow(window: ActWindow): Written[];
};

/**
 * Everything the browser sends for the check, counted from the browser's own
 * events. Requests to other hosts are blocked and not counted. A request to
 * the target that is not a plain read is a write: counted for the `act` under
 * way if there is one, something gone wrong if there is none, and passed over
 * only if the binding lists it as background.
 */
function watchRequests(context: BrowserContext, origin: string, binding: Binding): Watch {
  let window: ActWindow | undefined;
  const writes = new Map<Request, Written>();
  const watch: Watch = {
    wrong: undefined,
    inFlight: new Set(),
    closing: new Set(),
    openWindow(page) {
      const opened: ActWindow = { page, written: [], aborted: 0, navigated: false, onNavigated: (frame) => void (frame === page.mainFrame() && (opened.navigated = true)) };
      page.on("framenavigated", opened.onNavigated);
      window = opened;
      return opened;
    },
    closeWindow(closed) {
      closed.page.off("framenavigated", closed.onNavigated);
      window = undefined;
      // Requests cancelled by a navigation the act itself made are not failures. Cancelled with no navigation, they are.
      if (closed.aborted > 0 && !closed.navigated) watch.wrong ??= "request-failed";
      return closed.written;
    },
  };
  const toTarget = (request: Request): URL | undefined => {
    try {
      const url = new URL(request.url());
      return url.origin === origin ? url : undefined;
    } catch {
      return undefined;
    }
  };
  const listed = (list: readonly { method: string; path: string }[], method: string, url: URL) => list.some((entry) => entry.method === method && entry.path === url.pathname && url.search === "");
  const pageOf = (request: Request): Page | undefined => {
    try {
      return request.frame().page();
    } catch {
      return undefined;
    }
  };

  void context.route("**/*", (route) => (toTarget(route.request()) || !/^https?:/i.test(route.request().url()) ? route.continue() : route.abort()));
  // A socket is not a request: what goes through one is not seen. None is let through to another host.
  void context.routeWebSocket(/.*/, (socket) => {
    try {
      if (new URL(socket.url()).host === new URL(origin).host) socket.connectToServer();
      else void socket.close();
    } catch {
      void socket.close();
    }
  });

  context.on("request", (request) => {
    watch.inFlight.add(request);
    const url = toTarget(request);
    const method = request.method();
    if (!url || method === "GET" || method === "HEAD" || listed(binding.background, method, url)) return;
    // With a query, a write is not the write that was named: it is recorded with one, and matches nothing.
    const written: Written = { method, path: `${url.pathname}${url.search}` };
    writes.set(request, written);
    if (window) window.written.push(written);
    else watch.wrong ??= "uncounted-write";
  });
  context.on("response", (response) => {
    const request = response.request();
    const url = toTarget(request);
    if (!url) return;
    const status = response.status();
    const written = writes.get(request);
    if (written) {
      written.status = status;
      written.answeredAt = Date.now();
    }
    if (status >= 400 && !binding.tolerated.some((entry) => entry.status === status && listed([entry], request.method(), url))) watch.wrong ??= "error-answer";
  });
  context.on("requestfinished", (request) => void watch.inFlight.delete(request));
  context.on("requestfailed", (request) => {
    watch.inFlight.delete(request);
    if (!toTarget(request)) return;
    const cancelled = request.failure()?.errorText === "net::ERR_ABORTED";
    const page = pageOf(request);
    // Cancelled because the engine itself closed the page it had finished with.
    if (cancelled && page && watch.closing.has(page)) return;
    if (cancelled && window) window.aborted += 1;
    else watch.wrong ??= "request-failed";
  });
  context.on("weberror", () => void (watch.wrong ??= "page-error"));
  return watch;
}

/** Closes a page the engine has finished with. What the page had under way at that moment is not a failure of the application. */
async function closeByEngine(watch: Watch, page: Page): Promise<void> {
  watch.closing.add(page);
  await page.close().catch(() => {});
}

/** Waits until the context has no request in flight, and has had none for a while. A page that never gets there is unverified. */
async function atRest(page: Page, watch: Watch, deadline: number): Promise<void> {
  const until = Math.min(deadline, Date.now() + CHECK_LIMITS.restMs);
  await page.waitForLoadState("load", { timeout: Math.max(1, until - Date.now()) }).catch(() => {
    throw new Stop(Date.now() >= deadline ? "time-ran-out" : "page-not-at-rest");
  });
  let quietSince: number | undefined;
  for (;;) {
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);
    const now = Date.now();
    if (watch.inFlight.size > 0) quietSince = undefined;
    else if (quietSince === undefined) quietSince = now;
    else if (now - quietSince >= CHECK_LIMITS.quietMs) return;
    if (now >= until) throw new Stop(now >= deadline ? "time-ran-out" : "page-not-at-rest");
    await sleep(25);
  }
}

// ---- pages and elements --------------------------------------------------------

type OpenedPage = Page & { [NAVIGATIONS]?: { count: number; atOpen: number } };
const NAVIGATIONS = Symbol("navigations");

/**
 * The engine navigates to a path itself, with a plain request, in a new page.
 * The answer is 2xx with no redirect, and the main frame's address is then
 * exactly that path on the target, byte for byte, with no query and no
 * fragment.
 */
async function openPage(context: BrowserContext, watch: Watch, origin: string, path: string, deadline: number): Promise<Page> {
  const page: OpenedPage = await context.newPage();
  const navigations = { count: 0, atOpen: 0 };
  page[NAVIGATIONS] = navigations;
  page.on("framenavigated", (frame) => void (frame === page.mainFrame() && (navigations.count += 1)));
  const address = `${origin}${path}`;
  const before = navigations.count;
  const answer = await page.goto(address, { waitUntil: "load", timeout: Math.max(1, Math.min(CHECK_LIMITS.actionMs, deadline - Date.now())) }).catch(() => null);
  if (watch.wrong !== undefined) throw new Stop(watch.wrong);
  if (!answer || answer.status() < 200 || answer.status() > 299 || answer.request().redirectedFrom() !== null) throw new Stop("address-not-bound");
  await atRest(page, watch, deadline);
  // One navigation: the engine's. A page that then takes itself elsewhere, or rewrites its address, is not the bound page.
  if (navigations.count !== before + 1 || page.url() !== address) throw new Stop("address-not-bound");
  navigations.atOpen = navigations.count;
  return page;
}

/** The page a fill or an act works in: the one opened before it, still at exactly its path. */
function pageAt(current: Page | undefined, origin: string, path: string): Page {
  if (!current || current.isClosed()) throw new Stop("step-not-done");
  const opened: OpenedPage = current;
  if (current.url() !== `${origin}${path}` || opened[NAVIGATIONS]!.count !== opened[NAVIGATIONS]!.atOpen) throw new Stop("address-not-bound");
  return current;
}

function find(page: Page, locator: BoundLocator): Locator {
  if (locator.by === "testid") return page.getByTestId(locator.value);
  return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name, exact: true, includeHidden: true });
}

/**
 * The one element a locator names, displayed: exactly one match in the main
 * document counting hidden ones; a box of non-zero size; visible and not
 * fully transparent with all its ancestors; in the viewport after scrolling to
 * it; and it, or something inside it, is what the browser finds at the centre
 * of its box.
 */
async function displayed(page: Page, watch: Watch, locator: BoundLocator, deadline: number): Promise<Locator> {
  const found = find(page, locator);
  const single = async () => {
    const count = await found.count();
    if (count === 0) throw new Stop("element-missing");
    if (count > 1) throw new Stop("element-not-single");
  };
  await single();
  await found.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {
    throw new Stop("element-not-displayed");
  });
  await atRest(page, watch, deadline);
  await single();
  for (const fact of ["box", "seen", "inview"]) {
    if ((await found.locator(`${ENGINE}=${fact}`).count()) !== 1) throw new Stop("element-not-displayed");
  }
  const box = await found.boundingBox({ timeout: 2_000 }).catch(() => null);
  if (!box) throw new Stop("element-not-displayed");
  const hit = await hitPath(page, box.x + box.width / 2, box.y + box.height / 2);
  if (hit === undefined || (await found.locator(`${ENGINE}=under:${hit}`).count()) !== 1) throw new Stop("element-not-displayed");
  return found;
}

/**
 * Where the node is that the browser finds at a place in the viewport, by the
 * browser's own hit test. Unlike a hit test asked of the document, this one
 * counts what is drawn there even if it takes no clicks.
 */
async function hitPath(page: Page, x: number, y: number): Promise<string | undefined> {
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    // The browser takes this place counted from the top of the document, and finds only what is in the viewport.
    // Were that to change, the node found would not be the element, and the reading would be unverified.
    const { cssVisualViewport } = await session.send("Page.getLayoutMetrics");
    const { backendNodeId } = await session.send("DOM.getNodeForLocation", { x: Math.round(x + cssVisualViewport.pageX), y: Math.round(y + cssVisualViewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id });
    const { object } = await session.send("DOM.resolveNode", { backendNodeId, executionContextId });
    if (!object.objectId) return undefined;
    const { result } = await session.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: `function () { ${PATH_OF}\n return pathOf(this); }`, returnByValue: true });
    return typeof result.value === "string" && /^[0-9s/]*$/.test(result.value) ? result.value : undefined;
  } catch {
    return undefined;
  } finally {
    await session?.detach().catch(() => {});
  }
}

/**
 * One reading: a page the engine has just opened at the reading's path, with
 * nothing done in it; the one element, displayed, that is a place a value is
 * shown; its text, read in the isolated world; a number by the strict grammar.
 * The page is closed again. Returns the number in plain decimal form.
 */
async function readOnce(context: BrowserContext, watch: Watch, origin: string, reading: Reading, deadline: number): Promise<string> {
  const page = await openPage(context, watch, origin, reading.path, deadline);
  try {
    const element = await displayed(page, watch, reading.locator, deadline);
    if ((await element.locator(`${ENGINE}=value`).count()) !== 1) throw new Stop("element-not-a-value");
    const text = await element.innerText({ timeout: 2_000 }).catch(() => {
      throw new Stop("element-not-displayed");
    });
    // Still the page that was opened: nothing has taken it elsewhere while it was read.
    pageAt(page, origin, reading.path);
    const value = readStrictNumber(text.trim(), reading.valueKind, reading.unit);
    if (value === undefined) throw new Stop("reading-not-a-number");
    return value;
  } finally {
    await closeByEngine(watch, page);
  }
}
