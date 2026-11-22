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
 *     every password field, and every field the executor typed a secret into,
 *     is covered;
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
} as const;

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

const clean = (session: Session, text: string): string => {
  const flat = redact(session.vault.scrub(text)).replace(/\s+/g, " ").trim();
  return flat.length > CAPTURE_LIMITS.text ? `${flat.slice(0, CAPTURE_LIMITS.text - 1)}…` : flat;
};

/** The path of an address, and nothing else of it. Empty when it is not on the application. */
function pathOf(address: string, origin: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.origin !== origin) return undefined;
    const plain = url.pathname.split(";")[0] ?? "/";
    return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
  } catch {
    return undefined;
  }
}

/** Starts collecting for a session. Returns the record that fills as the scenario runs. */
export function startCapture(session: Session, startedAt: number): Capture {
  const capture: Capture = { steps: [], console: [], network: [], leftOut: { screenshots: 0, console: 0, network: 0 } };
  const origin = new URL(session.baseUrl).origin;
  const page: Page = session.page;
  const step = () => session.steps.length + 1;

  const said = (level: CapturedConsole["level"], text: string) => {
    if (capture.console.length >= CAPTURE_LIMITS.entries) capture.leftOut.console += 1;
    else capture.console.push({ step: step(), level, text: clean(session, text) });
  };
  const failed = (entry: Omit<CapturedRequest, "step">) => {
    if (capture.network.length >= CAPTURE_LIMITS.entries) capture.leftOut.network += 1;
    else capture.network.push({ step: step(), ...entry });
  };

  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") said("error", message.text());
  };
  const onPageError = (error: Error) => said("uncaught", error.message.split("\n")[0] ?? "");
  const onRequestFailed = (request: Request) => {
    const where = pathOf(request.url(), origin);
    // A request to anywhere else was stopped by the run itself. That is the run's doing, not a failure of the application.
    if (where === undefined) return;
    failed({ method: request.method(), path: where, status: 0, kind: request.resourceType(), failure: clean(session, request.failure()?.errorText ?? "no answer") });
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    const where = pathOf(response.url(), origin);
    if (where === undefined) return;
    failed({ method: response.request().method(), path: where, status: response.status(), kind: response.request().resourceType() });
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
    const mask = [session.page.locator('input[type="password"]'), ...collector.secretFields];
    let picture = await session.page.screenshot({ type: "png", mask, maskColor: "#3a3a3a", animations: "disabled", caret: "hide", timeout: 5_000 });
    let name = `step-${index}.png`;
    if (picture.length > CAPTURE_LIMITS.screenshotBytes) {
      // A busy page as a PNG can be large. The same picture, compressed, usually is not.
      picture = await session.page.screenshot({ type: "jpeg", quality: 60, mask, maskColor: "#3a3a3a", animations: "disabled", caret: "hide", timeout: 5_000 });
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
