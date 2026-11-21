/**
 * Where a reading may come from, so that what the executor itself put into
 * the application is never taken as evidence about the application.
 *
 * Two rules, of different reach.
 *
 * FOR EVERY RUN: a field the executor itself filled, chose in, pressed keys in
 * or gave a file to is not a place to read a value from, while the page that
 * was typed into is still the one shown. It holds the executor's own input.
 * (If the application has changed what was typed, the field shows the
 * application's answer, and may be read.)
 *
 * FOR A RUN WHOSE PLAN IS NOT THE ENGINE'S OWN (`untrustedPlan`): the question
 * is not what a value looks like but where the text read came from. Comparing
 * values would have to anticipate every way of spelling, cutting and
 * converting one. So a reading counts only if it is taken from
 *
 *   - a page the application served in answer to a GET, with a status from
 *     200 to 299, in which the executor has done nothing since it loaded, and
 *     whose address holds nothing the executor chose: no query or fragment
 *     when the executor itself asked for the address, and nothing it typed
 *     when the application chose it; or
 *   - the answer to a GET the executor made itself, with a status from 200 to
 *     299 and no query in its address.
 *
 * Everything the executor types, chooses, presses, uploads or clicks marks the
 * page as touched. What it changed is evidence only once the application
 * shows it in a page loaded afterwards: edit, save, and look again. The
 * answer to a request that carried a value never counts for that value.
 *
 * Neither rule decides which element is the right one to read. That is the
 * plan's.
 */
import type { ElementHandle, Locator } from "playwright";

export type SuppliedState = {
  /** Fields the executor put something into, as they are in the page now shown. `text` is what was typed, where it was typing. */
  fields: { handle: ElementHandle; text?: string }[];
  /** Every string the executor chose to put in: what it typed, the option it chose, the name of a file it gave. */
  inputs: string[];
  /** The page now shown: how the application was asked for it and what it answered. Absent before the first page. */
  document?: { method: string; status: number; url: string; askedByExecutor: boolean };
  /** Whether the executor has done anything in the page since it loaded. */
  touched: boolean;
  /** Set while the executor itself is asking for an address. */
  navigating: boolean;
  /** The requests the executor made itself, by the id of their response. */
  requests: Record<string, { method: string; path: string; status: number }>;
  /** How many changes the application has accepted so far: requests other than reads, answered without an error. */
  writes: number;
};

export const newState = (): SuppliedState => ({ fields: [], inputs: [], touched: false, navigating: false, requests: {}, writes: 0 });

/** The executor did something in the page: it is no longer as the application served it. */
export function noteInput(state: SuppliedState, field?: { handle: ElementHandle | null; text?: string }, chosen: string[] = []): void {
  state.touched = true;
  if (field?.handle) state.fields.push({ handle: field.handle, ...(field.text === undefined ? {} : { text: field.text }) });
  for (const text of [...(field?.text === undefined ? [] : [field.text]), ...chosen]) {
    const kept = text.trim().toLowerCase();
    if (kept !== "") state.inputs.push(kept);
  }
}

/** The application answered a request for a new page in the main window. */
export function noteDocument(state: SuppliedState, answer: { method: string; status: number; url: string }): void {
  // A redirect is an answer on the way to a page, not a page.
  if (answer.status >= 300 && answer.status < 400) return;
  state.document = { ...answer, method: answer.method.toUpperCase(), askedByExecutor: state.navigating };
  state.touched = false;
  state.fields = [];
}

/**
 * Says why a field is not a place to read from, if the executor put its own
 * input into it and the application has not changed that input since.
 */
export async function ownField(state: SuppliedState | undefined, locator: Locator | undefined): Promise<string | undefined> {
  if (!state || !locator || state.fields.length === 0) return undefined;
  for (const field of state.fields) {
    const same = await locator.evaluate((el, other) => el === other, field.handle).catch(() => false);
    if (!same) continue;
    if (field.text !== undefined) {
      const now = await locator.evaluate((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null)).catch(() => null);
      // The application changed what was typed: what the field shows now is its answer.
      if (now !== null && now !== field.text) return undefined;
    }
    return "the target is a field the executor itself put a value into, in the page now shown. It holds what was entered, which shows nothing about the application. Save the change, open the page again, and read the value where the application shows it.";
  }
  return undefined;
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
};

/** Says why the page now shown is not a source of evidence for a run whose plan is not the engine's own. */
export function pageNotEvidence(state: SuppliedState | undefined): string | undefined {
  const again = "Open the page again by its plain address after the last action, and read the value there.";
  if (!state?.document) return `no page of the application has been loaded. ${again}`;
  const page = state.document;
  if (state.touched) {
    return `the executor has acted in this page since the application served it, so what it shows now may be the executor's own input. In this run a value is read only from a page as the application served it. ${again}`;
  }
  if (page.method !== "GET") return `this page is the application's answer to a ${page.method} request, which carried the executor's own input. ${again}`;
  if (page.status < 200 || page.status > 299) return `the application answered the request for this page with status ${page.status}, so it is not a page of the feature under test. ${again}`;
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return `the address of this page could not be read. ${again}`;
  }
  if (page.askedByExecutor && (url.search !== "" || url.hash !== "")) {
    return `the executor asked for this page by an address with a query or a fragment, which a page may show back. ${again}`;
  }
  const values = [...url.searchParams.values(), ...url.searchParams.keys(), decoded(url.hash.replace(/^#/, ""))].map((v) => v.trim().toLowerCase());
  const pathText = decoded(url.pathname).toLowerCase();
  const carried = state.inputs.some((input) => values.some((value) => value !== "" && (value.includes(input) || input.includes(value))) || (input.length >= 2 && pathText.includes(input)));
  if (carried) return `the address of this page holds something the executor itself entered, which a page may show back. ${again}`;
  return undefined;
}

/** Says why an answer to a request the executor made is not a source of evidence for such a run. */
export function answerNotEvidence(request: { method: string; path: string; status: number } | undefined, readsStatus: boolean): string | undefined {
  // How the application answered is its own doing, whatever was sent.
  if (readsStatus) return undefined;
  const again = "Read the value from a GET request with a plain address, made after any change.";
  if (!request) return `the request behind this response is not on record. ${again}`;
  if (request.method.toUpperCase() !== "GET") return `this is the answer to a ${request.method} request, which may repeat what was sent to it. ${again}`;
  if (request.status < 200 || request.status > 299) return `the application answered this request with status ${request.status}; such an answer often repeats the request. ${again}`;
  if (request.path.includes("?") || request.path.includes("#")) return `the request had a query in its address, which the answer may repeat. ${again}`;
  return undefined;
}

/**
 * Where exactly a value was read, in a form that does not depend on how the
 * plan chose to point at it: the element's position in its page, or the
 * request and the field of its answer.
 */
export async function placeOf(
  state: SuppliedState,
  from: { source: "page"; page: string; locator?: Locator; fallback: string } | { source: "api"; responseId: string; field: string },
): Promise<string> {
  if (from.source === "api") {
    const request = state.requests[from.responseId];
    return `api ${request ? `${request.method.toUpperCase()} ${request.path}` : from.responseId} ${from.field}`;
  }
  const position = from.locator
    ? await from.locator
        .evaluate((el) => {
          const parts: string[] = [];
          for (let node: Element | null = el; node && node.parentElement; node = node.parentElement) {
            let index = 0;
            for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index += 1;
            parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
          }
          return parts.join("/");
        })
        .catch(() => undefined)
    : undefined;
  return `page ${from.page} ${position ?? from.fallback}`;
}
