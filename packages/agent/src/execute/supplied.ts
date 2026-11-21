/**
 * What the executor itself put into the application, and whether the
 * application has since shown, on its own, that it holds it.
 *
 * A value the executor typed into a field, chose in a list, wrote into an
 * address or sent in a request is the executor's own. Reading that same value
 * back shows that it was entered, not that the application satisfies anything.
 * So a comparison that matches such a value counts only when there is evidence
 * that does not come from the executor:
 *
 *   - a value entered on a page must have been followed by a change the
 *     application accepted (a request other than a read, answered without an
 *     error), and then by a read (a GET the application answered) that
 *     contains the value while its own address does not;
 *   - a value in an address or a request is never confirmed by the answer to
 *     that same request, only by a later read that does not carry it;
 *   - a field the executor filled is never the place to read the value from
 *     while the page that was typed into is still the one shown.
 *
 * This is how "edit, save, look again" keeps working: the look again is the
 * independent evidence. Nothing here decides which element is the right one to
 * read; that remains the plan's.
 */
import type { ElementHandle, Locator } from "playwright";

export type Supplied = {
  /** The step at which the executor supplied it. */
  step: number;
  how: "typed" | "selected" | "address" | "request";
  /** The value, lower-cased with spaces collapsed. Never printed: it may be a secret. */
  text: string;
  /** Every number the value contains. */
  numbers: number[];
  /** Whether a change must be accepted by the application before a read can confirm it. */
  needsWrite: boolean;
  written: boolean;
  /** The read that showed the application holds the value: its method and path. */
  confirmedBy?: string;
  /** For a value sent in a request the executor made itself: the id of its response. */
  responseId?: string;
};

export type SuppliedState = {
  entries: Supplied[];
  /** Fields the executor filled or chose in, as they are in the page now shown. */
  filled: ElementHandle[];
  /** Answers still being read. */
  pending: Promise<void>[];
};

const NUMBER = /(?<![\p{L}\p{N}_.])-?\d[\d,]*(?:\.\d+)?(?![\p{L}_])/gu;
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? []).map((n) => Number(n.replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `inner` appears in `outer` as whole words. Both lower-cased. */
function within(outer: string, inner: string): boolean {
  if (inner.length < 2) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(inner)}(?![\\p{L}\\p{N}])`, "u").test(outer);
}

export function note(state: SuppliedState, step: number, how: Supplied["how"], value: string, extra: { responseId?: string; written?: boolean } = {}): void {
  const text = squash(value);
  if (text === "") return;
  state.entries.push({
    step,
    how,
    text,
    numbers: numbersIn(text),
    needsWrite: how === "typed" || how === "selected",
    written: extra.written === true,
    ...(extra.responseId ? { responseId: extra.responseId } : {}),
  });
}

/**
 * The parts of an address that are data the executor chose: every query value
 * and every path segment that holds a digit. A plain word in a path is a
 * route, not a value.
 */
export function addressData(url: URL): string[] {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  return [...url.pathname.split("/").filter((segment) => /\d/.test(segment)), ...url.searchParams.values(), url.hash.replace(/^#/, "")].map(decode).filter((s) => s.trim() !== "");
}

/** Everything an address can carry a value in: each path segment and each query name and value, decoded. */
export function addressParts(url: URL): string[] {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  return [...url.pathname.split("/"), ...[...url.searchParams.values()], ...[...url.searchParams.keys()], url.hash.replace(/^#/, "")].map(decode).filter((s) => s.trim() !== "");
}

/** Every string and number inside a request body. */
export function scalars(body: unknown, depth = 0): string[] {
  if (depth > 6 || body === null || body === undefined) return [];
  if (typeof body === "string" || typeof body === "number") return [String(body)];
  if (Array.isArray(body)) return body.slice(0, 200).flatMap((item) => scalars(item, depth + 1));
  if (typeof body === "object") return Object.values(body).slice(0, 200).flatMap((item) => scalars(item, depth + 1));
  return [];
}

/** Whether a text (an address, a body) contains the supplied value. */
function holds(haystack: string, entry: Supplied): boolean {
  const text = squash(haystack);
  if (within(text, entry.text)) return true;
  if (entry.numbers.length === 0) return false;
  const found = numbersIn(text);
  return entry.numbers.every((n) => found.some((f) => Math.abs(f - n) < 1e-9));
}

const readable = (body: string) =>
  body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

/** The largest answer read in search of a value. */
const MAX_BODY = 2_000_000;

/**
 * Takes note of one answer of the application. A change it accepted lets the
 * values entered before it be confirmed; a read confirms each value it
 * contains, unless the request for it carried that value itself.
 */
export function noteAnswer(state: SuppliedState, answer: { method: string; url: URL; status: number; body: () => Promise<string> }): void {
  if (state.entries.length === 0 || answer.status >= 400) return;
  const method = answer.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    for (const entry of state.entries) entry.written = true;
    return;
  }
  if (method !== "GET") return;
  const carried = addressParts(answer.url).join("\n");
  const open = state.entries.filter(
    (entry) => entry.confirmedBy === undefined && (entry.written || !entry.needsWrite) && !holds(carried, entry),
  );
  if (open.length === 0) return;
  state.pending.push(
    Promise.race([answer.body(), new Promise<string>((resolve) => setTimeout(() => resolve(""), 3_000))])
      .then((body) => {
        if (body.length === 0 || body.length > MAX_BODY) return;
        const shown = `${body}\n${readable(body)}`;
        for (const entry of open) {
          if (entry.confirmedBy === undefined && holds(shown, entry)) entry.confirmedBy = `GET ${answer.url.pathname.slice(0, 120)}`;
        }
      })
      .catch(() => {}),
  );
}

export async function settled(state: SuppliedState): Promise<void> {
  const waiting = state.pending;
  state.pending = [];
  await Promise.all(waiting);
}

/** Whether the element a value is read from is a field the executor filled in the page now shown. */
async function isFilled(state: SuppliedState, locator: Locator | undefined): Promise<boolean> {
  if (!locator) return false;
  for (const handle of state.filled) {
    const same = await locator.evaluate((el, other) => el === other, handle).catch(() => false);
    if (same) return true;
  }
  return false;
}

export type Reading = { numbers?: number[]; texts?: string[] };

/** The supplied values a reading could be an echo of. */
function echoed(state: SuppliedState, reading: Reading): Supplied[] {
  const texts = (reading.texts ?? []).map(squash).filter((t) => t !== "");
  return state.entries.filter(
    (entry) =>
      (reading.numbers ?? []).some((n) => entry.numbers.some((m) => sameNumber(n, m))) ||
      texts.some((t) => t === entry.text || within(t, entry.text) || within(entry.text, t)),
  );
}

const HOW: Record<Supplied["how"], string> = {
  typed: "typed into a field",
  selected: "chose in a list",
  address: "wrote into an address",
  request: "sent in a request",
};

/**
 * Says why a reading is not independent evidence, if it is not. Otherwise
 * returns what to put on record about it: nothing, or the entry it matched and
 * the read that confirmed it.
 */
export async function independence(
  state: SuppliedState | undefined,
  reading: Reading,
  from: { source: "page"; locator?: Locator } | { source: "api"; responseId: string },
): Promise<{ refuse: string } | { entered?: { step: number; how: Supplied["how"]; confirmedBy: string } }> {
  if (!state || state.entries.length === 0) return {};
  await settled(state);
  const matches = echoed(state, reading);
  if (matches.length === 0) return {};
  if (from.source === "api") {
    const own = matches.find((entry) => entry.responseId === from.responseId);
    return own
      ? { refuse: `the value read is one the executor itself ${HOW[own.how]} at step ${own.step}, in the very request this response answers. An answer that repeats its request shows nothing about the application. Read the value from a later request that does not carry it.` }
      : {};
  }
  if (await isFilled(state, from.locator)) {
    const own = matches[0]!;
    return { refuse: `the target is a field the executor itself filled at step ${own.step}, and it holds what was entered. That shows what was typed, not what the application holds. Save the change, open the page again, and read the value where the application shows it.` };
  }
  const open = matches.find((entry) => entry.confirmedBy === undefined);
  if (open) {
    const missing = open.needsWrite && !open.written
      ? "the application has accepted no change since"
      : "no later answer of the application has contained it, other than answers to requests that carried it themselves";
    return {
      refuse: `the value read is one the executor itself ${HOW[open.how]} at step ${open.step}, and ${missing}. A page that shows back what was entered is not evidence that the application holds it. Save the change if there is one to save, open the page again by an address that does not contain the value, and read it there.`,
    };
  }
  const latest = matches.at(-1)!;
  return { entered: { step: latest.step, how: latest.how, confirmedBy: latest.confirmedBy! } };
}
