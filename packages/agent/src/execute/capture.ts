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
 *   - no text a page wrote is kept: not a console message, not an
 *     exception's words. Of an error only its kind, the step it happened in
 *     and how often it happened (up to a hundred) are kept;
 *   - no address or part of one is kept. Of a request that failed: the
 *     status, the browser's kind of request, whether it was answered, the
 *     step and a count. An endpoint is named only when the path asked for is
 *     exactly one a trusted list gives a name to (`kept.ts`);
 *   - a picture cannot be redacted after it is taken, so before each one
 *     every password, card and one-time-code field in the page itself, and
 *     every field the executor typed a secret into, is covered where the
 *     page says it is. The page is asked, so a page that answers falsely
 *     can leave a field showing: this is not safe against a hostile page.
 *     Nothing is
 *     done to the page to take it: an animation is left to run as it would;
 *   - there is a limit on each picture, on all pictures of a scenario
 *     together, and on how many console and network entries are kept. What a
 *     limit left out is counted and said, never dropped silently.
 */
import path from "node:path";
import type { ConsoleMessage, Locator, Page, Request, Response, ElementHandle } from "playwright";
import { endpointOf, MOST_COUNTED, type EvidenceRoute } from "./kept.ts";
import type { Session } from "./tools.ts";

export const CAPTURE_LIMITS = {
  /** The largest single picture kept, in bytes. */
  screenshotBytes: 400_000,
  /** All pictures of one scenario together, in bytes. */
  screenshotBytesPerScenario: 3_000_000,
  /** Console and network entries kept per scenario, each. */
  entries: 60,
  /** Entries of each kind kept from any one step, so that a noisy step does not use up the whole allowance. */
  entriesPerStep: 12,
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

/** The kinds of request a browser makes. Any other is "other". */
const KINDS = new Set(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other"]);

/**
 * An error the page wrote to its console, or one it did not catch. What it said is not kept, and neither is where
 * it came from. `endpoint` names the file the browser places it in only when that file's path is on the trusted
 * list of routes; `count` is how many times such an error happened in the step.
 */
export type CapturedConsole = { step: number; level: "error" | "uncaught"; endpoint: string; count: number };
/**
 * A request to the application that failed. No address or part of one is kept. `status` is what was answered, 0
 * when nothing was; `failure` says which of the two it was; `kind` is the browser's kind of request; `endpoint`
 * names what was asked for only when its path is on the trusted list of routes.
 */
export type CapturedRequest = { step: number; status: number; kind: string; failure: "error answer" | "no answer"; endpoint: string; count: number };

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
  /**
   * The very elements a secret was typed into, held by themselves: a way of finding them may stop finding them.
   * With each, which document of the page it was in, by the engine's own count (see `documents`).
   */
  secretFields: { handle: ElementHandle; document: number | undefined }[];
  /** The secret values typed so far, so that a field found holding one is covered wherever it turns up. */
  typed: string[];
  /**
   * How many documents the page's main frame has loaded, as the browser itself reports each one to the engine.
   * Not asked of the page. Undefined until the browser has been asked to report them, and then nothing is known.
   */
  documents: number | undefined;
  /** A page of the engine's own, in a context apart from the application's, in which pictures are covered. Made when first needed. */
  easel?: Page;
  /** Set when a field that holds a secret could not be kept hold of: no picture is kept from then on. */
  uncoverable?: boolean;
  stop: () => void;
};

const collectors = new WeakMap<Session, Collector>();

/**
 * Starts collecting for a session. Returns the record that fills as the scenario runs. `routes` is the trusted
 * list of paths that may be named; with none, no endpoint is named at all.
 */
export function startCapture(session: Session, startedAt: number, routes: readonly EvidenceRoute[] = []): Capture {
  const capture: Capture = { steps: [], console: [], network: [], leftOut: { screenshots: 0, console: 0, network: 0 } };
  const origin = new URL(session.baseUrl).origin;
  const page: Page = session.page;
  // What happens while or after the last step is that step's: there is no step after it to belong to.
  const step = () => Math.max(1, Math.min(session.steps.length + 1, session.outcome ? session.steps.length : Number.MAX_SAFE_INTEGER));
  const room = (kept: { step: number }[], at: number) => kept.length < CAPTURE_LIMITS.entries && kept.filter((entry) => entry.step === at).length < CAPTURE_LIMITS.entriesPerStep;
  const count = <T extends { step: number; count: number }>(kept: T[], kind: "console" | "network", entry: T, same: (other: T) => boolean) => {
    const before = kept.find((other) => other.step === entry.step && same(other));
    if (before) before.count = Math.min(before.count + 1, MOST_COUNTED);
    else if (!room(kept, entry.step)) capture.leftOut[kind] += 1;
    else kept.push(entry);
  };
  const said = (level: CapturedConsole["level"], endpoint: string) =>
    count(capture.console, "console", { step: step(), level, endpoint, count: 1 }, (other) => other.level === level && other.endpoint === endpoint);
  const failed = (status: number, kind: string, endpoint: string) => {
    const entry: CapturedRequest = { step: step(), status, kind: KINDS.has(kind) ? kind : "other", failure: status === 0 ? "no answer" : "error answer", endpoint, count: 1 };
    count(capture.network, "network", entry, (other) => other.status === entry.status && other.kind === entry.kind && other.endpoint === endpoint);
  };
  // Nothing a page says or asks for may stop the run. What cannot be taken in is left out and counted.
  const safely = <T,>(kind: "console" | "network", listen: (event: T) => void) => (event: T) => {
    try {
      listen(event);
    } catch {
      capture.leftOut[kind] += 1;
    }
  };
  /** Whether an address is on the application itself. A request to anywhere else was stopped by the run: that is the run's doing. */
  const own = (address: string) => {
    try {
      return new URL(address).origin === origin;
    } catch {
      return false;
    }
  };

  const onConsole = safely<ConsoleMessage>("console", (message) => {
    if (message.type() !== "error") return;
    // What the message says is never read. The file the browser places it in is named only if it is on the list.
    said("error", endpointOf(routes, message.location()?.url, origin));
  });
  // Nothing of an error that was not caught is read: its words and its trace are the page's own text.
  const onPageError = safely<Error>("console", () => said("uncaught", endpointOf(routes, undefined, origin)));
  const onRequestFailed = safely<Request>("network", (request) => {
    if (own(request.url())) failed(0, request.resourceType(), endpointOf(routes, request.url(), origin));
  });
  const onResponse = safely<Response>("network", (response) => {
    const status = response.status();
    if (status < 400 || status > 599 || !own(response.url())) return;
    failed(status, response.request().resourceType(), endpointOf(routes, response.url(), origin));
  });

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  collectors.set(session, {
    capture,
    startedAt,
    screenshotBytes: 0,
    secretFields: [],
    typed: [],
    documents: undefined,
    stop: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    },
  });
  // The browser is asked to say when the main frame loads a new document. That is the only way a held element is
  // ever taken to be gone: by the browser's word, never by the page's. A change of address inside one document
  // is not reported this way, and the element is then still there.
  void page
    .context()
    .newCDPSession(page)
    .then(async (browser) => {
      await browser.send("Page.enable");
      const collector = collectors.get(session);
      if (!collector) return;
      collector.documents = 0;
      browser.on("Page.frameNavigated", (event) => {
        if (event.frame.parentId === undefined && collector.documents !== undefined) collector.documents += 1;
      });
    })
    .catch(() => undefined);
  return capture;
}

/** Whether a session is collecting. */
export const capturing = (session: Session): boolean => collectors.has(session);

/**
 * Notes a field the executor is about to type a secret into, and the secret, so that it is covered in every later
 * picture. The element itself is kept, not the way it was found: a label that changes its words would otherwise
 * leave the field uncovered. If the element cannot be taken hold of, no later picture is kept at all.
 */
export async function noteSecretField(session: Session, field: Locator, typed?: string): Promise<void> {
  const collector = collectors.get(session);
  if (!collector) return;
  if (typeof typed === "string" && typed !== "" && !collector.typed.includes(typed) && collector.typed.length < 50) collector.typed.push(typed);
  try {
    const found = await field.elementHandles();
    if (found.length === 0) throw new Error("no element");
    collector.secretFields.push(...found.map((handle) => ({ handle, document: collector.documents })));
  } catch {
    collector.uncoverable = true;
  }
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
    // Where the fields to cover are, read before and after the picture is taken: a page can move between the two.
    const before = await secretAreas(session, collector);
    // Nothing is asked of the page but the picture itself: no cover laid over it, no caret hidden, no style added.
    const raw = await session.page.screenshot({ type: "png", caret: "initial", scale: "css", timeout: 5_000 });
    const areas = [...before, ...(await secretAreas(session, collector))];
    let picture: Buffer = raw;
    let name = `step-${index}.png`;
    if (areas.length > 0 || raw.length > CAPTURE_LIMITS.screenshotBytes) {
      // Covered, and compressed if need be, in a page of the engine's own. The picture as taken is not written when there is anything to cover.
      const drawn = await redraw(session, collector, raw, areas, raw.length > CAPTURE_LIMITS.screenshotBytes);
      picture = drawn.picture;
      if (drawn.jpeg) name = `step-${index}.jpg`;
      if (!drawn.jpeg && picture.length > CAPTURE_LIMITS.screenshotBytes) {
        const smaller = await redraw(session, collector, raw, areas, true);
        picture = smaller.picture;
        name = `step-${index}.jpg`;
      }
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
    // Also when a field could not be covered: no picture is better than one that shows it.
    entry.noScreenshot = "The picture could not be taken.";
    collector.capture.leftOut.screenshots += 1;
  }
}

/** Fields that hold a secret by their kind. */
const SECRET_FIELDS = ["input", "select", "textarea"].map((tag) => `${tag}[autocomplete*="password" i], ${tag}[autocomplete*="cc-" i], ${tag}[autocomplete*="one-time-code" i]`).join(", ") + ', input[type="password"]';
/** More fields or frames than this, and no picture is kept: there is a limit to what can be covered with care. */
const MOST_AREAS = 2_000;
const MOST_FRAMES = 40;
/** How long finding the fields, and drawing the cover, may each take. */
const COVER_TIMEOUT_MS = 4_000;
const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([work, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("took too long")), ms).unref())]);
type Area = [x: number, y: number, width: number, height: number];
const rectsOf = (elements: Element[]): Area[] =>
  elements.map((element) => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height];
  });

/**
 * Where, in the window, the fields to cover are: fields that hold a secret by
 * their kind, fields the executor typed a secret into, and the whole of any
 * frame that holds such a field. Only read: the page is asked where things
 * are and nothing in it is changed.
 */
async function secretAreas(session: Session, collector: Collector): Promise<Area[]> {
  return within(findSecretAreas(session, collector), COVER_TIMEOUT_MS);
}

async function findSecretAreas(session: Session, collector: Collector): Promise<Area[]> {
  const page = session.page;
  if (page.frames().length > MOST_FRAMES + 1) throw new Error("too many frames to look into");
  const areas: Area[] = await page.locator(SECRET_FIELDS).evaluateAll(rectsOf);
  if (collector.uncoverable) throw new Error("a field that holds a secret could not be taken hold of");
  // A held element is taken to be gone only when the browser has reported a new document since it was noted.
  // Then it is in no picture. In the same document it is asked where it is, and a failure to ask, whatever the
  // cause, is a failure to cover: no picture is kept. A page cannot bring that about and keep its picture.
  const gone = new Set<ElementHandle>();
  for (const { handle, document } of [...collector.secretFields]) {
    if (document !== undefined && collector.documents !== undefined && document !== collector.documents) {
      gone.add(handle);
      continue;
    }
    const area = await handle.evaluate((element) => {
      if (!element.isConnected) return null;
      const box = (element as Element).getBoundingClientRect();
      return [box.x, box.y, box.width, box.height] as [number, number, number, number];
    });
    if (area) areas.push(area);
  }
  if (gone.size > 0) collector.secretFields = collector.secretFields.filter((held) => !gone.has(held.handle));
  // A field that holds a secret the executor typed, whichever element it is: the value may be shown again in
  // another field, by the application answering with what was sent, by the browser going back, or by a page
  // that draws its form anew.
  const holding = (elements: Element[], typed: string[]): [number, number, number, number][] =>
    elements
      .filter((element) => {
        const held = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "");
        return typed.some((value) => held.includes(value));
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      });
  const FIELDS = "input, textarea, [contenteditable]";
  if (collector.typed.length > 0) areas.push(...(await page.locator(FIELDS).evaluateAll(holding, collector.typed)));
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const inside = (await frame.locator(SECRET_FIELDS).count()) + (collector.typed.length > 0 ? (await frame.locator(FIELDS).evaluateAll(holding, collector.typed)).length : 0);
    if (inside === 0) continue;
    // A field in a frame is somewhere inside the frame's own box. The whole box is covered.
    const box = await (await frame.frameElement()).boundingBox();
    if (box) areas.push([box.x, box.y, box.width, box.height]);
  }
  // A place that is not four numbers is no answer to where a field is: no picture is kept.
  if (!areas.every((area) => Array.isArray(area) && area.length === 4 && area.every((side) => typeof side === "number" && Number.isFinite(side) && Math.abs(side) < 1_000_000))) throw new Error("a field's place could not be read");
  const shown = areas.filter(([, , width, height]) => width > 0 && height > 0);
  // Never some of them: either every field the page gave a place for is covered or no picture is kept.
  if (shown.length > MOST_AREAS) throw new Error("too many fields to cover");
  return shown;
}

/**
 * Draws a picture again with the given areas covered, as a PNG or, when asked,
 * a JPEG. Done in a page of the engine's own, in a browser context apart from
 * the application's, so that nothing is done to the page under test.
 */
async function redraw(session: Session, collector: Collector, raw: Buffer, areas: Area[], jpeg: boolean): Promise<{ picture: Buffer; jpeg: boolean }> {
  if (!collector.easel) {
    const browser = session.context.browser();
    if (!browser) throw new Error("no browser to draw in");
    collector.easel = await (await browser.newContext({ javaScriptEnabled: true, offline: true })).newPage();
  }
  const easel = collector.easel;
  const drawn = await within(easel.evaluate(
    async ({ data, areas, jpeg }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.drawImage(image, 0, 0);
      context.fillStyle = "#3a3a3a";
      // A little wider than the field, so that its edge does not show through.
      for (const [x, y, width, height] of areas) context.fillRect(Math.floor(x) - 2, Math.floor(y) - 2, Math.ceil(width) + 4, Math.ceil(height) + 4);
      return canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.6).split(",")[1] ?? "";
    },
    { data: raw.toString("base64"), areas, jpeg },
  ), COVER_TIMEOUT_MS).catch((error: unknown) => {
    // A page that hung or failed once is not drawn in again: the next picture gets a new one.
    collector.easel = undefined;
    void easel.context().close().catch(() => undefined);
    throw error;
  });
  if (drawn === "") throw new Error("nothing drawn");
  return { picture: Buffer.from(drawn, "base64"), jpeg };
}

/** Stops collecting and gives back what was collected. */
export function endCapture(session: Session): Capture | undefined {
  const collector = collectors.get(session);
  if (!collector) return undefined;
  collector.stop();
  // The page the pictures were drawn in is the engine's own, and is closed with the run.
  void collector.easel?.context().close().catch(() => undefined);
  collector.easel = undefined;
  collectors.delete(session);
  return collector.capture;
}
