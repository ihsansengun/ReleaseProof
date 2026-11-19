import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { z } from "zod";
import { evaluateFormula, formulaVariables } from "../formula.ts";
import { reconcile, scaleUnclear } from "../units.ts";
import type { AssertionResult, Outcome, Scenario, Step } from "../schema.ts";
import type { SecretVault } from "../secrets.ts";

/** Everything one scenario execution accumulates. */
export type Session = {
  scenario: Scenario;
  baseUrl: string;
  context: BrowserContext;
  page: Page;
  outDir: string;
  observations: Record<string, number>;
  /**
   * Observations the executor tried to record a second time. Their recorded
   * value belongs to an earlier moment, so no formula may use them any more.
   */
  contested?: Set<string>;
  apiResponses: Map<string, { status: number; body: unknown }>;
  assertionResults: AssertionResult[];
  steps: Step[];
  outcome?: Outcome;
  vault: SecretVault;
  /**
   * Which state-changing requests may leave the browser: all of them, none,
   * or only those matching patterns such as "POST /sign-in" ("*" ends a prefix).
   */
  writes: "all" | "none" | string[];
};

/** Whether a request is permitted under a session's write policy. */
export function requestAllowed(writes: Session["writes"], method: string, pathname: string): boolean {
  if (["GET", "HEAD"].includes(method) || writes === "all") return true;
  if (writes === "none") return false;
  return writes.some((pattern) => {
    const [m, p = ""] = pattern.trim().split(/\s+/);
    if (m !== method) return false;
    return p.endsWith("*") ? pathname.startsWith(p.slice(0, -1)) : pathname === p;
  });
}

const ROLES = [
  "button", "link", "textbox", "spinbutton", "checkbox", "radio", "combobox",
  "heading", "cell", "row", "listitem", "alert", "status", "paragraph", "strong",
  "region", "group", "table", "list", "form", "dialog", "article",
] as const;

/** A row, section or other element that holds the one that is meant. */
const Container = z.object({
  by: z.enum(["role", "label", "text", "testid"]),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z.string().describe("Accessible name (role/label), visible text, or test id of the container."),
});
const WITHIN = Container.optional().describe(
  "Look only inside this element. Use it when the same text or name appears more than once on the page, for example to pick one row of a table or one section.",
);

const PageTarget = z.object({
  source: z.literal("page"),
  by: z.enum(["role", "label", "text", "testid"]),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z
    .string()
    .describe(
      "Accessible name (role/label), visible text, or test id. by=text selects the smallest element containing the text as whole words (Total does not match Subtotal); by=role needs an element that has an accessible name, which plain text containers often lack.",
    ),
  within: WITHIN,
  count: z
    .boolean()
    .default(false)
    .describe("Read how many elements match, instead of one element's text. Use for rows, items, entries."),
  read: z
    .enum(["text", "name"])
    .default("text")
    .describe('What to read from the element: its visible text, or its accessible name (the quoted name in the page tree, e.g. of a button).'),
  pattern: z
    .string()
    .optional()
    .describe("Regex with one capture group, applied to the selected element's full text, to pick one value out of it."),
});
const ApiTarget = z.object({
  source: z.literal("api"),
  responseId: z.string().describe("Id returned by api_request."),
  field: z.enum(["body", "status"]).default("body").describe('"status" reads the HTTP status code.'),
  jsonPath: z.string().default("").describe('For field=body: dot path into the JSON body, e.g. "items.0.status".'),
  count: z.boolean().default(false).describe("Read the length of the array at jsonPath instead of a value."),
});
const Target = z.discriminatedUnion("source", [PageTarget, ApiTarget]);
type Target = z.infer<typeof Target>;

const ElementRef = z.object({
  by: z.enum(["role", "label", "text", "testid"]),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z.string().describe("Accessible name (role/label), visible text, or test id."),
  within: WITHIN,
});
type ElementRef = z.infer<typeof ElementRef>;

const schemas = {
  navigate: z.object({ path: z.string().describe('Path on the application under test, e.g. "/settings".') }),
  click: z.object({ element: ElementRef }),
  fill: z.object({ element: ElementRef, text: z.string() }),
  select: z.object({ element: ElementRef, option: z.string().describe("Visible label of the option to choose.") }),
  api_request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string(),
    body: z.unknown().optional(),
  }),
  observe: z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    target: Target,
  }),
  check: z.object({ assertionId: z.string(), target: Target }),
  finish: z.object({
    outcome: z.enum(["completed", "blocked"]),
    reason: z.string(),
  }),
} as const;
export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  navigate: "Open a path on the application under test. Returns the resulting page.",
  click: "Click one element. Returns the resulting page.",
  fill: "Replace the content of one input. Returns the resulting page. Secret placeholders from the test data are substituted for you.",
  select: "Choose one option of a drop-down by its visible label. Returns the resulting page.",
  api_request:
    "Send an HTTP request to the application under test using the browser session's cookies. Returns status, body and a responseId usable as a target.",
  observe:
    "Read a number from the page or from an API response and store it under a name, for use in assertion formulas. Read it at the moment it is meaningful; it is not re-read later.",
  check:
    "Run one planned assertion. The tool reads the actual value from the target you point at and compares it in code with the expectation fixed in the plan. For kinds present and absent, the target is the element (or API field) whose existence is in question. Each assertion can be checked once; the first result is final.",
  finish:
    'End the scenario. Use "blocked" with a specific reason if something outside your control prevented a check. You do not decide pass or fail.',
};

const RATIONALE = z.string().describe("One sentence: why you are taking this step now.");

export const ALL_TOOLS = Object.keys(schemas) as ToolName[];

export const toolDefinitions = ALL_TOOLS.map((name) => ({
  name,
  description: descriptions[name],
  input_schema: z.toJSONSchema(schemas[name].extend({ rationale: RATIONALE })) as {
    type: "object";
    [k: string]: unknown;
  },
}));

// ---- helpers --------------------------------------------------------------

const SNAPSHOT_LIMIT = 20_000;
const LOCATE_TIMEOUT_MS = 3_000;
const SETTLE_TIMEOUT_MS = 10_000;
const STABLE_TIMEOUT_MS = 5_000;

export async function describePage(session: Pick<Session, "page" | "vault">): Promise<string> {
  const { page } = session;
  const url = new URL(page.url());
  let snapshot = session.vault.scrub(await page.locator("body").ariaSnapshot());
  // Whatever sits in a password field is hidden, whether or not we know it.
  const typed = await page
    .locator('input[type="password"]')
    .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value).filter((v) => v.length > 0));
  for (const value of typed) snapshot = snapshot.split(value).join("[REDACTED]");
  const body =
    snapshot.length > SNAPSHOT_LIMIT
      ? `${snapshot.slice(0, SNAPSHOT_LIMIT)}\n[snapshot cut at ${SNAPSHOT_LIMIT} of ${snapshot.length} characters]`
      : snapshot;
  return `URL: ${url.pathname}${url.search}\n${body}`;
}

/**
 * The text as a pattern that matches it only as whole words, in any case and
 * with any spacing. Plain containment would let a label match every longer
 * label that ends or begins with it: "Total" inside "Subtotal".
 */
export function wholeWords(text: string): RegExp {
  const words = text.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const body = words.join("\\s+");
  const edge = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
  const trimmed = text.trim();
  return new RegExp(`${edge(trimmed[0]) ? "(?<![\\p{L}\\p{N}])" : ""}${body}${edge(trimmed.at(-1)) ? "(?![\\p{L}\\p{N}])" : ""}`, "iu");
}

function buildIn(root: Page | Locator, ref: Omit<ElementRef, "within">): Locator {
  if (ref.by === "role") {
    if (!ref.role) throw new Error("role is required when by=role");
    return root.getByRole(ref.role, { name: ref.value, exact: true });
  }
  if (ref.by === "label") return root.getByLabel(ref.value, { exact: true });
  if (ref.by === "testid") return root.getByTestId(ref.value);
  if (ref.value.trim() === "") throw new Error("value must not be empty when by=text");
  return root.getByText(wholeWords(ref.value));
}

/** The locator for a reference, inside its container if it names one. A container that is itself ambiguous makes every match ambiguous. */
function buildLocator(page: Page, ref: ElementRef): Locator {
  return buildIn(ref.within ? buildIn(page, ref.within) : page, ref);
}

async function locate(page: Page, ref: ElementRef): Promise<Locator> {
  const locator = buildLocator(page, ref);

  // Pages may still be rendering after an action, so give the element a
  // moment to appear before deciding it is missing or ambiguous.
  const deadline = Date.now() + LOCATE_TIMEOUT_MS;
  let count = await locator.count();
  while (count !== 1 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    count = await locator.count();
  }
  if (ref.within && count !== 1) {
    const containers = await buildIn(page, ref.within).count();
    if (containers !== 1) {
      throw new Error(`Expected exactly one container for ${JSON.stringify(ref.within)}, found ${containers}. Nothing was read or done.`);
    }
  }
  if (count !== 1) {
    throw new Error(
      count === 0
        ? `Expected exactly one element for ${JSON.stringify(ref)}, found 0.`
        : `Ambiguous target: expected exactly one element for ${JSON.stringify(ref)}, found ${count}. Narrow it with "within", a role or a test id. Nothing was read or done.`,
    );
  }
  return locator;
}

/**
 * Whether an element names something or holds its value. A heading titles a
 * section and a label names a field; neither is the value the section or the
 * field shows.
 */
async function elementKind(locator: Locator): Promise<"heading" | "label" | "value"> {
  return locator.evaluate((el) => {
    if (el.matches("input, select, textarea, output, meter, progress")) return "value";
    if (el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) return "heading";
    if (el.closest('label, legend, caption, th, dt, summary, [role="columnheader"], [role="rowheader"], [role="term"]')) return "label";
    return "value";
  });
}

/**
 * Refuses a heading or a label as the place a value is read from, unless the
 * plan says the comparison is about that heading or label, or a pattern picks
 * the value out of it. The converse holds too: a comparison declared to be
 * about a heading must be pointed at one.
 */
async function requireSubject(locator: Locator | undefined, target: Target, subject: "value" | "heading" | "label", what: string): Promise<void> {
  if (!locator || target.source !== "page" || target.count) return;
  const kind = await elementKind(locator);
  if (subject !== "value") {
    if (kind !== subject) throw new Error(`${what} is about a ${subject}, and the target is not one. No result was recorded.`);
    return;
  }
  if (kind !== "value" && !target.pattern) {
    throw new Error(
      `${what} expects a value, and the target is a ${kind}: it names something and does not hold its value. Point at the element that shows the value, or give a pattern that picks the value out of this ${kind}. No result was recorded.`,
    );
  }
}

/**
 * Waits until the page has stopped changing after an action. A click may
 * start a client-side transition that neither the "load" event nor network
 * idleness reports reliably, so after the network goes quiet the URL and the
 * accessibility tree must also read the same twice in a row.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
  const read = async () => `${page.url()}\n${await page.locator("body").ariaSnapshot().catch(() => "")}`;
  const deadline = Date.now() + STABLE_TIMEOUT_MS;
  let previous = await read();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const current = await read();
    if (current === previous) return;
    previous = current;
  }
}

function parseNumber(text: string): number {
  const matches = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one number in "${text}", found ${matches.length}. Narrow the target or pass a pattern.`,
    );
  }
  return Number(matches[0]!.replace(/,/g, ""));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Reads the raw text behind a target, plus the element to highlight if any. */
async function readTarget(session: Session, target: Target): Promise<{ text: string; raw: string; locator?: Locator }> {
  const read = await readText(session, target);
  return { raw: read.text, ...read, ...narrowed(read.text, target) };
}

/** Applies the target's pattern, if it has one. */
function narrowed(text: string, target: Target): { text: string } {
  if (target.source === "api" || target.count || !target.pattern) return { text };
  const match = new RegExp(target.pattern).exec(text);
  if (!match || match[1] === undefined) {
    throw new Error(`Pattern ${target.pattern} with one capture group did not match "${text}".`);
  }
  return { text: match[1] };
}

/** The text behind a target before any pattern narrows it, plus the element to highlight if any. */
async function readText(session: Session, target: Target): Promise<{ text: string; locator?: Locator }> {
  if (target.source === "api") {
    const response = session.apiResponses.get(target.responseId);
    if (!response) throw new Error(`Unknown responseId "${target.responseId}".`);
    if (target.field === "status") return { text: String(response.status) };
    let value: unknown = response.body;
    for (const key of target.jsonPath.split(".").filter(Boolean)) {
      if (value === null || typeof value !== "object" || !(key in value)) {
        throw new Error(`Path "${target.jsonPath}" not found in response ${target.responseId}.`);
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (target.count) {
      if (!Array.isArray(value)) throw new Error(`Path "${target.jsonPath}" is not an array, so it cannot be counted.`);
      return { text: String(value.length) };
    }
    if (value === null || typeof value === "object") {
      throw new Error(`Path "${target.jsonPath}" is not a scalar value.`);
    }
    return { text: String(value) };
  }

  if (target.count) return { text: String(await buildLocator(session.page, target).count()) };
  const locator = await locate(session.page, target);
  let text: string;
  if (target.read === "name") {
    // The accessible name is what the page tree shows in quotes after the role.
    const name = /^-\s+\S+\s+"((?:[^"\\]|\\.)*)"/.exec(await locator.ariaSnapshot());
    if (!name) throw new Error("The selected element has no accessible name.");
    text = squash(name[1]!.replace(/\\(.)/g, "$1"));
  } else {
    text = squash(await locator.innerText());
  }
  return { text, locator };
}

async function screenshot(session: Session, name: string, locator?: Locator): Promise<string> {
  const file = path.join(session.outDir, `${name}.png`);
  if (locator) {
    await locator.evaluate((el) => {
      (el as HTMLElement).style.outline = "3px solid #d6336c";
      (el as HTMLElement).style.outlineOffset = "3px";
    });
  }
  await session.page.screenshot({ path: file, fullPage: true });
  if (locator) {
    await locator.evaluate((el) => {
      (el as HTMLElement).style.outline = "";
      (el as HTMLElement).style.outlineOffset = "";
    });
  }
  return path.basename(file);
}

// ---- tools ----------------------------------------------------------------

type Handlers = { [K in ToolName]: (s: Session, input: z.infer<(typeof schemas)[K]>) => Promise<string> };

const handlers: Handlers = {
  async navigate(s, { path: p }) {
    if (!p.startsWith("/") || p.startsWith("//")) throw new Error('path must start with a single "/".');
    await s.page.goto(new URL(p, s.baseUrl).toString(), { waitUntil: "load" });
    await settle(s.page);
    return describePage(s);
  },

  async click(s, { element }) {
    await (await locate(s.page, element)).click();
    await settle(s.page);
    return describePage(s);
  },

  async fill(s, { element, text }) {
    await (await locate(s.page, element)).fill(text);
    return describePage(s);
  },

  async select(s, { element, option }) {
    await (await locate(s.page, element)).selectOption({ label: option });
    await settle(s.page);
    return describePage(s);
  },

  async api_request(s, { method, path: p, body }) {
    if (!p.startsWith("/") || p.startsWith("//")) throw new Error('path must start with a single "/".');
    const url = new URL(p, s.baseUrl);
    if (!requestAllowed(s.writes, method, url.pathname)) {
      throw new Error(`${method} ${url.pathname} is not permitted in this session.`);
    }
    if (url.origin !== new URL(s.baseUrl).origin) throw new Error("path must stay on the application.");
    // Redirects are reported, not followed: the application must not be able
    // to send this request anywhere else.
    const response = await s.context.request.fetch(url.toString(), {
      method,
      maxRedirects: 0,
      data: body === undefined ? undefined : (body as object),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON; keep the text
    }
    const id = `R${s.apiResponses.size + 1}`;
    s.apiResponses.set(id, { status: response.status(), body: parsed });
    return JSON.stringify({ responseId: id, status: response.status(), body: parsed });
  },

  async observe(s, { name, target }) {
    const declared = s.scenario.observations;
    const mine = declared?.find((o) => o.name === name);
    if (declared && !mine) {
      throw new Error(`The plan declares no observation "${name}". Declared: ${declared.map((o) => `${o.name} (${o.when})`).join("; ") || "none"}.`);
    }
    if (Object.hasOwn(s.observations, name)) {
      // One name is one moment. A second reading would silently change what
      // every formula means, so it is refused, and the name is marked: a
      // formula that uses it can no longer be trusted to mean this moment.
      (s.contested ??= new Set()).add(name);
      throw new Error(
        `Observation "${name}" is already recorded as ${s.observations[name]}${mine ? `, for this moment: ${mine.when}` : ""}. It cannot be recorded again, and no assertion whose formula uses it can be checked from here on.`,
      );
    }
    const { text, raw, locator } = await readTarget(s, target);
    await requireSubject(locator, target, "value", `Observation "${name}"`);
    const read = parseNumber(text);
    const value = reconcile(mine?.unit, raw, read);
    if (!value.comparable) throw new Error(`Observation "${name}" was not recorded: ${value.why}.`);
    s.observations[name] = value.value;
    return `Recorded ${name} = ${value.value}${value.converted ? ` (read as ${read}, converted to the declared unit)` : ""}`;
  },

  async check(s, { assertionId, target }) {
    const assertion = s.scenario.assertions.find((a) => a.id === assertionId);
    if (!assertion) throw new Error(`No assertion "${assertionId}" in this scenario.`);
    if (s.assertionResults.some((r) => r.assertionId === assertionId)) {
      throw new Error(`Assertion ${assertionId} already has a recorded result; it cannot be re-checked.`);
    }

    let expected: number | string;
    let actual: number | string;
    let pass: boolean;
    let locator: Locator | undefined;
    let readAs: number | undefined;

    if (assertion.kind === "present" || assertion.kind === "absent") {
      // Existence is the question, so a target that matches nothing is an
      // answer here and not a tool error.
      let count: number;
      if (target.source === "api") {
        count = await readTarget(s, target).then(
          () => 1,
          () => 0,
        );
      } else {
        const found = buildLocator(s.page, target);
        const deadline = Date.now() + (assertion.kind === "present" ? LOCATE_TIMEOUT_MS : 1_000);
        count = await found.count();
        while (count === 0 && Date.now() < deadline) {
          await s.page.waitForTimeout(100);
          count = await found.count();
        }
        if (count === 1) locator = found;
        // A role or a label says what kind of element to look for. If nothing
        // of that kind is there while the same words are plainly on the page,
        // the kind was a wrong guess, and "absent" would be an answer about
        // the guess and not about the application.
        if (count === 0 && (target.by === "role" || target.by === "label") && target.value.trim() !== "") {
          const scope = target.within ? buildIn(s.page, target.within) : s.page;
          const shown = await scope.getByText(wholeWords(target.value)).filter({ visible: true }).count();
          if (shown > 0) {
            throw new Error(
              `Assertion ${assertionId} was not compared: nothing matches ${JSON.stringify({ by: target.by, role: target.role, value: target.value })}, but the same text is shown on the page in ${shown} other element${shown === 1 ? "" : "s"}. Whether it is present cannot be decided from this target; point at the element that shows it. No result was recorded.`,
            );
          }
        }
      }
      expected = assertion.kind;
      actual = count === 0 ? "absent" : "present";
      pass = actual === expected;
    } else {
      // Resolve both sides before recording anything: a target that cannot be
      // read, or a formula with a missing observation, is a tool error and not
      // a test result.
      if (!assertion.expected) throw new Error(`Assertion ${assertionId} has no expected value in the plan.`);
      const read = await readTarget(s, target);
      locator = read.locator;
      await requireSubject(locator, target, assertion.subject ?? "value", `Assertion ${assertionId}`);
      if ("formula" in assertion.expected) {
        const stale = formulaVariables(assertion.expected.formula).filter((v) => s.contested?.has(v));
        if (stale.length > 0) {
          throw new Error(
            `Assertion ${assertionId} cannot be checked: its formula uses ${stale.join(", ")}, which the scenario needed at more than one moment while the plan gives it one. No result was recorded.`,
          );
        }
      }
      expected =
        "literal" in assertion.expected
          ? assertion.expected.literal
          : evaluateFormula(assertion.expected.formula, s.observations);
      const numeric = (): number => {
        // The value read is brought to the unit the plan declared. Where the
        // unit cannot be established, nothing is compared: a guess about units
        // must not become a pass or a failure.
        const parsed = parseNumber(read.text);
        const value = reconcile(assertion.unit, read.raw, parsed);
        if (!value.comparable) throw new Error(`Assertion ${assertionId} was not compared: ${value.why}. No result was recorded.`);
        if (value.converted) readAs = parsed;
        return value.value;
      };
      if (assertion.kind === "number_equals") {
        actual = numeric();
        pass = Math.abs(actual - Number(expected)) < 1e-9;
        const unclear = pass ? undefined : scaleUnclear(assertion.unit, read.raw, Number(expected), actual);
        if (unclear) throw new Error(`Assertion ${assertionId} was not compared: ${unclear}. No result was recorded.`);
      } else if (assertion.kind === "number_at_least" || assertion.kind === "number_at_most") {
        actual = numeric();
        const difference = actual - Number(expected);
        pass = assertion.kind === "number_at_least" ? difference > -1e-9 : difference < 1e-9;
      } else if (assertion.kind === "text_equals") {
        actual = read.text;
        pass = actual === squash(String(expected));
      } else {
        actual = read.text;
        pass = actual.includes(squash(String(expected)));
      }
    }

    const shot = await screenshot(s, `check-${assertionId}`, locator);
    s.assertionResults.push({ assertionId, expected, actual, pass, target, ...(readAs === undefined ? {} : { readAs }), screenshot: shot });
    return `Recorded ${assertionId}: expected ${expected}, actual ${actual}${readAs === undefined ? "" : ` (read as ${readAs}, converted to the assertion's unit)`} -> ${pass ? "match" : "MISMATCH"}. This result is final.`;
  },

  async finish(s, { outcome, reason }) {
    s.outcome = { kind: outcome, reason };
    return "Scenario ended.";
  },
};

/**
 * Validates and runs one tool call, and records it as a step. Errors are
 * returned, not thrown: the caller decides whether to continue.
 */
export async function runTool(
  session: Session,
  name: string,
  input: unknown,
  allowed: readonly ToolName[] = ALL_TOOLS,
): Promise<{ ok: boolean; output: string }> {
  let ok = true;
  let output: string;
  try {
    if (!(name in schemas) || !allowed.includes(name as ToolName)) throw new Error(`Unknown tool "${name}".`);
    const tool = name as ToolName;
    const parsed = schemas[tool].safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
    // Placeholders become real values only here, on the way into the browser.
    const resolved = session.vault.resolve(parsed.data);
    output = await (handlers[tool] as (s: Session, i: unknown) => Promise<string>)(session, resolved);
  } catch (error) {
    ok = false;
    output = `Error: ${(error as Error).message.split("\n")[0]}`;
  }
  output = session.vault.scrub(output);
  const rationale = (input as { rationale?: unknown } | null)?.rationale;
  session.steps.push({
    tool: name,
    // The input as the executor wrote it: placeholders, never secret values.
    input,
    ok,
    summary: output.split("\n")[0]!.slice(0, 300),
    ...(typeof rationale === "string" ? { rationale } : {}),
  });
  return { ok, output };
}
