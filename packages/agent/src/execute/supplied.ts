/**
 * Where a reading may come from, so that what the executor itself put into
 * the application is never taken as evidence about the application.
 *
 * Two rules, of different reach.
 *
 * FOR EVERY RUN: a field the executor itself filled, chose in, pressed keys in
 * or gave a file to is not a place to read a value from. It holds the
 * executor's own input. A field is known again by its place in the page and
 * by its name, so a page that builds the field anew does not make it another
 * field, and neither does reading the element around it. In a page loaded
 * later, the same field is the executor's while it holds anything other than
 * what the application served it with: a browser puts typed values back when
 * it goes back in its history.
 *
 * FOR A RUN WHOSE PLAN IS NOT THE ENGINE'S OWN (`untrustedPlan`): the question
 * is not what a value looks like but where the text read came from. Comparing
 * values would have to anticipate every way of spelling, cutting and
 * converting one, and following what the executor did through the page would
 * have to anticipate every way a page carries input along. So there is one
 * way to a reading that counts:
 *
 *   - the executor opens a page by a plain address (no query, no fragment),
 *     the application answers that GET with a status from 200 to 299, the
 *     page ends up at a plain address, and the value is read before the
 *     executor does anything else in it and while it is still at that
 *     address; or
 *   - the executor makes a GET request with a plain address and no body, the
 *     application answers with a status from 200 to 299, and the value is
 *     read from that answer.
 *
 * What the executor changed is evidence only once the application shows it in
 * a page opened afterwards: edit, save, open the page again, and look.
 *
 * Neither rule decides which element is the right one to read. That is the
 * plan's.
 */
import type { Locator } from "playwright";

export type SuppliedState = {
  /** Fields the executor put something into: which page load, which page, where in it, and its name. */
  fields: { load: number; page: string; position: string; key: string }[];
  /**
   * Set when the executor has just opened a page by a plain address and done
   * nothing in it since: the address the page ended up at. Otherwise the
   * reason the page now shown is not such a page.
   */
  opened: { url: string } | { not: string };
  /** The requests the executor made itself, by the id of their response. */
  requests: Record<string, { method: string; path: string; status: number; body: boolean }>;
  /** How many changes the application has accepted so far: requests other than reads, answered without an error. */
  writes: number;
};

const AGAIN = "Open the page again by its plain address, with no query and no fragment, and read the value there before doing anything else in it.";

export const newState = (): SuppliedState => ({ fields: [], opened: { not: "no page has been opened yet" }, requests: {}, writes: 0 });

/**
 * What makes an element findable again: the load of the page it is in, the
 * page's path, its position, its name or id, and whether it holds anything
 * other than what the page was served with.
 */
async function describe(locator: Locator): Promise<{ load: number; page: string; position: string; key: string; control: boolean; editable: boolean; dirty: boolean } | undefined> {
  return locator
    .evaluate((el) => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && node.parentElement; node = node.parentElement) {
        let index = 0;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index += 1;
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      }
      const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const select = el instanceof HTMLSelectElement;
      const editable = el instanceof HTMLElement && el.isContentEditable;
      const dirty = input
        ? el.type === "checkbox" || el.type === "radio"
          ? (el as HTMLInputElement).checked !== (el as HTMLInputElement).defaultChecked
          : el.type === "file"
            ? el.value !== ""
            : el.value !== el.defaultValue
        : select
          ? el.selectedIndex !== Math.max(0, Array.from(el.options).findIndex((option) => option.defaultSelected))
          : false;
      return {
        load: performance.timeOrigin,
        page: location.pathname,
        position: parts.join("/"),
        key: el.getAttribute("name") || el.id || "",
        control: input || select,
        editable,
        dirty,
      };
    })
    .catch(() => undefined);
}

/** The executor did something in the page: it is no longer as the application served it. */
export async function noteInput(state: SuppliedState, field?: Locator): Promise<void> {
  state.opened = { not: "the executor has acted in this page since it was opened, so what it shows now may be the executor's own input" };
  const where = field ? await describe(field) : undefined;
  if (where) state.fields.push({ load: where.load, page: where.page, position: where.position, key: where.key });
}

/** The executor opened a page by an address. Says whether it is one a value may be read from. */
export function noteOpened(state: SuppliedState, asked: string, answer: { method: string; status: number } | undefined, endedAt: string, arrivedBy: string): void {
  const plain = (address: string) => !address.includes("?") && !address.includes("#");
  state.opened = !plain(asked)
    ? { not: "the executor asked for this page by an address with a query or a fragment, which a page may show back" }
    : !answer
      ? { not: "the application gave no answer of its own to the request for this page" }
      : answer.method.toUpperCase() !== "GET"
        ? { not: `this page is the answer to a ${answer.method} request` }
        : answer.status < 200 || answer.status > 299
          ? { not: `the application answered the request for this page with status ${answer.status}, so it is not a page of the feature under test` }
          : !plain(endedAt)
            ? { not: "the page ended up at an address with a query or a fragment, which a page may show back" }
            : arrivedBy !== "navigate"
              ? { not: "the page shown was reached by going back or forward in the browser's history, or by a reload, and a browser puts typed values back then" }
              : { url: endedAt };
}

const OWN = "It holds what was entered, which shows nothing about the application. Save the change, open the page again, and read the value where the application shows it.";

/**
 * Says why an element is not a place to read from, if it is, or contains, a
 * field the executor put its own input into.
 */
export async function ownField(state: SuppliedState | undefined, locator: Locator | undefined): Promise<string | undefined> {
  if (!state || !locator || state.fields.length === 0) return undefined;
  const target = await describe(locator);
  if (!target) return undefined;
  for (const field of state.fields) {
    if (field.page !== target.page) continue;
    const same = field.position === target.position || (field.key !== "" && field.key === target.key && target.control);
    if (field.load === target.load) {
      // The page that was typed into is still the one shown: the field, or anything around it.
      if (same) return `the target is a field the executor itself put a value into, in the page now shown. ${OWN}`;
      if (field.position.startsWith(`${target.position}/`)) return `the target contains a field the executor itself put a value into, in the page now shown, and what it reads may be that field. ${OWN}`;
    } else if (same && (target.dirty || target.editable)) {
      // A page loaded later: the application's, unless the field holds something the page was not served with.
      return `the target is a field the executor itself put a value into earlier, and it holds something other than what the application served this page with: a browser puts typed values back when it goes back in its history. ${OWN}`;
    }
  }
  return undefined;
}

/**
 * For a run whose plan is not the engine's own: says why a field is not read
 * at all when it holds something other than what the page was served with,
 * whoever put it there.
 */
export async function restoredField(locator: Locator | undefined): Promise<string | undefined> {
  if (!locator) return undefined;
  const target = await describe(locator);
  if (!target) return undefined;
  if (target.editable) return "the target is a text the page lets a user edit. In this run a value is not read from one: read it where the application shows it.";
  if (target.control && target.dirty) return "the target is a field that holds something other than what the application served this page with. In this run a value is not read from one: read it where the application shows it.";
  return undefined;
}

/** Says why the page now shown is not a source of evidence for a run whose plan is not the engine's own. */
export function pageNotEvidence(state: SuppliedState | undefined, shownAt: string): string | undefined {
  if (!state) return `no page has been opened yet. ${AGAIN}`;
  if ("not" in state.opened) return `${state.opened.not}. In this run a value is read only from a page the executor has just opened by a plain address. ${AGAIN}`;
  if (shownAt !== state.opened.url) return `the page has moved to another address since it was opened. ${AGAIN}`;
  return undefined;
}

/** Says why an answer to a request the executor made is not a source of evidence for such a run. */
export function answerNotEvidence(request: { method: string; path: string; status: number; body: boolean } | undefined, readsStatus: boolean): string | undefined {
  // How the application answered is its own doing, whatever was sent.
  if (readsStatus) return undefined;
  const again = "Read the value from a GET request with a plain address and no body, made after any change.";
  if (!request) return `the request behind this response is not on record. ${again}`;
  if (request.method.toUpperCase() !== "GET") return `this is the answer to a ${request.method} request, which may repeat what was sent to it. ${again}`;
  if (request.body) return `the request carried a body, which the answer may repeat. ${again}`;
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
