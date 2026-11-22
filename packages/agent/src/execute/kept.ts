/**
 * What may leave the machine of what a browser said and asked for, and in
 * what form.
 *
 * No free text does, and no address or part of one. A console message, an
 * exception's text, the words of a locator, a value read from a page and the
 * path of a request are written or chosen by the application under test, in
 * no known form. Cleaning them by rules was tried here, first for text and
 * then for paths alone, and independent reviews found something each set of
 * rules let through. So nothing of that kind is cleaned: it is not kept.
 *
 * What is kept has a form that is checked and not guessed at:
 *
 *   - the name of an endpoint, only when the path asked for is, character
 *     for character, one that a trusted list gives a name to. Otherwise
 *     "Endpoint not recorded";
 *   - a value that is a plain number or amount.
 */

/** A path of the application that may be named in evidence, and the name it is given. Supplied by whoever operates the run, never by a page or a recording. */
export type EvidenceRoute = { id: string; path: string };

/** What stands where an endpoint would be named, when the path asked for is not on the list. */
export const ENDPOINT_NOT_RECORDED = "Endpoint not recorded";

/** The most routes a list may name. */
const MOST_ROUTES = 50;
const ROUTE_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A static path: from the root, plain letters, digits and the signs that join names. No query, no pattern, nothing to fill in. */
const ROUTE_PATH = /^\/(?:[A-Za-z0-9_.~-]{1,40}(?:\/[A-Za-z0-9_.~-]{1,40}){0,7})?$/;

/**
 * The routes of a list that are in the form a route must have. One that is
 * not, or that repeats an id or a path, is left out: a list is not made to
 * fit.
 */
export function trustedRoutes(given: unknown): EvidenceRoute[] {
  if (!Array.isArray(given)) return [];
  const routes: EvidenceRoute[] = [];
  for (const entry of given.slice(0, MOST_ROUTES)) {
    const id = (entry as { id?: unknown } | null)?.id;
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof id !== "string" || typeof path !== "string" || !ROUTE_ID.test(id) || !ROUTE_PATH.test(path)) continue;
    if (routes.some((route) => route.id === id || route.path === path)) continue;
    routes.push({ id, path });
  }
  return routes;
}

/**
 * The name of the endpoint an address asks for: the id of the route whose
 * path is exactly the address's path, on the application's own origin.
 * Anything else, and anything that cannot be read, is not recorded. Nothing
 * of the address itself is returned.
 */
export function endpointOf(routes: readonly EvidenceRoute[], address: unknown, origin: string): string {
  if (typeof address !== "string" || address.length > 2_000) return ENDPOINT_NOT_RECORDED;
  try {
    const url = new URL(address);
    if (url.origin !== origin) return ENDPOINT_NOT_RECORDED;
    return routes.find((route) => route.path === url.pathname)?.id ?? ENDPOINT_NOT_RECORDED;
  } catch {
    return ENDPOINT_NOT_RECORDED;
  }
}

/** Whether a value is what may stand where an endpoint is named: an id from the list, or the words that say there is none. */
export const isEndpoint = (ids: readonly string[], value: unknown): value is string => value === ENDPOINT_NOT_RECORDED || (typeof value === "string" && ROUTE_ID.test(value) && ids.includes(value));

/**
 * A value read from a page or stated by a requirement, if it is a plain
 * number or amount: digits, with a sign, commas between groups of three, one
 * fraction, a currency sign or a percent sign, and no space inside.
 * Undefined for anything else: words are free text, and free text is not
 * kept.
 */
export function plainAmount(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : undefined;
  if (text === undefined || text.length === 0 || text.length > 24) return undefined;
  // Digits in one run, or in groups of three with commas; then at most one fraction; nothing else between.
  if (!/^[-+]?[$€£¥]?(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:[.,]\d{1,4})?%?$/.test(text)) return undefined;
  // A long run of digits is an account or a card, not an amount.
  if (text.replace(/\D/g, "").length > 12) return undefined;
  return text;
}
