import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { z } from "zod";
import { evaluateFormula } from "../formula.ts";
import type { AssertionResult, Outcome, Scenario, Step } from "../schema.ts";

/** Everything one scenario execution accumulates. */
export type Session = {
  scenario: Scenario;
  baseUrl: string;
  context: BrowserContext;
  page: Page;
  outDir: string;
  observations: Record<string, number>;
  apiResponses: Map<string, { status: number; body: unknown }>;
  assertionResults: AssertionResult[];
  steps: Step[];
  outcome?: Outcome;
};

const ROLES = [
  "button", "link", "textbox", "spinbutton", "checkbox", "radio", "combobox",
  "heading", "cell", "row", "listitem", "alert", "status", "paragraph", "strong",
] as const;

const PageTarget = z.object({
  source: z.literal("page"),
  by: z.enum(["role", "label", "text", "testid"]),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z.string().describe("Accessible name (role/label), visible text, or test id."),
  pattern: z
    .string()
    .optional()
    .describe("Regex with one capture group, to pick a value out of longer text."),
});
const ApiTarget = z.object({
  source: z.literal("api"),
  responseId: z.string().describe("Id returned by api_request."),
  jsonPath: z.string().describe('Dot path into the JSON body, e.g. "items.0.status".'),
});
const Target = z.discriminatedUnion("source", [PageTarget, ApiTarget]);
type Target = z.infer<typeof Target>;

const ElementRef = z.object({
  by: z.enum(["role", "label", "text", "testid"]),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z.string().describe("Accessible name (role/label), visible text, or test id."),
});

const schemas = {
  navigate: z.object({ path: z.string().describe('Path on the application under test, e.g. "/settings".') }),
  click: z.object({ element: ElementRef }),
  fill: z.object({ element: ElementRef, text: z.string() }),
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
  fill: "Replace the content of one input. Returns the resulting page.",
  api_request:
    "Send an HTTP request to the application under test using the browser session's cookies. Returns status, body and a responseId usable as a target.",
  observe:
    "Read a number from the page or from an API response and store it under a name, for use in assertion formulas. Read it at the moment it is meaningful; it is not re-read later.",
  check:
    "Run one planned assertion. The tool reads the actual value from the target you point at and compares it in code with the expectation fixed in the plan. Each assertion can be checked once; the first result is final.",
  finish:
    'End the scenario. Use "blocked" with a specific reason if something outside your control prevented a check. You do not decide pass or fail.',
};

export const toolDefinitions = (Object.keys(schemas) as ToolName[]).map((name) => ({
  name,
  description: descriptions[name],
  input_schema: z.toJSONSchema(schemas[name]) as { type: "object"; [k: string]: unknown },
}));

// ---- helpers --------------------------------------------------------------

const SNAPSHOT_LIMIT = 20_000;
const LOCATE_TIMEOUT_MS = 3_000;
const SETTLE_TIMEOUT_MS = 10_000;

async function describePage(page: Page): Promise<string> {
  const url = new URL(page.url());
  const snapshot = await page.locator("body").ariaSnapshot();
  const body =
    snapshot.length > SNAPSHOT_LIMIT
      ? `${snapshot.slice(0, SNAPSHOT_LIMIT)}\n[snapshot cut at ${SNAPSHOT_LIMIT} of ${snapshot.length} characters]`
      : snapshot;
  return `URL: ${url.pathname}${url.search}\n${body}`;
}

async function locate(page: Page, ref: z.infer<typeof ElementRef>): Promise<Locator> {
  let locator: Locator;
  if (ref.by === "role") {
    if (!ref.role) throw new Error("role is required when by=role");
    locator = page.getByRole(ref.role, { name: ref.value, exact: true });
  } else if (ref.by === "label") locator = page.getByLabel(ref.value, { exact: true });
  else if (ref.by === "testid") locator = page.getByTestId(ref.value);
  else locator = page.getByText(ref.value);

  // Pages may still be rendering after an action, so give the element a
  // moment to appear before deciding it is missing or ambiguous.
  const deadline = Date.now() + LOCATE_TIMEOUT_MS;
  let count = await locator.count();
  while (count !== 1 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    count = await locator.count();
  }
  if (count !== 1) {
    throw new Error(`Expected exactly one element for ${JSON.stringify(ref)}, found ${count}.`);
  }
  return locator;
}

/**
 * Waits for the page to go quiet after an action. A click may trigger a
 * client-side navigation that the "load" event never reports.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
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
async function readTarget(session: Session, target: Target): Promise<{ text: string; locator?: Locator }> {
  if (target.source === "api") {
    const response = session.apiResponses.get(target.responseId);
    if (!response) throw new Error(`Unknown responseId "${target.responseId}".`);
    let value: unknown = response.body;
    for (const key of target.jsonPath.split(".").filter(Boolean)) {
      if (value === null || typeof value !== "object" || !(key in value)) {
        throw new Error(`Path "${target.jsonPath}" not found in response ${target.responseId}.`);
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value === null || typeof value === "object") {
      throw new Error(`Path "${target.jsonPath}" is not a scalar value.`);
    }
    return { text: String(value) };
  }

  const locator = await locate(session.page, target);
  let text = squash(await locator.innerText());
  if (target.pattern) {
    const match = new RegExp(target.pattern).exec(text);
    if (!match || match[1] === undefined) {
      throw new Error(`Pattern ${target.pattern} with one capture group did not match "${text}".`);
    }
    text = match[1];
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
    return describePage(s.page);
  },

  async click(s, { element }) {
    await (await locate(s.page, element)).click();
    await settle(s.page);
    return describePage(s.page);
  },

  async fill(s, { element, text }) {
    await (await locate(s.page, element)).fill(text);
    return describePage(s.page);
  },

  async api_request(s, { method, path: p, body }) {
    if (!p.startsWith("/") || p.startsWith("//")) throw new Error('path must start with a single "/".');
    const response = await s.context.request.fetch(new URL(p, s.baseUrl).toString(), {
      method,
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
    if (Object.hasOwn(s.observations, name)) {
      throw new Error(`Observation "${name}" is already recorded as ${s.observations[name]}.`);
    }
    const { text } = await readTarget(s, target);
    const value = parseNumber(text);
    s.observations[name] = value;
    return `Recorded ${name} = ${value}`;
  },

  async check(s, { assertionId, target }) {
    const assertion = s.scenario.assertions.find((a) => a.id === assertionId);
    if (!assertion) throw new Error(`No assertion "${assertionId}" in this scenario.`);
    if (s.assertionResults.some((r) => r.assertionId === assertionId)) {
      throw new Error(`Assertion ${assertionId} already has a recorded result; it cannot be re-checked.`);
    }

    // Resolve both sides before recording anything: a target that cannot be
    // read, or a formula with a missing observation, is a tool error and not
    // a test result.
    const { text, locator } = await readTarget(s, target);
    const expected =
      "literal" in assertion.expected
        ? assertion.expected.literal
        : evaluateFormula(assertion.expected.formula, s.observations);

    let actual: number | string;
    let pass: boolean;
    if (assertion.kind === "number_equals") {
      actual = parseNumber(text);
      pass = Math.abs(actual - Number(expected)) < 1e-9;
    } else if (assertion.kind === "text_equals") {
      actual = text;
      pass = actual === squash(String(expected));
    } else {
      actual = text;
      pass = actual.includes(squash(String(expected)));
    }

    const shot = await screenshot(s, `check-${assertionId}`, locator);
    s.assertionResults.push({ assertionId, expected, actual, pass, target, screenshot: shot });
    return `Recorded ${assertionId}: expected ${expected}, actual ${actual} -> ${pass ? "match" : "MISMATCH"}. This result is final.`;
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
): Promise<{ ok: boolean; output: string }> {
  let ok = true;
  let output: string;
  try {
    if (!(name in schemas)) throw new Error(`Unknown tool "${name}".`);
    const tool = name as ToolName;
    const parsed = schemas[tool].safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
    output = await (handlers[tool] as (s: Session, i: unknown) => Promise<string>)(session, parsed.data);
  } catch (error) {
    ok = false;
    output = `Error: ${(error as Error).message.split("\n")[0]}`;
  }
  session.steps.push({ tool: name, input, ok, summary: output.split("\n")[0]!.slice(0, 300) });
  return { ok, output };
}
