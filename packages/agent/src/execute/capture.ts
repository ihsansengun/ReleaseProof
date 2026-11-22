/**
 * What the browser showed and said while a scenario ran: a picture after each
 * step, the errors the page wrote to its console, and the requests that
 * failed. Collected only when a run asks for it.
 *
 * All of it is evidence of what happened in the browser. None of it is a
 * comparison, and nothing here or downstream derives a verdict or a
 * requirement's status from it: a clean console and a page that loaded say
 * nothing about whether a requirement holds.
 *
 * It leaves the machine, so it is kept small and kept clean:
 *
 *   - text passes through the session's own scrubbing (the secrets the
 *     executor was given) and through `redact` (e-mail addresses,
 *     credentials, tokens, long opaque values), and is cut to a length;
 *   - an address is given as its path, without query, fragment or host;
 *   - a picture cannot be redacted after it is taken, so before each one
 *     every password, card and one-time-code field in the page itself, and
 *     every field the executor typed a secret into, is covered. Nothing is
 *     done to the page to take it: an animation is left to run as it would;
 *   - there is a limit on each picture, on all pictures of a scenario
 *     together, and on how many console and network entries are kept. What a
 *     limit left out is counted and said, never dropped silently.
 */
import path from "node:path";
import type { ConsoleMessage, Locator, Page, Request, Response } from "playwright";
import { redact } from "../report/diagnostics.ts";
import type { Session } from "./tools.ts";

export const CAPTURE_LIMITS = {
  /** The largest single picture kept, in bytes. */
  screenshotBytes: 400_000,
  /** All pictures of one scenario together, in bytes. */
  screenshotBytesPerScenario: 3_000_000,
  /** Console and network entries kept per scenario, each. */
  entries: 200,
  /** Characters of any one text. */
  text: 300,
  /** Entries of each kind kept from any one step, so that a noisy step does not use up the whole allowance. */
  entriesPerStep: 40,
  /** Characters of a text that are looked at at all. The rest is dropped before anything else is done with it. */
  textRead: 4_000,
} as const;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type CapturedStep = {
  /** The step's place in the scenario, from 1. */
  step: number;
  /** When the step began and how long it took, in milliseconds from the start of the scenario. */
  atMs: number;
  durationMs: number;
  /** The picture taken after the step, by file name in the scenario's directory. Absent when none was kept. */
  screenshot?: string;
  /** Why there is no picture, when there is none. */
  noScreenshot?: string;
};

export type CapturedConsole = { step: number; level: "error" | "uncaught"; text: string };
export type CapturedRequest = {
  step: number;
  method: string;
  /** The path asked for, without query, fragment or host. */
  path: string;
  /** The status answered. 0 when the request got no answer. */
  status: number;
  kind: string;
  /** Why there was no answer, when there was none. */
  failure?: string;
};

export type Capture = {
  steps: CapturedStep[];
  console: CapturedConsole[];
  network: CapturedRequest[];
  /** What the limits left out. Empty when nothing was. */
  leftOut: { screenshots: number; console: number; network: number };
};

type Collector = {
  capture: Capture;
  startedAt: number;
  screenshotBytes: number;
  /** Fields the executor typed a secret into, to be covered in every picture. */
  secretFields: Locator[];
  origin: string;
  stop: () => void;
};

const collectors = new WeakMap<Session, Collector>();

/**
 * Credentials under names the shared redaction passes over: access_token,
 * clientSecret, pwd and the like. Every repetition is bounded and the name
 * must start where a word starts, so the time it takes grows with the length
 * of the text and no faster. The engine's own placeholder ({{secret:…}}) and
 * what is already redacted are left as they are.
 */
const NAMED = /(?<![A-Za-z0-9_{-])([A-Za-z0-9_-]{0,40}(?:token|secret|passw(?:or)?d|passcode|pwd|apikey|api_key|credential)[A-Za-z0-9_-]{0,40}["']?\s{0,3}[:=]\s{0,3}["']?)(?!\[redacted)([^\s"',;&}\]]{1,200})/gi;

/** A part of a path segment that is a key or a token more often than a name: long, with letters and digits mixed. */
const opaquePart = (part: string) => part.length >= 12 && /\d/.test(part) && /[A-Za-z]/.test(part);

/**
 * A path made fit to leave the machine, segment by segment: an e-mail address
 * and a long mixed run of letters and digits are replaced, and everything else
 * is kept, so that a failed request can still be told from another. The stem
 * and the ending of a file name stay ("app-[redacted].js").
 */
export function cleanPath(session: Session, pathname: string): string {
  // Cut first, as text is: nothing below may take time that grows faster than the path.
  const scrubbed = session.vault.scrub((pathname.split(";")[0] ?? "/").slice(0, 1_000));
  const segments = scrubbed
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      // The engine's own placeholder for a secret stands as it is.
      if (/^\{\{secret:[^}]{1,80}\}\}$/.test(segment)) return segment;
      let shown = segment;
      try {
        shown = decodeURIComponent(segment);
      } catch {
        // Looked at as it is written.
      }
      // Something on each side of an @, and a dot after it: an e-mail address.
      const at = shown.indexOf("@");
      if (at > 0 && shown.indexOf(".", at) > at + 1) return "[redacted-e-mail]";
      const parts = segment.split(/([-_.~])/).map((part) => (opaquePart(part) ? "[redacted]" : part));
      return parts.join("").slice(0, 80);
    });
  return `/${segments.join("/")}`.slice(0, 200);
}

/**
 * Makes a text fit to leave the machine. Cut first: a page can write a line of
 * any length, and nothing below may take time that grows faster than it.
 * Then characters that are not shown (they can split a word a pattern looks
 * for), the session's own secrets, addresses down to their cleaned path, the
 * shared redaction, credentials under other names, and the final length.
 */
const clean = (session: Session, text: string): string => {
  const read = text.length > CAPTURE_LIMITS.textRead ? text.slice(0, CAPTURE_LIMITS.textRead) : text;
  const shown = session.vault.scrub(read.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, "").replace(/\s+/g, " "));
  // An address inside a text is set aside, so that the rules for text do not take a long path for one opaque value.
  const paths: string[] = [];
  const held = shown.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]{1,2000}/gi, (address) => {
    let path = "[address]";
    try {
      path = cleanPath(session, new URL(address).pathname);
    } catch {
      // Not an address after all.
    }
    paths.push(path);
    return `\u0001${paths.length - 1}\u0001`;
  });
  const flat = redact(held)
    .replace(NAMED, "$1[redacted]")
    .replace(/\u0001(\d+)\u0001/g, (_whole, index) => paths[Number(index)] ?? "[address]")
    .trim();
  return flat.length > CAPTURE_LIMITS.text ? `${flat.slice(0, CAPTURE_LIMITS.text - 1)}…` : flat;
};

/** The cleaned path of an address. Undefined when the address is not on the application. */
function pathOf(session: Session, address: string, origin: string): string | undefined {
  try {
    const url = new URL(address);
    return url.origin === origin ? cleanPath(session, url.pathname) : undefined;
  } catch {
    return undefined;
  }
}

/** Starts collecting for a session. Returns the record that fills as the scenario runs. */
export function startCapture(session: Session, startedAt: number): Capture {
  const capture: Capture = { steps: [], console: [], network: [], leftOut: { screenshots: 0, console: 0, network: 0 } };
  const origin = new URL(session.baseUrl).origin;
  const page: Page = session.page;
  // What happens while or after the last step is that step's: there is no step after it to belong to.
  const step = () => Math.max(1, Math.min(session.steps.length + 1, session.outcome ? session.steps.length : Number.MAX_SAFE_INTEGER));
  const room = (kept: { step: number }[], at: number) => kept.length < CAPTURE_LIMITS.entries && kept.filter((entry) => entry.step === at).length < CAPTURE_LIMITS.entriesPerStep;
  const said = (level: CapturedConsole["level"], text: string) => {
    const at = step();
    if (!room(capture.console, at)) capture.leftOut.console += 1;
    else capture.console.push({ step: at, level, text: clean(session, text) });
  };
  const failed = (entry: Omit<CapturedRequest, "step">) => {
    const at = step();
    if (!room(capture.network, at)) capture.leftOut.network += 1;
    else capture.network.push({ step: at, ...entry });
  };
  const methodOf = (method: string) => (METHODS.has(method.toUpperCase()) ? method.toUpperCase() : "OTHER");

  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") said("error", message.text());
  };
  const onPageError = (error: Error) => said("uncaught", error.message.split("\n")[0] ?? "");
  const onRequestFailed = (request: Request) => {
    const where = pathOf(session, request.url(), origin);
    // A request to anywhere else was stopped by the run itself. That is the run's doing, not a failure of the application.
    if (where === undefined) return;
    failed({ method: methodOf(request.method()), path: where, status: 0, kind: request.resourceType(), failure: clean(session, request.failure()?.errorText ?? "no answer") });
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    const where = pathOf(session, response.url(), origin);
    if (where === undefined) return;
    failed({ method: methodOf(response.request().method()), path: where, status: response.status(), kind: response.request().resourceType() });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  collectors.set(session, {
    capture,
    startedAt,
    screenshotBytes: 0,
    secretFields: [],
    origin,
    stop: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    },
  });
  return capture;
}

/** Whether a session is collecting. */
export const capturing = (session: Session): boolean => collectors.has(session);

/** Notes a field the executor typed a secret into, so that it is covered in every later picture. */
export function noteSecretField(session: Session, field: Locator): void {
  collectors.get(session)?.secretFields.push(field);
}

/**
 * Records one step: when it ran, and a picture of the page after it. The
 * picture is of the window as a person would see it, not of the whole page.
 * `mayPicture` is false when the page is not one to keep a picture of: it is
 * not on the application, or the step was dropped.
 */
export async function captureStep(session: Session, began: number, mayPicture: { ok: true } | { ok: false; why: string }): Promise<void> {
  const collector = collectors.get(session);
  if (!collector) return;
  const index = session.steps.length;
  const entry: CapturedStep = { step: index, atMs: Math.max(0, began - collector.startedAt), durationMs: Math.max(0, Date.now() - began) };
  collector.capture.steps.push(entry);
  if (!mayPicture.ok) {
    entry.noScreenshot = mayPicture.why;
    return;
  }
  if (collector.screenshotBytes >= CAPTURE_LIMITS.screenshotBytesPerScenario) {
    entry.noScreenshot = "The limit on pictures for one scenario was reached.";
    collector.capture.leftOut.screenshots += 1;
    return;
  }
  try {
    // Fields that hold a secret by their kind, and fields the executor typed a secret into.
    const mask = [session.page.locator('input[type="password"], input[autocomplete*="password" i], input[autocomplete^="cc-" i], input[autocomplete="one-time-code" i]'), ...collector.secretFields];
    let picture = await session.page.screenshot({ type: "png", mask, maskColor: "#3a3a3a", caret: "hide", timeout: 5_000 });
    let name = `step-${index}.png`;
    if (picture.length > CAPTURE_LIMITS.screenshotBytes) {
      // A busy page as a PNG can be large. The same picture, compressed, usually is not.
      picture = await session.page.screenshot({ type: "jpeg", quality: 60, mask, maskColor: "#3a3a3a", caret: "hide", timeout: 5_000 });
      name = `step-${index}.jpg`;
    }
    if (picture.length > CAPTURE_LIMITS.screenshotBytes || collector.screenshotBytes + picture.length > CAPTURE_LIMITS.screenshotBytesPerScenario) {
      entry.noScreenshot = "The picture was larger than the limit.";
      collector.capture.leftOut.screenshots += 1;
      return;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(session.outDir, name), picture);
    collector.screenshotBytes += picture.length;
    entry.screenshot = name;
  } catch {
    entry.noScreenshot = "The picture could not be taken.";
  }
}

/** Stops collecting and gives back what was collected. */
export function endCapture(session: Session): Capture | undefined {
  const collector = collectors.get(session);
  if (!collector) return undefined;
  collector.stop();
  collectors.delete(session);
  return collector.capture;
}
