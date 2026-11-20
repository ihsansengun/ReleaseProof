import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { z } from "zod";
import { evaluateFormula, formulaVariables } from "../formula.ts";
import { reconcile, scaleUnclear } from "../units.ts";
import type { AssertionResult, Evidence, Outcome, Scenario, Step } from "../schema.ts";
import type { SecretVault } from "../secrets.ts";

/** Everything one scenario execution accumulates. */
export type Session = {
  scenario: Scenario;
  baseUrl: string;
  context: BrowserContext;
  page: Page;
  outDir: string;
  observations: Record<string, number>;
  /** Observations that hold text. Like the numeric ones, each is recorded once and never read again. */
  texts?: Record<string, string>;
  /**
   * Observations the executor tried to record a second time. Their recorded
   * value belongs to an earlier moment, so no formula may use them any more.
   */
  contested?: Set<string>;
  apiResponses: Map<string, { status: number; body: unknown }>;
  /**
   * What code noted along the way, for the evidence behind each comparison:
   * whose credentials were last entered, the last step that could change
   * state, and at which step each observation and API response was obtained.
   */
  trail?: {
    actor?: { alias: string; step: number };
    action?: { step: number; tool: string; what: string };
    observed: Record<string, number>;
    requests: Record<string, { step: number; method: string; path: string }>;
    /** Where and when each observation was read: the record behind a later comparison of it. */
    readings?: Record<string, { step: number; from: "page" | "api"; locatedBy: string; raw: string; page?: string; responseId?: string; actor?: { alias: string; step: number } }>;
  };
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
  by: z
    .enum(["role", "label", "text", "testid", "cell", "labelled"])
    .describe(
      'How the element is identified. "cell": the cell of a table at one row and one column; give "row" and put the column header in "value". "labelled": the value that belongs to a label (a line such as "Subtotal: $60.00", the item after a term in a list, the cell after a row header, the control of a form label); put the label, without the value, in "value". Use these two for values in tables and labelled lists.',
    ),
  role: z.enum(ROLES).optional().describe("Required when by=role."),
  value: z
    .string()
    .describe(
      "Accessible name (role/label), visible text, or test id. by=text selects the smallest element containing the text as whole words (Total does not match Subtotal); by=role needs an element that has an accessible name, which plain text containers often lack. by=cell: the column header, exactly. by=labelled: the label, exactly.",
    ),
  row: Container.optional().describe(
    "Required when by=cell: what identifies the row. by=text: text the row contains, as whole words, that is NOT the value you are reading (an id, a name, a date, a reason). by=role with role=row: the row's accessible name. by=testid: a test id on the row.",
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
  check: z.object({
    assertionId: z.string(),
    target: Target.optional().describe('Where the actual value is. Leave it out for an assertion that carries "actual": {"observation": ...}: the recorded observation is compared.'),
  }),
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

/** A page target narrowed to the forms that name an element directly. */
function asRef(target: z.infer<typeof PageTarget>): ElementRef {
  if (target.by === "cell" || target.by === "labelled") {
    throw new Error(`by=${target.by} identifies one value to read; it cannot be counted or tested for presence. Use by=text, role or testid for that.`);
  }
  return { by: target.by, role: target.role, value: target.value, within: target.within };
}

/** Waits briefly for a locator to match exactly one element, and says how many it matched. */
async function settleCount(page: Page, locator: Locator): Promise<number> {
  const deadline = Date.now() + LOCATE_TIMEOUT_MS;
  let count = await locator.count();
  while (count !== 1 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    count = await locator.count();
  }
  return count;
}

const CELLS = ':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > [role="rowheader"], :scope > [role="columnheader"]';

/**
 * The cell at one row and one column of a table. The row is identified by
 * something it contains or is called; the column by its header. Neither is
 * the value sought, so the cell is found whatever it happens to show. One row
 * and one column, or nothing is read.
 */
async function locateCell(page: Page, target: z.infer<typeof PageTarget>): Promise<Locator> {
  if (!target.row) throw new Error("row is required when by=cell: say what identifies the row.");
  const scope = target.within ? buildIn(page, target.within) : page;
  const rows =
    target.row.by === "text"
      ? // A row is known by a cell of its own. Matching the row's whole text would
        // run its cells together and lose the word boundaries between them.
        scope.getByRole("row").filter({ has: page.locator('td, th, [role="cell"], [role="gridcell"], [role="rowheader"]').filter({ hasText: wholeWords(target.row.value) }) })
      : target.row.by === "role"
        ? scope.getByRole(target.row.role ?? "row", { name: target.row.value, exact: true })
        : buildIn(scope, target.row);
  const count = await settleCount(page, rows);
  if (count !== 1) {
    throw new Error(
      count === 0
        ? `Expected exactly one row for ${JSON.stringify(target.row)}, found 0. Nothing was read.`
        : `Ambiguous target: ${count} rows match ${JSON.stringify(target.row)}. Identify the row by something only it contains, or narrow it with "within". Nothing was read.`,
    );
  }
  // The function below runs in the page. It is written without named helpers,
  // which a transpiler may wrap in code the page does not have.
  const found = await rows.evaluate(
    (el, { column, cells }) => {
      const row = el.closest('tr, [role="row"]');
      const table = row ? row.closest('table, [role="table"], [role="grid"]') : null;
      if (!row || !table) return { error: "the row is not part of a table" };
      const wanted = column.replace(/\s+/g, " ").trim().toLowerCase();
      let header: Element | undefined;
      for (const candidate of table.querySelectorAll('tr, [role="row"]')) {
        if (candidate.closest('table, [role="table"], [role="grid"]') !== table) continue;
        if (candidate.querySelector(':scope > th, :scope > [role="columnheader"]') && !candidate.querySelector(":scope > td")) {
          header = candidate;
          break;
        }
      }
      if (!header) return { error: "the table has no header row to name its columns" };
      for (const c of [...header.querySelectorAll(cells), ...row.querySelectorAll(cells)]) {
        if (Number(c.getAttribute("colspan") ?? 1) > 1) return { error: "the table has merged cells, so a column cannot be matched to a cell" };
      }
      const names = [...header.querySelectorAll(cells)].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase());
      const matches = names.map((n, i) => (n === wanted ? i : -1)).filter((i) => i >= 0);
      if (matches.length !== 1) return { error: `${matches.length} columns are headed "${column}"; the headers are: ${names.join(" | ")}` };
      if (row === header) return { error: "the row matched is the header row" };
      if (row.querySelectorAll(cells).length !== names.length) return { error: "the row does not have one cell per column" };
      return { index: matches[0]! };
    },
    { column: target.value, cells: CELLS },
  );
  if ("error" in found) throw new Error(`No cell was read: ${found.error}.`);
  return rows.locator(CELLS).nth(found.index);
}

/**
 * The value that belongs to a label: the item after a term in a list, the
 * cell after a row header, or the control a form label belongs to. One label
 * and one value, or nothing is read.
 */
async function locateLabelled(page: Page, target: z.infer<typeof PageTarget>): Promise<{ locator: Locator; text?: string }> {
  const scope = target.within ? buildIn(page, target.within) : page;
  const words = target.value.trim().replace(/:$/, "").trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.join("") === "") throw new Error("value must name the label when by=labelled");
  const name = target.value.trim().replace(/:$/, "").trim();
  // Terms and row headers by their text; form labels through the control they name.
  const labels = scope.locator("dt, th").filter({ hasText: new RegExp(`^\\s*${words.join("\\s+")}\\s*:?\\s*$`, "i") });
  const controls = scope.getByLabel(name, { exact: true });
  // A line that carries its own label: "Subtotal: $60.00", "Balance: 20 days".
  // The line must BEGIN with the label and a colon, so "Total" is not found in
  // "Subtotal: ...", and only what follows the colon is the value: a number
  // inside the label itself ("Discount (CODE15): ...") is never read.
  const inline = new RegExp(`^\\s*${words.join("\\s+")}\\s*:\\s*(\\S[\\s\\S]*)$`, "i");
  const lines = scope.getByText(inline);
  await settleCount(page, labels.or(controls).or(lines));
  const [labelCount, controlCount, lineCount] = [await labels.count(), await controls.count(), await lines.count()];
  const total = labelCount + controlCount + lineCount;
  if (total !== 1) {
    throw new Error(
      total === 0
        ? `Expected exactly one label "${target.value}" with a value beside it, found 0. Nothing was read.`
        : `Ambiguous target: ${total} labels read "${target.value}". Narrow it with "within". Nothing was read.`,
    );
  }
  if (lineCount === 1) {
    const value = inline.exec(squash(await lines.innerText()))?.[1];
    if (!value) throw new Error(`The line labelled "${target.value}" has nothing after its colon. Nothing was read.`);
    return { locator: lines, text: squash(value) };
  }
  if (controlCount === 1) return { locator: controls };
  const tag = await labels.evaluate((el) => el.tagName);
  const value = tag === "DT" ? labels.locator("xpath=following-sibling::*[1][self::dd]") : labels.locator("xpath=following-sibling::td");
  const values = await value.count();
  if (values !== 1) throw new Error(`The label "${target.value}" has ${values} values beside it, not one. Nothing was read.`);
  return { locator: value };
}

/** The one element a page target identifies. */
async function locateTarget(page: Page, target: z.infer<typeof PageTarget>): Promise<{ locator: Locator; text?: string }> {
  if (target.by === "cell") return { locator: await locateCell(page, target) };
  if (target.by === "labelled") return locateLabelled(page, target);
  return { locator: await locate(page, asRef(target)) };
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
  // A labelled target has already separated the value from the label that
  // names it, wherever the line sits, so what was read is the value.
  if (target.by === "labelled" && subject === "value") return;
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

  if (target.count) return { text: String(await buildLocator(session.page, asRef(target)).count()) };
  const { locator, text: valueOfLine } = await locateTarget(session.page, target);
  let text: string;
  if (valueOfLine !== undefined) {
    // The value of a "Label: value" line, already separated from its label.
    text = valueOfLine;
  } else if (await locator.evaluate((el) => el.matches("input, select, textarea")).catch(() => false)) {
    // A form control shows its value, not its inner text.
    text = squash(
      await locator.evaluate((el) =>
        el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? "") : (el as HTMLInputElement | HTMLTextAreaElement).value,
      ),
    );
  } else if (target.read === "name") {
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

// ---- evidence -------------------------------------------------------------

const trailOf = (s: Session) => (s.trail ??= { observed: {}, requests: {} });
const pagePath = (s: Session) => {
  const url = new URL(s.page.url());
  return `${url.pathname}${url.search}`;
};
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const describeRef = (ref: { by: string; role?: string; value: string }) => `${ref.by}${ref.role ? ` ${ref.role}` : ""} "${clip(ref.value, 80)}"`;

/** How a target identifies what it reads, in words. */
function describeTarget(target: Target): string {
  if (target.source === "api") return `response ${target.responseId} ${target.field}${target.jsonPath ? ` at ${target.jsonPath}` : ""}${target.count ? " (count)" : ""}`;
  const element = target.by === "cell" ? `cell in row ${target.row ? describeRef(target.row) : "?"}, column "${clip(target.value, 80)}"` : describeRef(target);
  return `${element}${target.within ? ` within ${describeRef(target.within)}` : ""}${target.pattern ? ` pattern ${clip(target.pattern, 80)}` : ""}${target.count ? " (count)" : ""}`;
}

/**
 * Compares an assertion with an observation as it was recorded at its own
 * moment. The page as it is now plays no part: nothing is located and nothing
 * is read, so the comparison cannot pick up a later state by accident.
 */
async function checkObservation(s: Session, assertion: Scenario["assertions"][number], name: string, target: Target | undefined): Promise<string> {
  const id = assertion.id;
  if (target) {
    throw new Error(
      `Assertion ${id} is about the observation "${name}" as it was recorded at its moment, not about the page as it is now. Call check for it without a target. No result was recorded.`,
    );
  }
  const numeric = assertion.kind === "number_equals" || assertion.kind === "number_at_least" || assertion.kind === "number_at_most";
  const recorded: number | string | undefined = numeric ? s.observations[name] : s.texts?.[name];
  if (recorded === undefined) {
    const when = s.scenario.observations?.find((o) => o.name === name)?.when;
    throw new Error(`Assertion ${id} cannot be checked yet: observation "${name}" has not been recorded${when ? ` (its moment: ${when})` : ""}. No result was recorded.`);
  }
  if (!assertion.expected) throw new Error(`Assertion ${id} has no expected value in the plan.`);
  const variables = "formula" in assertion.expected ? formulaVariables(assertion.expected.formula) : [];
  const stale = [name, ...variables].filter((v) => s.contested?.has(v));
  if (stale.length > 0) {
    throw new Error(`Assertion ${id} cannot be checked: ${stale.join(", ")} was needed at more than one moment while the plan gives it one. No result was recorded.`);
  }
  const expected = "literal" in assertion.expected ? assertion.expected.literal : evaluateFormula(assertion.expected.formula, s.observations);
  let pass: boolean;
  if (typeof recorded === "number") {
    const difference = recorded - Number(expected);
    pass = assertion.kind === "number_equals" ? Math.abs(difference) < 1e-9 : assertion.kind === "number_at_least" ? difference > -1e-9 : difference < 1e-9;
  } else {
    pass = assertion.kind === "text_equals" ? recorded === squash(String(expected)) : recorded.includes(squash(String(expected)));
  }

  const trail = trailOf(s);
  const reading = trail.readings?.[name];
  const request = reading?.responseId ? trail.requests[reading.responseId] : undefined;
  const response = reading?.responseId ? s.apiResponses.get(reading.responseId) : undefined;
  const declared = s.scenario.observations?.find((o) => o.name === name);
  const evidence: Evidence = {
    step: s.steps.length + 1,
    ...(assertion.requirementId
      ? { requirement: { id: assertion.requirementId, ...(assertion.provenance ? { sourceId: assertion.provenance.sourceId, quote: clip(assertion.provenance.quote, 240) } : {}) } }
      : {}),
    expected: {
      kind: assertion.kind,
      ...("literal" in assertion.expected ? { literal: assertion.expected.literal } : { formula: assertion.expected.formula }),
      ...(assertion.unit ? { unit: assertion.unit } : {}),
    },
    // Who was signed in when the value was read, not who is signed in now.
    ...(reading?.actor ? { actor: reading.actor } : {}),
    resource: {
      ...(reading?.page ? { page: reading.page } : {}),
      ...(request && response ? { request: { ...request, status: response.status } } : {}),
    },
    before: [name, ...variables]
      .filter((v, i, all) => all.indexOf(v) === i && (Object.hasOwn(s.observations, v) || Object.hasOwn(s.texts ?? {}, v)))
      .filter((v) => typeof (s.observations[v] ?? undefined) === "number")
      .map((v) => ({ name: v, when: s.scenario.observations?.find((o) => o.name === v)?.when, value: s.observations[v]!, step: trail.observed[v] })),
    ...(trail.action ? { action: trail.action } : {}),
    target: { locatedBy: `observation "${name}" recorded at step ${reading?.step ?? "?"}${declared ? ` (${clip(declared.when, 120)})` : ""} from ${reading?.locatedBy ?? "an unknown target"}` },
    ...(reading ? { raw: reading.raw } : {}),
  };
  s.assertionResults.push({
    assertionId: id,
    expected,
    actual: recorded,
    pass,
    target: { source: "observation", name, from: reading?.from ?? "page", recordedAtStep: reading?.step },
    evidence: JSON.parse(s.vault.scrub(JSON.stringify(evidence))) as Evidence,
  });
  return `Recorded ${id}: expected ${expected}, actual ${recorded} (observation "${name}", recorded at step ${reading?.step ?? "?"}) -> ${pass ? "match" : "MISMATCH"}. This result is final.`;
}

/**
 * Notes, after a step that worked, what later evidence needs from it. `input`
 * is the step as the executor wrote it: placeholders, never secret values.
 */
function noteStep(session: Session, tool: string, input: unknown): void {
  const trail = trailOf(session);
  const step = session.steps.length + 1;
  const given = (input ?? {}) as { element?: { by: string; role?: string; value: string }; method?: string; path?: string };
  // Entering an alias's secret is how a session takes on an identity. The alias is test data, not a person.
  const alias = /\{\{secret:([A-Za-z][A-Za-z0-9_]*)\./.exec(JSON.stringify(input ?? null))?.[1];
  if (alias && (tool === "fill" || tool === "api_request")) trail.actor = { alias, step };
  if ((tool === "click" || tool === "fill" || tool === "select") && given.element) {
    trail.action = { step, tool, what: describeRef(given.element) };
  } else if (tool === "api_request" && given.method && given.method !== "GET") {
    trail.action = { step, tool, what: `${given.method} ${clip(String(given.path ?? ""), 120)}` };
  }
}

/** Assembles the record behind one comparison from what the session holds. Secrets are scrubbed. */
async function gatherEvidence(
  s: Session,
  assertion: Scenario["assertions"][number],
  target: Target,
  found: { locator?: Locator; raw?: string; matched?: number },
): Promise<Evidence> {
  const trail = trailOf(s);
  const formula = assertion.expected && "formula" in assertion.expected ? assertion.expected.formula : undefined;
  const evidence: Evidence = {
    step: s.steps.length + 1,
    ...(assertion.requirementId
      ? { requirement: { id: assertion.requirementId, ...(assertion.provenance ? { sourceId: assertion.provenance.sourceId, quote: clip(assertion.provenance.quote, 240) } : {}) } }
      : {}),
    expected: {
      kind: assertion.kind,
      ...(assertion.expected && "literal" in assertion.expected ? { literal: assertion.expected.literal } : {}),
      ...(formula ? { formula } : {}),
      ...(assertion.unit ? { unit: assertion.unit } : {}),
    },
    ...(trail.actor ? { actor: trail.actor } : {}),
    resource: {},
    before: (formula ? formulaVariables(formula) : [])
      .filter((name) => Object.hasOwn(s.observations, name))
      .map((name) => ({
        name,
        when: s.scenario.observations?.find((o) => o.name === name)?.when,
        value: s.observations[name]!,
        step: trail.observed[name],
      })),
    ...(trail.action ? { action: trail.action } : {}),
    target: { locatedBy: "" },
    ...(found.raw === undefined ? {} : { raw: clip(found.raw, 200) }),
  };
  if (target.source === "api") {
    const response = s.apiResponses.get(target.responseId);
    const request = trail.requests[target.responseId];
    evidence.target = { locatedBy: `response ${target.responseId} ${target.field}${target.jsonPath ? ` at ${target.jsonPath}` : ""}${target.count ? " (count)" : ""}` };
    if (response && request) {
      evidence.resource.request = { ...request, status: response.status, body: clip(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? null), 300) };
    }
  } else {
    const url = new URL(s.page.url());
    evidence.resource.page = `${url.pathname}${url.search}`;
    evidence.target = {
      locatedBy: `${target.by === "cell" ? `cell in row ${target.row ? describeRef(target.row) : "?"}, column "${clip(target.value, 80)}"` : describeRef(target)}${target.pattern ? ` pattern ${clip(target.pattern, 80)}` : ""}${target.count ? " (count)" : ""}`,
      ...(target.within ? { within: describeRef(target.within) } : {}),
      matched: found.matched ?? (found.locator ? 1 : undefined),
    };
    if (found.locator && (found.matched ?? 1) === 1) {
      evidence.target.visible = await found.locator.isVisible().catch(() => undefined);
      evidence.target.element = await found.locator
        .evaluate((el) => {
          const text = (el.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") ?? undefined,
            context: text.length > 120 ? `${text.slice(0, 120)}…` : text,
          };
        })
        .catch(() => undefined);
    }
  }
  return JSON.parse(s.vault.scrub(JSON.stringify(evidence))) as Evidence;
}

/**
 * Says why a target is circular, if it is: the text it is located by already
 * contains the expected value. Finding "$22.50" by searching for "$22.50"
 * shows the value appears somewhere, not that the total is $22.50. A test id
 * is a stable identity and is exempt, as is a declared heading or label
 * located as one.
 */
export function circular(target: Target, expected: number | string, assertion: { kind: string; unit?: string; subject?: string }): string | undefined {
  if (target.source !== "page" || target.count || target.by === "testid") return undefined;
  // A declared heading or label is identified by being one, which is checked separately; its wording is what is read.
  if (assertion.subject && assertion.subject !== "value") return undefined;
  // A pattern escapes its punctuation ("22\\.50"); the escapes are dropped so the value in it is seen.
  // A row may not be identified by the value sought either.
  const texts = [target.value, (target.pattern ?? "").replace(/\\/g, ""), target.row?.value ?? ""];
  const advice = "Finding it there shows only that the value appears somewhere. Identify the element by its label, role, container or test id.";
  if (typeof expected === "number") {
    const wanted = [expected, ...(assertion.unit === "currency-hundredths" ? [expected / 100] : []), ...(assertion.unit === "currency-units" ? [expected * 100] : [])];
    for (const text of texts) {
      // A number inside a word is part of a name ("TAKE15"), not a number.
      for (const match of text.match(/(?<![\p{L}\p{N}_])\d[\d,]*(?:\.\d+)?(?![\p{L}_])/gu) ?? []) {
        const n = Number(match.replace(/,/g, ""));
        if (wanted.some((w) => Math.abs(n - w) < 1e-9)) return `the target is located by the expected value itself ("${clip(text, 60)}" contains ${match}). ${advice}`;
      }
    }
    return undefined;
  }
  const wantedText = squash(expected).toLowerCase();
  if (wantedText === "") return undefined;
  for (const text of texts) {
    if (squash(text).toLowerCase().includes(wantedText)) {
      return `the target is located by the expected text itself ("${clip(text, 60)}"). ${advice}${assertion.kind === "text_contains" ? " If the requirement is only that this text is shown, the plan must say so with a present assertion." : ""}`;
    }
  }
  return undefined;
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
    trailOf(s).requests[id] = { step: s.steps.length + 1, method, path: url.pathname };
    return JSON.stringify({ responseId: id, status: response.status(), body: parsed });
  },

  async observe(s, { name, target }) {
    const declared = s.scenario.observations;
    const mine = declared?.find((o) => o.name === name);
    if (declared && !mine) {
      throw new Error(`The plan declares no observation "${name}". Declared: ${declared.map((o) => `${o.name} (${o.when})`).join("; ") || "none"}.`);
    }
    if (Object.hasOwn(s.observations, name) || Object.hasOwn(s.texts ?? {}, name)) {
      // One name is one moment. A second reading would silently change what
      // every formula means, so it is refused, and the name is marked: a
      // formula that uses it can no longer be trusted to mean this moment.
      (s.contested ??= new Set()).add(name);
      throw new Error(
        `Observation "${name}" is already recorded as ${s.observations[name] ?? JSON.stringify(s.texts?.[name])}${mine ? `, for this moment: ${mine.when}` : ""}. It cannot be recorded again, and no assertion whose formula uses it can be checked from here on.`,
      );
    }
    const { text, raw, locator } = await readTarget(s, target);
    await requireSubject(locator, target, "value", `Observation "${name}"`);
    const trail = trailOf(s);
    const reading = () => {
      trail.observed[name] = s.steps.length + 1;
      (trail.readings ??= {})[name] = {
        step: s.steps.length + 1,
        from: target.source,
        locatedBy: describeTarget(target),
        raw: clip(raw, 200),
        ...(target.source === "page" ? { page: pagePath(s) } : { responseId: target.responseId }),
        ...(trail.actor ? { actor: trail.actor } : {}),
      };
    };
    if (mine?.type === "text") {
      (s.texts ??= {})[name] = text;
      reading();
      return `Recorded ${name} = ${JSON.stringify(text)}`;
    }
    const read = parseNumber(text);
    const value = reconcile(mine?.unit, raw, read);
    if (!value.comparable) throw new Error(`Observation "${name}" was not recorded: ${value.why}.`);
    s.observations[name] = value.value;
    reading();
    return `Recorded ${name} = ${value.value}${value.converted ? ` (read as ${read}, converted to the declared unit)` : ""}`;
  },

  async check(s, { assertionId, target }) {
    const assertion = s.scenario.assertions.find((a) => a.id === assertionId);
    if (!assertion) throw new Error(`No assertion "${assertionId}" in this scenario.`);
    if (s.assertionResults.some((r) => r.assertionId === assertionId)) {
      throw new Error(`Assertion ${assertionId} already has a recorded result; it cannot be re-checked.`);
    }

    if (assertion.actual) return checkObservation(s, assertion, assertion.actual.observation, target);
    if (!target) throw new Error(`Assertion ${assertionId} needs a target: say where its actual value is.`);

    let expected: number | string;
    let actual: number | string;
    let pass: boolean;
    let locator: Locator | undefined;
    let readAs: number | undefined;
    let raw: string | undefined;
    let matched: number | undefined;

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
        // Presence means shown: an element that is in the page but not visible is not there for the user.
        const found = buildLocator(s.page, asRef(target)).filter({ visible: true });
        const deadline = Date.now() + (assertion.kind === "present" ? LOCATE_TIMEOUT_MS : 1_000);
        count = await found.count();
        while (count === 0 && Date.now() < deadline) {
          await s.page.waitForTimeout(100);
          count = await found.count();
        }
        if (count === 1) locator = found;
        matched = count;
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
      raw = read.raw;
      const loop = circular(target, expected, assertion);
      if (loop) throw new Error(`Assertion ${assertionId} was not compared: ${loop} No result was recorded.`);
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

    const evidence = await gatherEvidence(s, assertion, target, { locator, raw, matched });
    const shot = await screenshot(s, `check-${assertionId}`, locator);
    s.assertionResults.push({ assertionId, expected, actual, pass, target, ...(readAs === undefined ? {} : { readAs }), evidence, screenshot: shot });
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
  if (ok) noteStep(session, name, input);
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
