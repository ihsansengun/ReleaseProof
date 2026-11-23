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
 * A binding is carried out only against the criteria text it is for:
 * `criteriaProblems` holds the rules that need that text.
 */
import { selectors, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Request } from "playwright";
import { SECRET_FIELDS } from "../execute/capture.ts";
import { bindingProblems, bindingSha256, FIXTURE_KEY_PLACEHOLDER, type Binding } from "./binding.ts";
import { sha256Hex } from "./request.ts";
import { quotedNumbers, WORDING } from "../validate.ts";

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
  /** The engine blocked a request of the page to another host. What the page then showed may be the engine's doing: never a failure. */
  "other-host-blocked",
  /** The application sent the browser on to another host from a request to itself. The engine sees that too late to stop it. */
  "redirect-to-other-host",
  /** A value the check typed is one it expects to read: what is read could be what was typed. */
  "typed-value-is-expected",
  /** A page had something to do on being left, and the engine kept it from doing it. What that was is not known: no verdict. */
  "leave-script-suppressed",
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
  /** When the last counted write was answered, in milliseconds since the check began. The settling time runs from here. */
  readonly lastWriteAfterMs?: number;
  readonly durationMs: number;
};

// ---- numbers -------------------------------------------------------------------

type Reading = Binding["observation"];
type BoundLocator = Reading["locator"];

const CURRENCY_MARK = "(?:[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20ba\u20bd]|USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|INR)";
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

/**
 * Whether a text holds a value in any of its obvious spellings: as written, as
 * its unit spells it, without its sign, its whole part alone, and the same
 * amount counted in hundredths or in units.
 */
function holdsValue(text: string, value: string, spelled: string | undefined, typed?: "written" | "made"): boolean {
  const spellings = new Set<string>();
  for (const one of [value, spelled ?? value]) {
    const plain = one.replace(/^-/, "");
    const [whole = "", part = ""] = plain.split(".");
    for (const form of [one, plain, whole]) spellings.add(form);
    // 24.99 in hundredths is 2499; 2499 in units is 24.99.
    if (part.length > 0 && part.length <= 2) spellings.add(`${whole}${part.padEnd(2, "0")}`.replace(/^0+(?=[0-9])/, ""));
    if (part.length === 0 && whole.length > 0) spellings.add(`${whole.length > 2 ? whole.slice(0, -2) : "0"}.${whole.slice(-2).padStart(2, "0")}`);
  }
  spellings.delete("");
  if (typed === undefined) return [...spellings].some((form) => mentions(text, form));
  // In a text that is typed, every run of digits is taken for a number, inside a word too, however many noughts
  // are written before or after it: "0100", "100.00" and "100px" are 100.
  const bare = (number: string) => (number.includes(".") ? number.replace(/0+$/, "").replace(/\.$/, "") : number).replace(/^0+(?=[0-9])/, "");
  // A value the application made itself (a name, a code) is not written to be a number: there, a digit inside a
  // word is part of the word, and only a number standing by itself is taken for one.
  const runs = typed === "written" ? /[0-9]+(?:\.[0-9]+)?/g : /(?<![A-Za-z0-9.])[0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9])/g;
  const numbers = new Set((text.replaceAll(",", "").match(runs) ?? []).map(bare));
  return [...spellings].some((form) => numbers.has(bare(form)));
}

/** Whether a text holds a number as a whole: not as part of a longer one. */
function mentions(text: string, value: string): boolean {
  const escaped = value.replace(/[.\\-]/g, "\\$&");
  return new RegExp(`(?<![0-9.])${escaped}(?![0-9]|\\.[0-9])`).test(text.replaceAll(",", ""));
}

// ---- rules about a check as a whole --------------------------------------------

const placeKey = (reading: Reading) => JSON.stringify([reading.path, reading.locator.by === "testid" ? ["testid", reading.locator.value] : ["role", reading.locator.role, reading.locator.name]]);
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
  const named = (locator: BoundLocator, value: string, spelled: string | undefined) => holdsValue(locatorText(locator), value, spelled);
  if (named(binding.observation.locator, binding.expected.value, finalExpected)) problems.push("the observation's locator contains its expected value");
  if (steps.some((step, index) => step.kind === "see" && named(step.reading.locator, step.expected.value, seen[index]))) problems.push("a condition's locator contains its expected value");

  // A check may not type a value it expects to read: what it read could be what it typed, kept by the page.
  // What is read after it is what counts: the final value, and every condition that comes later. What is typed in
  // several steps is also taken together, as an application may put it together.
  let typedSoFar = "";
  for (const [at, step] of steps.entries()) {
    if (step.kind !== "fill" || step.value.from !== "literal") continue;
    const text = step.value.text;
    // Digits of another script than the plain ones: a page would read them as numbers, and this rule would not.
    if (/\p{Nd}/u.test(text.replace(/[0-9]/g, ""))) problems.push("a step types digits that are not the plain ones");
    typedSoFar += text;
    const readLater: [string, string | undefined][] = [[binding.expected.value, finalExpected], ...steps.flatMap((later, index): [string, string | undefined][] => (index > at && later.kind === "see" ? [[later.expected.value, seen[index]]] : []))];
    if (readLater.some(([value, spelled]) => holdsValue(text, value, spelled, "written") || holdsValue(typedSoFar, value, spelled, "written"))) problems.push("a step types a value that the check expects to read");
  }

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
        // The observation's own element is no witness, however it is read.
        if (step.kind === "see" && seen[index] !== undefined && placeKey(step.reading) !== placeKey(binding.observation)) found.set(readingKey(step.reading), seen[index]!);
      }
      return found;
    };
    // The last sight of each reading before the write, and the last after it, before the next write.
    const earlier = sees(before, write);
    const afterwards = sees(write, after);
    const witnessed = [...earlier].some(([key, value]) => afterwards.has(key) && afterwards.get(key) !== value);
    if (!witnessed) problems.push("a write has no witness: no reading other than the observation's is seen before it with one value and after it with another");
  }
  // A check whose writes all come before anything is seen has no before: whatever it reads at the end may have been there all along.
  if (writes.length > 0 && later.length === 0) problems.push("its writes all come before its first condition, so nothing is seen before the journey and after it");
  if (later.length > 0 && finalExpected !== undefined) {
    const first = later[0]!;
    // The last sight of the observation before the journey's first write: what it showed when the journey began.
    const sights = steps.map((step, index) => (index < first && step.kind === "see" && readingKey(step.reading) === observed ? seen[index] : undefined)).filter((value) => value !== undefined);
    if (sights.length === 0 || sights[sights.length - 1] === finalExpected) problems.push("the observation's reading is not seen, with another value than the final one, before the first write of the journey");
  }
  return problems;
}

// ---- rules that need the criteria text -----------------------------------------

/**
 * What is wrong with a binding against the criteria text it is for. A binding
 * with any of these is refused, never repaired.
 *
 * `criteria` is the snapshot's text, whole and exactly as approved. The quote
 * is that text between the binding's offsets, on whole lines. An expected
 * value that comes from the quote is exactly one whole number as the engine's
 * own reader of quoted numbers finds it at its offsets, and is the number
 * written there. The comparison is equality: a quote that words a bound or a
 * negation is refused, since equality would read "at least 100" showing 150
 * as a failure. The lists of such words are English, so a quote that is
 * plainly in another language is refused too.
 */
export function criteriaProblems(binding: Binding, criteria: string): string[] {
  if (typeof criteria !== "string" || LONE_HALF.test(criteria)) return ["the criteria text is not well-formed text"];
  if (sha256Hex(criteria) !== binding.snapshotSha256) return ["the criteria text is not the revision the binding is for"];
  const { start, end } = binding.quote;
  if (end > criteria.length) return ["its quote lies outside the criteria text"];
  const problems: string[] = [];
  const quote = criteria.slice(start, end);

  // Whole lines: it begins where a line begins and ends where one ends, with nothing of a line left out. A line
  // ends at a line feed, or at a carriage return that a line feed follows.
  const endsLine = end === criteria.length || criteria[end] === "\n" || (criteria[end] === "\r" && criteria[end + 1] === "\n");
  if ((start > 0 && criteria[start - 1] !== "\n") || !endsLine || /[\r\n]$/.test(quote)) problems.push("its quote is not whole lines of the criteria text");
  if (quote.trim() === "") problems.push("its quote holds no text");
  // Characters that are not seen could part a word, or stand where a sign is read.
  if (UNSEEN.test(quote.replace(/[\t\n\r]/g, ""))) problems.push("its quote holds characters that are not seen");
  // Markup that stands for a character ("&ge;", "&nbsp;") is not read as that character here.
  if (/&(?:#[0-9a-z]+|[a-z][a-z0-9]*);/i.test(quote)) problems.push("its quote holds markup that stands for a character");

  // Whole sentences, as far as lines can tell: a quote that begins or ends in the middle of a sentence that runs
  // over several lines could leave out the words that make it a bound. The line before it ends a sentence or is
  // empty, or the quote begins an item of its own; the same at its end.
  const lines = criteria.split("\n").map((line) => line.replace(/\r$/, ""));
  const first = criteria.slice(0, start).split("\n").length - 1;
  const last = criteria.slice(0, end).split("\n").length - 1;
  // A full stop after an abbreviation does not end a sentence, and neither does a colon or a semicolon.
  const closes = (line: string) => line.trim() === "" || /^\s*#/.test(line) || (/[.!?]["')\]*_`]*\s*$/.test(line) && !/(?<![a-z])(?:e\.g|i\.e|max|min|approx|ca|etc|vs|no|nr|incl|excl)\.["')\]*_`]*\s*$/i.test(line));
  const opens = (line: string) => /^\s*(?:[-*+]|\d+[.)]|#+|\|)\s/.test(line);
  if (first > 0 && !closes(lines[first - 1]!) && !opens(lines[first]!)) problems.push("its quote begins in the middle of a sentence");
  if (last < lines.length - 1 && !closes(lines[last]!) && !opens(lines[last + 1]!) && lines[last + 1]!.trim() !== "") problems.push("its quote ends in the middle of a sentence");

  // Equality only. The words are looked for in the quote as it reads: in one case, with one space wherever there
  // is space or a line break, without the marks of emphasis, and with every kind of apostrophe as one.
  const asRead = (text: string) =>
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc\u02b9\u0060\u00b4\u2032\uff07]/g, "'")
      .replace(new RegExp(DASH.source.replace("~", ""), "g"), "-")
      .replace(/[_*]/g, "")
      .replace(/\s+/gu, " ");
  const wording = (text: string): string[] => {
    const said = asRead(text);
    const found: string[] = [];
    if (WORDING.atLeast.test(said) || WORDING.atMost.test(said) || NOT_EQUALITY.bound.test(said)) found.push("a bound");
    if (WORDING.negation.test(said) || NOT_EQUALITY.negation.test(said)) found.push("a negation");
    if (NOT_EQUALITY.change.test(said)) found.push("a change, a rate or a condition");
    return found;
  };
  for (const kind of wording(quote)) problems.push(`its quote words ${kind}, and only equality with what is shown can be checked`);
  // What is said about the quote from above it counts as said in it: the heading it stands under, the line that
  // introduces the list it is an item of, and the header of the table it is a row of.
  const above: string[] = [];
  for (let at = first - 1; at >= 0; at--) {
    if (/^\s*#/.test(lines[at]!)) {
      above.push(lines[at]!);
      break;
    }
  }
  for (let at = first - 1; at >= 0 && lines[at]!.trim() !== ""; at--) {
    if (/:\s*$/.test(lines[at]!) || (/^\s*\|/.test(lines[first]!) && /^\s*\|/.test(lines[at]!))) above.push(lines[at]!);
  }
  if (above.some((line) => wording(line).length > 0)) problems.push("the heading, the introducing line or the table header above its quote words something other than an equality");
  // The words above are English. Letters of another alphabet, or with marks on them, say the quote may not be.
  if (/[^\u0000-\u007f]/u.test(quote.normalize("NFC").replace(/[^\p{L}\p{M}]|[\ufe0e\ufe0f]/gu, ""))) problems.push("its quote holds letters outside the English alphabet, and the words for bounds and negations are known in English only");

  const numbers = quotedNumbers(quote);
  const written = (span: { start: number; end: number; value: string }, what: string) => {
    const found = numbers.find((number) => number.start === span.start && number.end === span.end);
    if (!found) return void problems.push(`${what} is not at one whole number of the quote, as the engine reads numbers`);
    if (found.text.replaceAll(",", "") !== span.value) problems.push(`${what} is not the number written at its place in the quote`);
    // Its sign must be what the text says. The reader takes several marks for a minus, and takes none where
    // something stands between the minus and the digits: neither is certain enough to rest a check on.
    // What may stand between a sign and the digits, or after them: space, a currency sign, a currency code.
    const money = String.raw`(?:[\s\p{Sc}]|[A-Z]{1,3}\$|(?<![A-Za-z])[A-Z]{3}(?![A-Za-z]))*`;
    const before = quote.slice(0, span.start).replace(new RegExp(`${money}$`, "u"), "");
    const after = quote.slice(span.end).replace(new RegExp(`^${money}`, "u"), "");
    const signRead = found.text.startsWith("-") && quote[span.start] !== "-" && quote[span.start] !== "\u2212";
    // A dash that only marks an item of a list is not a sign: at the start of its line, with space after it and
    // then the number itself, on the quote's first line or after a line that ends a sentence. With a currency sign
    // between ("-$5"), or after a line that runs on into it, it may be a minus.
    const upTo = quote.slice(0, span.start);
    const marker = /(?:^|\n)([ \t]*-[ \t]+(?:\[[ xX]\][ \t]+)?)$/.exec(upTo);
    const lineBefore = marker ? upTo.slice(0, upTo.length - marker[1]!.length).replace(/\r?\n$/, "").split("\n").pop()! : "";
    const marksItem = marker !== null && (marker.index === 0 || closes(lineBefore.replace(/\r$/, "")));
    const signLeft = (DASH.test(before.slice(-1)) && !marksItem) || before.endsWith("(") || DASH.test(after.slice(0, 1)) || /^(?:cr|dr)(?![a-z])/i.test(after);
    if (signRead || signLeft) problems.push(`${what} has a sign that the text does not state plainly`);
  };
  written(binding.expected, "its expected value");
  for (const step of binding.steps) if (step.kind === "see" && step.expected.from === "quote") written(step.expected, "a condition's expected value");
  return problems;
}

/** Half of a pair with no other half: text that has no one spelling in bytes. */
const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Control and format characters, whatever plane they are in, and blanks that are not space. Asked of a text with tabs and line breaks taken out. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u2800\u3164]/u;
/** Every mark the reader of quoted numbers takes for a minus. */
const DASH = /[-\u2010-\u2015\u2212\ufe58\ufe63\uff0d\u00ad\u2043\u058a~\u2026\u2192]/;

/**
 * Wordings that are not an equality, beyond the validator's lists. Those lists
 * confirm that a text words a bound a plan claims; here the question is the
 * other one, whether a text might NOT be an equality, and a miss lets a check
 * rest on the wrong comparison. So this list is wide, and refuses much that
 * is harmless. Matched against the quote in lower case, as `criteriaProblems`
 * prepares it.
 */
const NOT_EQUALITY = {
  bound: new RegExp(
    [
      String.raw`(?<![a-z])[a-z]+er than(?![a-z])|(?<![a-z])(?:more|less|fewer|higher|lower|greater|smaller|larger)(?![a-z])`,
      String.raw`(?<![a-z])at the (?:very )?(?:most|least|latest|earliest)(?![a-z])|(?<![a-z])(?:as much as|as many as|and up|or so|give or take|tops out|tops)(?![a-z])`,
      String.raw`(?<![a-z])(?:under|over|below|above|beyond|within|between|exceed(?:s|ed|ing)?|limit(?:s|ed)?|unlimited|cap(?:s|ped)?|range|until|upwards|starting|threshold|ceiling|floor|bound|tolerance|latest|earliest|atleast|atmost|upto|at-least|at-most|up-to)(?![a-z])`,
      String.raw`(?<![a-z])(?:min|max|minimal|maximal|minimum|maximum)(?![a-z])`,
      String.raw`(?<![a-z])(?:approximately|approx|about|around|roughly|nearly|almost|circa|ca|some|thereabouts|either)(?![a-z])`,
      String.raw`(?<![a-z])from(?![a-z]).*(?<![a-z])(?:to|until|through)(?![a-z])`,
      String.raw`[0-9] ?(?:to|or|-) ?[0-9]`,
      String.raw`[<>\u2264\u2265\u2260\u00b1\u2248~\u223c\u2243\u2272\u2273\u2a7d\u2a7e\u2266\u2267]|[0-9]\+|\+\/-`,
    ].join("|"),
  ),
  negation: new RegExp(
    [
      String.raw`(?<![a-z])(?:[a-z]+n't|isnt|arent|wasnt|werent|doesnt|dont|didnt|cant|wont|shouldnt|wouldnt|couldnt|mustnt|hasnt|havent|hadnt)(?![a-z])`,
      String.raw`(?<![a-z])(?:neither|nor|none|nothing|nobody|nowhere|non|nonzero|unless|except|excluding|excludes?|exclusive|instead|anything but|lacks?|ceases?|stops?|hardly|barely|rarely|seldom|zero)(?![a-z])`,
      String.raw`(?<![a-z])(?:fails?|failed|refused?|rejects?|rejected|denied|prevents?|blocked|disabled|unable|missing|empty|unavailable)(?![a-z])`,
      // A sign that is written out as a word.
      String.raw`(?<![a-z])(?:minus|negative|debit|credit|owed|owes|overdrawn|deficit)(?![a-z])`,
    ].join("|"),
  ),
  /** A value that is a change, a rate or a share, or that holds only sometimes: not what a page shows as one number. */
  change: new RegExp(
    [
      String.raw`(?<![a-z])(?:by|adds?|added|plus|per|each|every|extra|additional|another|doubles?|doubled|half|twice|times|increases?|increased|decreases?|decreased|reduces?|reduced|raises?|raised|drops?|dropped|grows?|gains?|loses?)(?![a-z])`,
      String.raw`[0-9] ?%`,
      String.raw`(?<![a-z])(?:if|otherwise|may|might|could|usually|typically|sometimes|optionally|default)(?![a-z])`,
    ].join("|"),
  ),
} as const;

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
 * A selector engine in the browser's isolated world, which script of the page
 * cannot reach. `<engine>=is:<path>` keeps an element if it is the node at
 * that place in its document. It is how the element the browser library found
 * is tied to the same node as seen through the debugging interface.
 */
const ENGINE = "rpcheck";
const ENGINE_SOURCE = `({
  query(root, body) { return this.queryAll(root, body)[0]; },
  queryAll(root, body) {
    ${PATH_OF}
    return root instanceof Element && root.ownerDocument === document && body.startsWith("is:") && pathOf(root) === body.slice(3) ? [root] : [];
  }
})`;

let engineRegistered: Promise<void> | undefined;
/** Once in a process: the browser library keeps selector engines for every context made afterwards. */
function registerEngine(): Promise<void> {
  engineRegistered ??= selectors.register(ENGINE, ENGINE_SOURCE, { contentScript: true });
  // A registration that failed is tried again by the next check, not remembered.
  engineRegistered.catch(() => void (engineRegistered = undefined));
  return engineRegistered;
}

/** The smallest text the engine takes as legible, and the least opacity, with all ancestors. */
const LEGIBLE = { glyphHeightPx: 6, glyphWidthPx: 2, fontPx: 8, opacity: 0.9, mostLetters: 40 } as const;

/**
 * Finds a node of the main document by its place. Runs in an isolated world of
 * the engine's own making, on the document.
 */
const NODE_AT = `function (path) {
  let at = this;
  for (const part of path === "" ? [] : path.split("/")) {
    at = part === "s" ? at.shadowRoot : at.childNodes[Number(part)];
    if (!at) return null;
  }
  return at;
}`;

/**
 * What the engine needs to know of one element, asked of the element in an
 * isolated world of the engine's own making. Replacing `getComputedStyle`,
 * `getBoundingClientRect` or `innerText` in the page changes nothing here.
 *
 * `displayed` is false unless the element has a box, is visible, and nothing
 * about it or its ancestors (in the tree as drawn, slots included) makes what
 * it holds unseen: transparency, a filter, a mask, a clip. For a reading, the
 * same holds of every piece of text in it, and more: the text has a colour
 * that is not transparent, a size that can be read, no generated text beside
 * it and no override of the direction it is read in. `places` are where the
 * engine then asks the browser what is drawn on top: the centre of the box
 * and, for a reading, three places across every letter, each with the place
 * of the element that holds the letter.
 */
const FACTS_OF = `function (wantText) {
  ${PATH_OF}
  const out = { displayed: false, value: false, secret: false, text: "", places: [] };
  const el = this;
  if (!(el instanceof Element)) return out;
  const up = (node) => node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  // A colour the engine cannot read the transparency of is taken as transparent.
  const alpha = (colour) => { const m = /^rgba?\\(([^)]*)\\)$/.exec(colour); if (!m) return 0; const parts = m[1].split(/[,\\/ ]+/).filter(Boolean); return parts.length > 3 ? parseFloat(parts[3]) : 1; };
  const unseen = (start) => {
    let opacity = 1;
    for (let at = start; at; at = up(at)) {
      const style = getComputedStyle(at);
      if (style.display === "none" || style.contentVisibility === "hidden") return true;
      if (style.filter !== "none" || style.clipPath !== "none" || style.mixBlendMode !== "normal") return true;
      if ((style.webkitBoxReflect || "none") !== "none") return true;
      if ((style.maskImage || style.webkitMaskImage || "none") !== "none") return true;
      opacity *= Number(style.opacity);
    }
    return !(opacity >= ${LEGIBLE.opacity});
  };
  const inView = (x, y) => x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  const box = el.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return out;
  if (getComputedStyle(el).visibility !== "visible" || unseen(el)) return out;
  const centre = [box.left + box.width / 2, box.top + box.height / 2];
  if (!inView(centre[0], centre[1])) return out;
  out.places.push([centre[0], centre[1], null]);
  out.value = !el.closest("h1, h2, h3, h4, h5, h6, label, legend, caption, th, dt, summary, option, [role=heading]") && !el.closest("input, textarea, select, button, [contenteditable]");
  out.secret = el.matches(${JSON.stringify(SECRET_FIELDS)});
  if (wantText) {
    for (const part of [el, ...el.querySelectorAll("*")]) {
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(part, pseudo).content;
        if (content !== "none" && content !== "normal") return out;
      }
      // Nothing in it that draws something of its own beside the text: a field, a picture, a marker, a tree of its own.
      if (part !== el && part.matches("input, textarea, select, button, img, svg, canvas, video, audio, iframe, object, embed, meter, progress")) return out;
      if (getComputedStyle(part).display.includes("list-item") || part.shadowRoot) return out;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let drawn = 0;
    let last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.trim() === "") continue;
      const holder = node.parentElement;
      const style = getComputedStyle(holder);
      // Text that is not laid out, or is hidden as such, is not part of what is read either.
      let gone = style.visibility !== "visible";
      for (let at = holder; at && !gone; at = up(at)) gone = getComputedStyle(at).display === "none";
      if (gone) continue;
      if (unseen(holder)) return out;
      for (let at = holder; at; at = up(at)) {
        if (getComputedStyle(at).unicodeBidi.includes("override") || at.localName === "bdo") return out;
        // The colour of the text, of its first letter and of its first line, wherever a rule for them may sit.
        for (const pseudo of [null, "::first-letter", "::first-line"]) {
          if (pseudo === null && at !== holder) continue;
          const shown = getComputedStyle(at, pseudo);
          if (alpha(shown.color) < ${LEGIBLE.opacity} || alpha(shown.webkitTextFillColor || shown.color) < ${LEGIBLE.opacity}) return out;
        }
      }
      if ((style.webkitTextSecurity || "none") !== "none" || style.textShadow !== "none") return out;
      // Drawn at the size it is set in, or near it: text set large and scaled down to nothing is not legible.
      const scale = holder.offsetHeight > 0 ? holder.getBoundingClientRect().height / holder.offsetHeight : 1;
      if (!(scale >= 0.5) || !(parseFloat(style.fontSize) * scale >= ${LEGIBLE.fontPx})) return out;
      const where = pathOf(holder);
      // Letter by letter: each has one box, wide and high enough to be read, in the viewport, and to the right of
      // the one before it or on a line below. Text drawn in another sequence than it is written is not what is read.
      for (let index = 0; index < node.data.length; index++) {
        if (/\\s/.test(node.data[index])) continue;
        if (++drawn > ${LEGIBLE.mostLetters}) return out;
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rects = range.getClientRects();
        if (rects.length !== 1) return out;
        const rect = rects[0];
        if (!(rect.width >= ${LEGIBLE.glyphWidthPx} && rect.height >= ${LEGIBLE.glyphHeightPx})) return out;
        if (!inView(rect.left, rect.top) || !inView(rect.right, rect.bottom)) return out;
        if (last) {
          const sameLine = Math.abs(rect.top - last.top) < Math.min(rect.height, last.height) / 2;
          if (sameLine ? rect.left < last.right - 1 : rect.top < last.bottom - 1) return out;
        }
        last = rect;
        // At three places across the letter, what is found must be the text's own element: nothing over any part of it.
        for (const part of [0.25, 0.5, 0.75]) out.places.push([rect.left + rect.width * part, rect.top + rect.height / 2, where]);
      }
    }
    if (drawn === 0) return out;
    out.text = el.innerText;
  }
  out.displayed = true;
  return out;
}`;

/** Where the element is that a found node is, or is the text of. */
const HOLDER_PATH = `function () {
  ${PATH_OF}
  const node = this.nodeType === 3 ? this.parentNode : this;
  return node && node.ownerDocument === document ? pathOf(node) : null;
}`;

/** Whether a node the browser found at a place is the element or lies inside it, shadow trees included. */
const HOLDS = `function (hit) {
  for (let at = hit; at; at = at.parentNode || at.host || null) if (at === this) return true;
  return false;
}`;

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
  /** How long the browser is given to switch a page's script off before the page is closed. */
  leaveMs: 2_000,
  /** Past the check's own limit, how long the browser is given before the check is given up and its context closed. */
  graceMs: 5_000,
} as const;

export type CheckOptions = {
  readonly browser: Browser;
  /** The target's address. Only its origin is used: a binding's paths are paths of the origin. */
  readonly baseUrl: string;
  readonly runId: string;
  readonly binding: Binding;
  /** The text of the criteria snapshot the binding is for, whole and exactly as approved. */
  readonly criteria: string;
  /** The whole check may take this long. Default: a time worked out from the binding. */
  readonly limitMs?: number;
};

/** Ends a check as unverified. Thrown inside, never out of `carryOutCheck`. */
class Stop extends Error {
  constructor(readonly reason: UnverifiedReason) {
    super(reason);
  }
}

/** Time that only goes forward: a clock that is set while a check runs neither shortens nor lengthens what it waits. */
const now = () => performance.now();
/** Waits until a moment has come. A timer may ring a little early: this does not return before the moment. */
async function sleepUntil(moment: number): Promise<void> {
  while (now() < moment) await sleep(Math.max(1, moment - now()));
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The key the engine puts into a fixture's body: its own for the run and the exact binding. */
export const fixtureKey = (runId: string, binding: Binding) => `rp-${sha256Hex(`${runId}\n${bindingSha256(binding)}`).slice(0, 24)}`;

/** How long a check may take if the caller sets no limit: its steps and readings at the engine's limits, and the approved settling time. */
export function defaultLimitMs(binding: Binding): number {
  const pages = binding.steps.length + binding.settling.readings;
  return 30_000 + pages * 20_000 + binding.settling.within * 3_000;
}

/**
 * Carries out one approved check and says how it ended. Never throws for
 * anything the application or the binding does: every such thing is an
 * outcome. The outcome is `verified` or `failed` only by the rules of the
 * design; everything else is `unverified` with one reason.
 */
export async function carryOutCheck(options: CheckOptions): Promise<CheckRecord> {
  const { binding } = options;
  const began = now();
  const base = {
    bindingId: binding.id,
    bindingSha256: bindingSha256(binding),
  };
  const record = (rest: Pick<CheckRecord, "outcome" | "reason" | "refused" | "contradictionSeen" | "expected" | "finalReadings" | "stepsDone" | "writesCounted" | "lastWriteAfterMs">): CheckRecord => ({ ...base, ...rest, durationMs: Math.round(now() - began) });
  const nothing = { contradictionSeen: false, finalReadings: [], stepsDone: 0, writesCounted: 0 } as const;

  // Against the criteria text first: a binding for another text is not looked at further.
  const againstText = typeof options.criteria === "string" ? criteriaProblems(binding, options.criteria) : ["no criteria text was given"];
  const refused = [...againstText, ...checkProblems(binding)];
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
  let givenUp = false;
  const inTime = () => {
    // A check that has been given up does nothing more to the application.
    if (givenUp || now() >= deadline) throw new Stop("time-ran-out");
  };

  // What the check has come to so far. Kept outside the try so that a stop can report it.
  const progress: { stepsDone: number; writesCounted: number; lastWriteAfterMs?: number; contradictionSeen: boolean; finalReadings: FinalReading[] } = { stepsDone: 0, writesCounted: 0, contradictionSeen: false, finalReadings: [] };
  let context: BrowserContext | undefined;
  let watching: Watch | undefined;
  const body = async (): Promise<CheckRecord> => {
  try {
    // A language or a time zone that is not one: found before anything is asked of the application.
    try {
      Intl.getCanonicalLocales(binding.locale);
      new Intl.DateTimeFormat("en", { timeZone: binding.timezone });
    } catch {
      throw new Stop("setup-failed");
    }
    // 1. Setup. The fixture call is made from here, outside any browser context: nothing it sets is carried into one.
    let fixtureAnswer: Record<string, unknown> | undefined;
    if (binding.setup.kind === "fixture") fixtureAnswer = await callFixture(origin, binding.setup, fixtureKey(options.runId, binding), deadline);

    // 2. A browser context with nothing stored, set as the approver saw the application.
    await registerEngine();
    try {
      context = await options.browser.newContext({ locale: binding.locale, timezoneId: binding.timezone, serviceWorkers: "block", viewport: { width: 1280, height: 720 } });
    } catch {
      throw new Stop("setup-failed");
    }
    if (givenUp) {
      // Given up while the browser was still making the context: it is closed here, since nobody else will.
      await context.close().catch(() => {});
      context = undefined;
      throw new Stop("time-ran-out");
    }
    const watch = await watchRequests(context, origin, binding);
    watching = watch;

    /** Stops the check if anything has gone wrong anywhere in it so far. */
    const sound = () => {
      if (watch.wrong !== undefined) throw new Stop(watch.wrong);
      inTime();
    };

    // 3. The steps, in sequence, and nothing else.
    let current: Page | undefined;
    let lastWriteAt: number | undefined;
    const firstStepAt = now();
    for (const step of binding.steps) {
      sound();
      if (step.kind === "open") {
        if (current) await closeByEngine(watch, current);
        current = await openPage(context, watch, origin, step.path, deadline);
      } else if (step.kind === "fill") {
        const page = pageAt(current, origin, step.path);
        const { found: field, facts } = await displayed(page, watch, step.locator, deadline);
        let text: string;
        if (step.value.from === "literal") {
          // No credentials in a binding: a secret is never written out to be signed and shown.
          if (facts.secret) throw new Stop("secret-field-literal");
          text = step.value.text;
        } else {
          text = fixtureValue(fixtureAnswer, step.value.field);
          // The same rule as for a literal, for a value only known now.
          const typed = text;
          const expectedOnes = [[binding.expected.value, expected] as const, ...binding.steps.flatMap((other) => (other.kind === "see" ? [[other.expected.value, expectedInUnit(other.expected.value, other.reading.unit)] as const] : []))];
          if (expectedOnes.some(([value, spelled]) => holdsValue(typed, value, spelled, "made"))) throw new Stop("typed-value-is-expected");
        }
        await field.fill(text, { timeout: CHECK_LIMITS.actionMs }).catch(() => {
          throw new Stop("step-not-done");
        });
        await atRest(page, watch, deadline);
      } else if (step.kind === "act") {
        const page = pageAt(current, origin, step.path);
        const { found: control } = await displayed(page, watch, step.locator, deadline);
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
          lastWriteAt = written[0]!.answeredAt ?? now();
          progress.lastWriteAfterMs = Math.ceil(lastWriteAt - began);
          // The settling time is counted from the moment the record gives, so that the record shows all of it.
          lastWriteAt = began + progress.lastWriteAfterMs;
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
          if (now() >= until) throw new Stop(problem ?? "condition-not-met");
          await sleep(Math.min(CHECK_LIMITS.retryMs, until - now(), deadline - now()));
        }
      }
      progress.stepsDone += 1;
    }
    sound();
    if (current) await closeByEngine(watch, current);

    // 4. The final readings: the first at once, the last not before the approved time has passed since the last
    // write (in a check with no write, since its first step), the others spread between.
    const count = binding.settling.readings;
    const from = now();
    const to = Math.max(from, (lastWriteAt ?? firstStepAt) + binding.settling.within * 1_000);
    let unclean: UnverifiedReason | undefined;
    for (let index = 0; index < count; index++) {
      const due = from + ((to - from) * index) / (count - 1);
      if (due > deadline) throw new Stop("time-ran-out");
      await sleepUntil(due);
      sound();
      const afterMs = Math.floor(now() - began);
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

    const values = progress.finalReadings.map((reading) => reading.value!);
    // Verified: from some reading on, through the last, the expected value, at least twice.
    let tail = 0;
    while (tail < values.length && values[values.length - 1 - tail] === expected) tail += 1;
    const verified = tail >= 2;
    // Failed: every reading, from the first to the last after the whole approved time, the same other value.
    const contradicted = !verified && values.every((value) => value === values[0]) && values[0] !== expected;
    // What the page showed may be the engine's own doing, if the engine kept the page from another host.
    if (contradicted && watch.blockedOtherHost) throw new Stop("other-host-blocked");
    if (verified || contradicted) {
      // And it may be what a page shows before it has drawn its value, or before it corrects it. One more reading
      // is held on its page for the whole approved time: a verdict is the same value there at the start and the end.
      const afterMs = Math.floor(now() - began);
      const held = await readHeld(context, watch, origin, binding.observation, binding.settling.within * 1_000, deadline);
      progress.finalReadings.push({ afterMs, value: held[0] }, { afterMs: Math.floor(now() - began), value: held[1] });
      if (held[0] !== expected || held[1] !== expected) progress.contradictionSeen = true;
      const stood = verified ? expected : values[0];
      if (held[0] !== stood || held[1] !== stood) throw new Stop("final-readings-disagree");
    }
    // Every page still open, one the application opened itself included, is closed as the engine closes its own.
    for (const page of context.pages()) await closeByEngine(watch, page);
    // Nothing is open now, so nothing new is sent. What was sent and is not yet accounted for (a request that
    // failed a moment ago, whose reason is still being found out) is waited for: no verdict is given over it.
    await allAccounted(watch, deadline);
    sound();
    await context.close();
    context = undefined;
    if (watch.inFlight.size > 0) throw new Stop("page-not-at-rest");
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);
    // The engine kept a page from what it had registered to do on being left. Whatever that was, it was not done.
    if (watch.leaveSuppressed) throw new Stop("leave-script-suppressed");
    if (verified) return record({ outcome: "verified", expected, ...progress });
    if (contradicted) return record({ outcome: "failed", expected, ...progress });
    throw new Stop("final-readings-disagree");
  } catch (error) {
    // Past its time limit, whatever stopped a check may only have been the limit: an action of the browser cut short.
    // Pages left open by a check that stopped early are closed as any other: with their script off.
    if (context && watching && !givenUp) for (const page of context.pages()) await closeByEngine(watching, page).catch(() => {});
    const reason: UnverifiedReason = !(error instanceof Stop) ? "engine-error" : now() >= deadline ? "time-ran-out" : error.reason;
    return record({ outcome: "unverified", reason, expected, ...progress });
  }
  };
  // A page can keep the browser busy for as long as it likes. The check does not wait for it: past its limit and a
  // grace, it is given up, and its context is closed under it.
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<CheckRecord>((resolve) => {
    timer = setTimeout(() => {
      givenUp = true;
      resolve(record({ outcome: "unverified", reason: "time-ran-out", expected, ...progress, finalReadings: [...progress.finalReadings] }));
    }, Math.max(0, deadline - now()) + CHECK_LIMITS.graceMs);
  });
  const run = body();
  try {
    return await Promise.race([run, gaveUp]);
  } finally {
    clearTimeout(timer);
    const closing = context;
    if (closing) await Promise.race([closing.close().catch(() => {}), sleep(CHECK_LIMITS.graceMs)]);
    // Whatever the given-up body still does, it does to a closed context, and what it throws is nobody's.
    void run.catch(() => {});
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
      signal: AbortSignal.timeout(Math.max(1, Math.min(CHECK_LIMITS.fixtureMs, deadline - now()))),
    });
    if (answer.status < 200 || answer.status > 299) throw new Error("not answered with success");
    // Read no further than the limit: an answer that never ends is not kept.
    if (Number(answer.headers.get("content-length") ?? "0") > CHECK_LIMITS.fixtureAnswerBytes) throw new Error("answer too long");
    const chunks: Buffer[] = [];
    let length = 0;
    const reader = answer.body?.getReader();
    for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
      length += part.value.byteLength;
      if (length > CHECK_LIMITS.fixtureAnswerBytes) {
        await reader!.cancel().catch(() => {});
        throw new Error("answer too long");
      }
      chunks.push(Buffer.from(part.value));
    }
    const bytes = Buffer.concat(chunks);
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
  /** The engine kept the page from another host at least once. */
  blockedOtherHost: boolean;
  /** A page the engine closed had something registered to do on being left, which the engine kept it from. */
  leaveSuppressed: boolean;
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
async function watchRequests(context: BrowserContext, origin: string, binding: Binding): Promise<Watch> {
  let window: ActWindow | undefined;
  const writes = new Map<Request, Written>();
  const watch: Watch = {
    wrong: undefined,
    blockedOtherHost: false,
    leaveSuppressed: false,
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

  await context.route("**/*", (route) => {
    if (toTarget(route.request()) || !/^https?:/i.test(route.request().url())) return route.continue();
    watch.blockedOtherHost = true;
    return route.abort();
  });
  // A socket is not a request: what goes through one is not seen. None is let through to another host.
  await context.routeWebSocket(/.*/, (socket) => {
    try {
      if (new URL(socket.url()).host === new URL(origin).host) return void socket.connectToServer();
    } catch {
      // Not an address: closed like one to another host.
    }
    watch.blockedOtherHost = true;
    void socket.close();
  });
  // A worker shared between pages sends its requests where no page's events show them. Pages are given none.
  // Nor a request that is put by for the browser to send when the page is gone.
  await context.addInitScript("delete globalThis.SharedWorker; delete globalThis.fetchLater;");

  /** Whether an answer sends the browser on to another host. */
  const sentElsewhere = (response: { status(): number; headers(): Record<string, string>; url(): string }): boolean => {
    if (response.status() < 300 || response.status() > 399) return false;
    try {
      return new URL(response.headers()["location"] ?? "", response.url()).origin !== origin;
    } catch {
      return true;
    }
  };
  context.on("request", (request) => {
    watch.inFlight.add(request);
    const url = toTarget(request);
    // A request to another host that the browser was sent to by an answer: not one the engine could block.
    if (!url && request.redirectedFrom() && /^https?:/i.test(request.url())) watch.wrong ??= "redirect-to-other-host";
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
    if (sentElsewhere(response)) watch.wrong ??= "redirect-to-other-host";
    const written = writes.get(request);
    if (written) {
      written.status = status;
      written.answeredAt = now();
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
    if (cancelled && window) return void (window.aborted += 1);
    // A request that fails because its answer sent the browser to a host the engine blocks is that, and not a
    // failure of the application's. The browser may tell of the failure before it tells of the answer: the answer
    // is asked for, and until it is known the request counts as in flight, so that no step goes on without it.
    watch.inFlight.add(request);
    void request
      .response()
      .catch(() => null)
      .then(async (answer) => {
        // The browser library may also tell of the failure before it has tied the request to where it was sent
        // on. A moment is given for that. If it never does, the reason given is the plainer one: either way the
        // check stops.
        const sentOn = () => (answer !== null && sentElsewhere(answer)) || (request.redirectedTo() !== null && !toTarget(request.redirectedTo()!));
        for (let waited = 0; waited < CHECK_LIMITS.quietMs && !sentOn() && watch.wrong === undefined; waited += 25) await sleep(25);
        watch.wrong ??= sentOn() ? "redirect-to-other-host" : "request-failed";
        watch.inFlight.delete(request);
      });
  });
  context.on("weberror", () => void (watch.wrong ??= "page-error"));
  return watch;
}

/**
 * Closes a page the engine has finished with. A page may send something as it
 * is left, and the browser shows such a request to nobody: it could change
 * what the application holds without the check knowing. So the page's script
 * is switched off first, and nothing is sent. If that cannot be done, the
 * check says nothing.
 */
/** What a page can register to do as it is left. (`beforeunload` is not among them: it is not run when the engine closes a page.) */
const LEAVING = new Set(["pagehide", "unload", "visibilitychange", "freeze"]);

async function closeByEngine(watch: Watch, page: Page): Promise<void> {
  if (page.isClosed()) return;
  watch.closing.add(page);
  const off = (async () => {
    const session = await page.context().newCDPSession(page);
    // What the page meant to do on being left is not done. If it meant to do anything, the check must not go on
    // as if it had: the browser is asked, of every frame, what is registered for leaving.
    // Listeners are the page's own, so they are asked for where the page's script lives: in each frame's own
    // world, of its window and its document, which script cannot put anything in the place of.
    const worlds: number[] = [];
    session.on("Runtime.executionContextCreated", (event) => void ((event.context.auxData as { isDefault?: boolean } | undefined)?.isDefault === true && worlds.push(event.context.id)));
    await session.send("Runtime.enable");
    // A frame whose world is not shown here (one the browser keeps in a process of its own) cannot be asked.
    if (worlds.length === 0 || worlds.length < page.frames().length) watch.leaveSuppressed = true;
    for (const contextId of worlds) {
      for (const expression of ["window", "document"]) {
        const { result } = await session.send("Runtime.evaluate", { expression, contextId });
        if (!result.objectId) throw new Error("no such object");
        const { listeners } = await session.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
        if (listeners.some((listener) => LEAVING.has(listener.type))) watch.leaveSuppressed = true;
      }
    }
    await session.send("Emulation.setScriptExecutionDisabled", { value: true });
    return true;
  })().catch(() => false);
  if (!(await Promise.race([off, sleep(CHECK_LIMITS.leaveMs).then(() => false)])) && !page.isClosed()) watch.wrong ??= "page-not-at-rest";
  await page.close().catch(() => {});
}

/** At the end of a check, with every page closed: waits until no request is unaccounted for, and none has been for a moment. */
async function allAccounted(watch: Watch, deadline: number): Promise<void> {
  const until = Math.min(deadline, now() + CHECK_LIMITS.restMs);
  let quietSince: number | undefined;
  for (;;) {
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);
    const at = now();
    if (watch.inFlight.size > 0) quietSince = undefined;
    else if (quietSince === undefined) quietSince = at;
    else if (at - quietSince >= 100) return;
    if (at >= until) throw new Stop(at >= deadline ? "time-ran-out" : "page-not-at-rest");
    await sleep(20);
  }
}

/** Waits until the context has no request in flight, and has had none for a while. A page that never gets there is unverified. */
async function atRest(page: Page, watch: Watch, deadline: number): Promise<void> {
  const until = Math.min(deadline, now() + CHECK_LIMITS.restMs);
  await page.waitForLoadState("load", { timeout: Math.max(1, until - now()) }).catch(() => {
    throw new Stop(now() >= deadline ? "time-ran-out" : "page-not-at-rest");
  });
  let quietSince: number | undefined;
  for (;;) {
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);
    const at = now();
    if (watch.inFlight.size > 0) quietSince = undefined;
    else if (quietSince === undefined) quietSince = at;
    else if (at - quietSince >= CHECK_LIMITS.quietMs) return;
    if (at >= until) throw new Stop(at >= deadline ? "time-ran-out" : "page-not-at-rest");
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
  const answer = await page.goto(address, { waitUntil: "load", timeout: Math.max(1, Math.min(CHECK_LIMITS.actionMs, deadline - now())) }).catch(() => null);
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

type Facts = { displayed: boolean; value: boolean; secret: boolean; text: string; places: [number, number, string | null][] };
type Shown = { found: Locator; facts: Facts };

/**
 * The one element a locator names, displayed: exactly one match in the main
 * document counting hidden ones; a box of non-zero size; visible, and not
 * made unseen by anything about it or its ancestors; in the viewport after
 * scrolling to it; and it, or something inside it, is what the browser finds
 * at the centre of its box. For a reading (`wantText`), the same of every
 * piece of its text: what is read is what is drawn, with nothing over it.
 *
 * Everything is asked of ONE node, in an isolated world of the engine's own:
 * the node the locator found, and no other the page might put in its place
 * between two questions.
 */
async function displayed(page: Page, watch: Watch, locator: BoundLocator, deadline: number, wantText = false): Promise<Shown> {
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
  const box = await found.boundingBox({ timeout: 2_000 }).catch(() => null);
  if (!box) throw new Stop("element-not-displayed");

  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const cdp = session;
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id });
    const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
    /** The node the browser's own hit test finds at a place in the viewport, in the engine's world; undefined if none. */
    const hitAt = async (x: number, y: number): Promise<string | undefined> => {
      // The browser takes this place counted from the top of the document, and finds only what is in the viewport.
      // Were that to change, the node found would not be the element, and the reading would be unverified.
      const hit = await cdp.send("DOM.getNodeForLocation", { x: Math.round(x + cssVisualViewport.pageX), y: Math.round(y + cssVisualViewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }).catch(() => undefined);
      if (!hit) return undefined;
      // A node of another document, such as a frame laid over the element, does not come into this world.
      const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId, executionContextId }).catch(() => undefined);
      return resolved?.object.objectId;
    };
    const call = async (objectId: string, functionDeclaration: string, args: object[]) => (await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args, returnByValue: true })).result.value as unknown;

    // Which node is it? The node at the centre is it or lies inside it: one of that node's ancestors, then.
    const first = await hitAt(box.x + box.width / 2, box.y + box.height / 2);
    if (first === undefined) throw new Stop("element-not-displayed");
    const hitPath = await call(first, `function () { ${PATH_OF}\n return this.ownerDocument === document || this === document ? pathOf(this) : null; }`, []);
    if (typeof hitPath !== "string" || !/^[0-9s/]*$/.test(hitPath)) throw new Stop("element-not-displayed");
    const parts = hitPath === "" ? [] : hitPath.split("/");
    let place: string | undefined;
    for (let length = parts.length; length > 0 && parts.length - length < 200; length--) {
      const candidate = parts.slice(0, length).join("/");
      if ((await found.locator(`${ENGINE}=is:${candidate}`).count()) === 1) {
        place = candidate;
        break;
      }
    }
    if (place === undefined) throw new Stop("element-not-displayed");
    const root = await cdp.send("Runtime.evaluate", { expression: "document", contextId: executionContextId });
    const node = await cdp.send("Runtime.callFunctionOn", { objectId: root.result.objectId!, functionDeclaration: NODE_AT, arguments: [{ value: place }] });
    const element = node.result.objectId;
    if (!element) throw new Stop("element-not-displayed");

    if (wantText) {
      // A tree of its own inside the element, a closed one too, or a document: it could draw beside the text.
      type Described = { shadowRoots?: unknown[]; contentDocument?: unknown; children?: Described[] };
      const { node: described } = (await cdp.send("DOM.describeNode", { objectId: element, depth: -1, pierce: true })) as { node: Described };
      const own = (at: Described): boolean => (at.shadowRoots?.length ?? 0) > 0 || at.contentDocument !== undefined || (at.children ?? []).some(own);
      if (own(described)) throw new Stop("element-not-displayed");
    }
    const facts = (await call(element, FACTS_OF, [{ value: wantText }])) as Facts;
    // Still the node the locator finds, and still at its place.
    if ((await found.count()) !== 1 || (await found.locator(`${ENGINE}=is:${place}`).count()) !== 1) throw new Stop("element-not-displayed");
    if (!facts || facts.displayed !== true || !Array.isArray(facts.places) || facts.places.length === 0) throw new Stop("element-not-displayed");
    // At every place: what the browser finds there is the element or inside it. Nothing lies over the text.
    // At a letter, it is the letter's own element, or the text itself: not something else inside the element, drawn over it.
    for (const [x, y, holder] of facts.places) {
      const hit = await hitAt(x, y);
      if (hit === undefined) throw new Stop("element-not-displayed");
      const held = holder === null ? (await call(element, HOLDS, [{ objectId: hit }])) === true : (await call(hit, HOLDER_PATH, [])) === holder;
      if (!held) throw new Stop("element-not-displayed");
    }
    return { found, facts };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("element-not-displayed");
  } finally {
    await session?.detach().catch(() => {});
  }
}

/** The number a displayed element shows, read from its one node; and the same again after a moment, or it is not at rest. */
async function readShown(page: Page, watch: Watch, origin: string, reading: Reading, deadline: number): Promise<string> {
  const read = async () => {
    const { facts } = await displayed(page, watch, reading.locator, deadline, true);
    if (!facts.value) throw new Stop("element-not-a-value");
    // Still the page that was opened: nothing has taken it elsewhere while it was read.
    pageAt(page, origin, reading.path);
    const value = readStrictNumber(String(facts.text).trim(), reading.valueKind, reading.unit);
    if (value === undefined) throw new Stop("reading-not-a-number");
    return value;
  };
  const value = await read();
  await sleep(CHECK_LIMITS.quietMs);
  if ((await read()) !== value) throw new Stop("page-not-at-rest");
  return value;
}

/**
 * One reading: a page the engine has just opened at the reading's path, with
 * nothing done in it; the one element, displayed, that is a place a value is
 * shown; its text; a number by the strict grammar. The page is closed again.
 * Returns the number in plain decimal form.
 */
async function readOnce(context: BrowserContext, watch: Watch, origin: string, reading: Reading, deadline: number): Promise<string> {
  const page = await openPage(context, watch, origin, reading.path, deadline);
  try {
    return await readShown(page, watch, origin, reading, deadline);
  } finally {
    await closeByEngine(watch, page);
  }
}

/**
 * A reading that is held: read, and read again on the same page once the
 * approved settling time has passed since the page was opened. A value that an
 * application draws only after a while (a placeholder first) shows itself
 * here. Returns both values.
 */
async function readHeld(context: BrowserContext, watch: Watch, origin: string, reading: Reading, holdMs: number, deadline: number): Promise<[string, string]> {
  const page = await openPage(context, watch, origin, reading.path, deadline);
  try {
    const opened = now();
    const first = await readShown(page, watch, origin, reading, deadline);
    if (opened + holdMs > deadline) throw new Stop("time-ran-out");
    await sleepUntil(opened + holdMs);
    if (watch.wrong !== undefined) throw new Stop(watch.wrong);
    return [first, await readShown(page, watch, origin, reading, deadline)];
  } finally {
    await closeByEngine(watch, page);
  }
}
