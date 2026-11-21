import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { z } from "zod";
import { evaluateFormula, formulaVariables } from "../formula.ts";
import { reconcile, scaleUnclear } from "../units.ts";
import { BlockedCause, type ApplicationError, type ErrorSignal, type AssertionResult, type Evidence, type Outcome, type Scenario, type Step } from "../schema.ts";
import type { SecretVault } from "../secrets.ts";
import { addressData, independence, note as noteSupplied, noteAnswer, scalars, settled, type SuppliedState } from "./supplied.ts";

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
  /** Places where items of a kind were counted and found, in this session: the record that a later zero there is a reading. */
  counted?: Set<string>;
  /** Errors the application answered with. Filled by the response listener and by finish. */
  appErrors?: ApplicationError[];
  /** Text that newly read like an application failure after a user action. A lead only. */
  errorSignals?: ErrorSignal[];
  /** What the executor has typed into fields so far: its own words, which the page may show back. */
  typed?: string[];
  /** The user action being carried out right now, if any: responses to it are the application's answer to a user. */
  acting?: string;
  /** Bodies of error responses still being read. */
  pendingErrors?: Promise<void>[];
  assertionResults: AssertionResult[];
  steps: Step[];
  outcome?: Outcome;
  /** What the executor itself put into the application, and whether the application has shown since that it holds it. */
  supplied?: SuppliedState;
  /**
   * For runs whose plan is not the engine's own: a presence check must look
   * for wording the approved text itself states.
   */
  quotedOnly?: boolean;
  /** The first other origin the page was on at any moment, in a session confined to the application's own. */
  leftTo?: string;
  /** Whether the page has been on the application at all, in a confined session. A blank page after that is somewhere else. */
  arrived?: boolean;
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
  "columnheader", "rowheader", "banner", "navigation", "main", "menuitem", "option", "tab",
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
  press: z.object({
    element: ElementRef,
    key: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"]).describe("The key to press while the element has the focus."),
  }),
  upload: z.object({
    element: ElementRef.describe("The control a user clicks to choose files (a button, a link, or the file field itself)."),
    files: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/).describe('File name with its extension, e.g. "notes.txt". No folders.'),
          kind: z.enum(["text", "image"]).describe('"text": a one-line plain text file. "image": a very small PNG picture.'),
        }),
      )
      .min(1)
      .max(5),
  }),
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
    cause: BlockedCause.optional().describe(
      'With outcome "blocked": what stopped you. "application-error": the application answered a valid action with an error. "cannot-operate": you could not find or operate a control. "missing-capability": your tools cannot do what the step needs. "test-data": data the scenario needs is not there.',
    ),
    error: PageTarget.optional().describe('With cause "application-error", when the error is shown on the page: the element that shows the error text. It is read and kept as evidence.'),
  }),
} as const;
export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  navigate: "Open a path on the application under test. Returns the resulting page.",
  click: "Click one element. Returns the resulting page.",
  fill: "Replace the content of one input. Returns the resulting page. Secret placeholders from the test data are substituted for you.",
  select: "Choose one option of a drop-down by its visible label. Returns the resulting page.",
  press:
    "Press one key in one element, as a user does on the keyboard: Enter to submit a field that has no button, Escape to close what is open, the arrows to move in a list. Returns the resulting page.",
  upload:
    "Choose files in a file field, as a user does through the file dialog. The files are small synthetic ones made for the test: you give each a name and a kind, never a path. The tool reports each file's name, size in bytes and content. Returns the resulting page.",
  api_request:
    "Send an HTTP request to the application under test using the browser session's cookies. Returns status, body and a responseId usable as a target.",
  observe:
    "Read a number from the page or from an API response and store it under a name, for use in assertion formulas. Read it at the moment it is meaningful; it is not re-read later.",
  check:
    "Run one planned assertion. The tool reads the actual value from the target you point at and compares it in code with the expectation fixed in the plan. For kinds present and absent, the target is the element (or API field) whose existence is in question. Each assertion can be checked once; the first result is final.",
  finish:
    'End the scenario. Use "blocked" with a specific reason and its cause if something outside your control prevented a check. You do not decide pass or fail.',
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
const TYPING_PAUSE_MS = 400;

export async function describePage(session: Pick<Session, "page" | "vault">): Promise<string> {
  const { page } = session;
  const url = new URL(page.url());
  // Icon glyphs are left out: they carry no meaning as text and cannot be repeated back.
  let snapshot = session.vault.scrub(await page.locator("body").ariaSnapshot()).replace(ICON_GLYPHS, "");
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

/** Characters of the private-use range: glyphs of icon fonts. They are drawings, not text, and nobody can type them. */
const ICON_GLYPHS = /[\uE000-\uF8FF]/g;

/**
 * An accessible name matched in full, except that icon glyphs and the spaces
 * around them do not count: a link shown as a name followed by a small arrow
 * is that name.
 */
export function exactName(value: string): RegExp {
  const gap = "[\\s\\uE000-\\uF8FF]";
  const words = value.replace(ICON_GLYPHS, " ").trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${gap}*${words.join(`${gap}+`)}${gap}*$`);
}

function buildIn(root: Page | Locator, ref: Omit<ElementRef, "within">, includeHidden = false): Locator {
  if (ref.by === "role") {
    if (!ref.role) throw new Error("role is required when by=role");
    // No name given means any name: every element of that role. An empty name
    // matched literally would find only nameless elements, and a count of them
    // reads 0 whatever the page shows.
    return ref.value.trim() === "" ? root.getByRole(ref.role, { includeHidden }) : root.getByRole(ref.role, { name: exactName(ref.value), exact: true, includeHidden });
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

/**
 * How many elements a target matches, and where they were counted.
 *
 * A count is a reading only when the place it counts in is established. With
 * a container, the container must be the one element that holds the items:
 * not missing, not several, not a heading or label that merely names the
 * section. An empty list or table found by its role is a valid place: zero
 * there is a reading. Without a container a count of zero is refused: nothing matched
 * anywhere, which is an empty collection or a wrong target, and from here the
 * two cannot be told apart.
 */
async function countIn(session: Session, target: z.infer<typeof PageTarget>): Promise<{ count: number; scope: string; present: number }> {
  const page = session.page;
  const ref = asRef(target);
  let root: Page | Locator = page;
  let scope = "the whole page";
  if (ref.within) {
    const container = buildIn(page, ref.within);
    const containers = await settleCount(page, container);
    if (containers !== 1) {
      throw new Error(
        `Not counted: expected exactly one container for ${JSON.stringify(ref.within)}, found ${containers}. A count needs the one element that holds the items; without it, 0 would mean nothing. Nothing was read.`,
      );
    }
    const kind = await elementKind(container);
    // A list, table or region found by its role is a container even when it
    // is empty: that is what an empty collection looks like. Words found by
    // their text, with nothing inside them, are a name and not a container.
    const named = ref.within.by === "text" || ref.within.by === "label";
    const hollow = named && (await container.evaluate((el) => el.childElementCount)) === 0;
    if (kind !== "value" || hollow) {
      throw new Error(
        `Not counted: the container ${describeRef(ref.within)} is ${kind !== "value" ? `a ${kind}` : "text with nothing inside it"}. It names a section and does not hold its items. Point "within" at the list, table, group or section itself. Nothing was read.`,
      );
    }
    root = container;
    scope = `within ${describeRef(ref.within)}`;
  }
  // What is in the page but not shown is not there for the user: only shown
  // items are counted. How many are present in all goes on record beside it.
  // Elements found by role leave out what is hidden; those found by text or
  // test id do not. Both are asked for in full, then narrowed to what shows.
  const every = buildIn(root, ref, true);
  const items = buildIn(root, ref).filter({ visible: true });
  // Items may still be arriving; give them a moment before calling the place empty.
  const deadline = Date.now() + 1_000;
  let count = await items.count();
  while (count === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    count = await items.count();
  }
  if (count === 0 && !ref.within) {
    throw new Error(
      `Not counted: nothing on the page matches ${JSON.stringify({ by: ref.by, role: ref.role, value: ref.value })}. That is an empty collection or a wrong target, and the two cannot be told apart from here. Scope the count with "within" to the list, table or section that would hold the items; if that element itself is gone when there is nothing to show, check what the page shows in its place. Nothing was read.`,
    );
  }
  const present = await every.count();
  const kindOfItem = ref.by === "role" && ref.role ? ref.role : undefined;
  const all = kindOfItem ? await root.getByRole(kindOfItem as Parameters<Page["getByRole"]>[0]).filter({ visible: true }).count() : 0;
  const place = ref.within ? `${describeRef(ref.within)}|${kindOfItem ?? ""}` : undefined;
  if (count > 0 && place) (session.counted ??= new Set()).add(place);
  if (count === 0 && kindOfItem && place && all === 0 && !session.counted?.has(place)) {
    // The place is real, but nothing says items of this kind are ever shown
    // in it: the page may draw its items as something else, and 0 would then
    // be read whatever it shows. The zero stands only when the place holds
    // nothing but its headings, says it is empty, or held such items earlier.
    const holds = await (root as Locator).evaluate((el) => {
      const text = (el as HTMLElement).innerText ?? "";
      let rest = text;
      for (const h of el.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, summary, thead, label')) {
        const words = ((h as HTMLElement).innerText ?? "").trim();
        if (words) rest = rest.replace(words, "");
      }
      return { text, rest: rest.trim() };
    });
    const saysEmpty = /\b(no|none|nothing|empty|zero)\b|\(0\)|\b0\b/i.test(holds.text);
    if (holds.rest !== "" && !saysEmpty) {
      throw new Error(
        `Not counted: ${describeRef(ref.within!)} shows content, but no element of role ${kindOfItem} was seen in it, now or earlier, and it does not say it is empty. Its items may be drawn as another kind of element, in which case 0 would be read whatever it shows. Look at the page tree for the role its items have and count that. Nothing was read.`,
      );
    }
  }
  if (kindOfItem && ref.value.trim() !== "") {
    scope += `, which holds ${all} element${all === 1 ? "" : "s"} of role ${kindOfItem} in all`;
  }
  if (present !== count) scope += `; ${present - count} more present in the page but not shown, and not counted`;
  return { count, scope, present };
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
async function readTarget(session: Session, target: Target): Promise<{ text: string; raw: string; locator?: Locator; scope?: string; present?: number }> {
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
async function readText(session: Session, target: Target): Promise<{ text: string; locator?: Locator; scope?: string; present?: number }> {
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

  if (target.count) {
    const counted = await countIn(session, target);
    return { text: String(counted.count), scope: counted.scope, present: counted.present };
  }
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

const suppliedOf = (s: Session): SuppliedState => (s.supplied ??= { entries: [], filled: [], pending: [] });

/** Notes an answer of the application for what it says about values the executor entered. Same origin only. */
export function noteTraffic(session: Session, response: { url(): string; status(): number; request(): { method(): string; resourceType(): string }; text(): Promise<string> }): void {
  if (!session.supplied || session.supplied.entries.length === 0) return;
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (url.origin !== new URL(session.baseUrl).origin) return;
  const kind = response.request().resourceType();
  const method = response.request().method();
  // A read counts when it is a page or data the page asked for; scripts, styles and pictures are not the application's state.
  if (method === "GET" && kind !== "document" && kind !== "xhr" && kind !== "fetch") return;
  noteAnswer(session.supplied, { method, url, status: response.status(), body: () => response.text() });
}

/** Refuses a reading that only repeats what the executor entered. Returns what to record about it otherwise. */
async function independent(
  s: Session,
  what: string,
  reading: { numbers?: number[]; texts?: string[] },
  target: Target,
  locator: Locator | undefined,
): Promise<{ step: number; how: string; confirmedBy: string } | undefined> {
  const verdict = await independence(s.supplied, reading, target.source === "api" ? { source: "api", responseId: target.responseId } : { source: "page", locator });
  if ("refuse" in verdict) throw new Error(`${what}: ${verdict.refuse} No result was recorded.`);
  return verdict.entered;
}

async function screenshot(session: Session, name: string, locator?: Locator): Promise<string> {
  const file = path.join(session.outDir, `${name}.png`);
  // Evidence is written inside the scenario's own directory, whatever the name is made from.
  if (path.dirname(path.resolve(file)) !== path.resolve(session.outDir)) {
    throw new Error("The screenshot name is not a plain file name.");
  }
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
  if ((tool === "click" || tool === "fill" || tool === "select" || tool === "upload" || tool === "press") && given.element) {
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
  found: { locator?: Locator; raw?: string; matched?: number; scope?: string; shown?: number; present?: number },
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
      ...(found.scope ? { scope: found.scope } : {}),
      ...(found.present !== undefined ? { shown: found.shown, present: found.present } : {}),
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

// ---- parts of pages -----------------------------------------------------------

export const PART_OF_A_PAGE =
  "NOTE: this address returned a part of a page, not a whole page. The application loads it into another page (a dialog, a panel), and what that page's scripts add, such as the buttons that submit a form, is missing here. Do not work from this address: go to the page that links to it and click the link there.";

/**
 * Some addresses answer with a piece of HTML that the application places
 * inside a page it already shows. Opened on its own, such a piece has no
 * scripts and so lacks whatever they draw. A whole page declares itself with
 * an html, head or body element; a piece does not. Decided from the response
 * as the server sent it, since a browser wraps anything in those elements.
 */
export async function partOfAPage(response: { headers(): Record<string, string>; text(): Promise<string> } | null): Promise<string | undefined> {
  if (!response || !/html/i.test(response.headers()["content-type"] ?? "")) return undefined;
  const body = await response.text().catch(() => "");
  if (body.trim() === "" || /<(html|head|body)[\s>]/i.test(body)) return undefined;
  return PART_OF_A_PAGE;
}

// ---- synthetic files --------------------------------------------------------

/** A picture of one transparent pixel. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/**
 * The content of a file made for a test. It depends on the name and kind
 * alone, so a plan can state it in advance and a repeat sends the same bytes.
 * Nothing is ever read from the machine the test runs on.
 */
export function syntheticFile(name: string, kind: "text" | "image"): { name: string; mimeType: string; buffer: Buffer } {
  return kind === "image"
    ? { name, mimeType: "image/png", buffer: PIXEL }
    : { name, mimeType: "text/plain", buffer: Buffer.from(`Synthetic test file ${name}`, "utf8") };
}

// ---- tools ----------------------------------------------------------------

type Handlers = { [K in ToolName]: (s: Session, input: z.infer<(typeof schemas)[K]>) => Promise<string> };

const handlers: Handlers = {
  async navigate(s, { path: p }) {
    if (!p.startsWith("/") || p.startsWith("//")) throw new Error('path must start with a single "/".');
    for (const part of addressData(new URL(p, s.baseUrl))) noteSupplied(suppliedOf(s), s.steps.length + 1, "address", part);
    const response = await s.page.goto(new URL(p, s.baseUrl).toString(), { waitUntil: "load" });
    await settle(s.page);
    const part = await partOfAPage(response);
    return `${part ? `${part}\n` : ""}${await describePage(s)}`;
  },

  async click(s, { element }) {
    await (await locate(s.page, element)).click();
    await settle(s.page);
    return describePage(s);
  },

  async fill(s, { element, text }) {
    const field = await locate(s.page, element);
    noteSupplied(suppliedOf(s), s.steps.length + 1, "typed", text);
    const handle = await field.elementHandle().catch(() => null);
    if (handle) suppliedOf(s).filled.push(handle);
    await field.fill(text);
    // Some pages move the caret when a field takes the focus, and the new text
    // then lands after the old. What the field holds is checked; if it is not
    // what was given, the field is emptied and the text typed key by key.
    const holds = () => field.inputValue().catch(() => text);
    if ((await holds()) !== text) {
      await field.evaluate((el) => {
        (el as HTMLInputElement).value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      if (text !== "") await field.pressSequentially(text);
    }
    const now = await holds();
    // Lists of suggestions and live filters answer a moment after typing.
    await s.page.waitForTimeout(TYPING_PAUSE_MS);
    await settle(s.page);
    const page = await describePage(s);
    return now === text ? page : `NOTE: the field now holds ${JSON.stringify(now)}, which is not exactly what was given. The page may format what is typed, or may not have taken it.\n${page}`;
  },

  async select(s, { element, option }) {
    const list = await locate(s.page, element);
    noteSupplied(suppliedOf(s), s.steps.length + 1, "selected", option);
    const handle = await list.elementHandle().catch(() => null);
    if (handle) suppliedOf(s).filled.push(handle);
    await list.selectOption({ label: option });
    await settle(s.page);
    return describePage(s);
  },

  async press(s, { element, key }) {
    await (await locate(s.page, element)).press(key);
    await settle(s.page);
    return describePage(s);
  },

  async upload(s, { element, files }) {
    if (new Set(files.map((f) => f.name.toLowerCase())).size !== files.length) throw new Error("Each file needs its own name. Nothing was chosen.");
    const made = files.map((f) => syntheticFile(f.name, f.kind));
    const control = await locate(s.page, element);
    // The file field itself takes the files directly. Anything else must open
    // the browser's file dialog when clicked; that dialog is the only way a
    // file enters the page, and it is given these synthetic files and no other.
    const field = await control.evaluate((el) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "file").catch(() => false);
    if (field) {
      if (made.length > 1 && !(await control.evaluate((el) => (el as HTMLInputElement).multiple))) {
        throw new Error("This file field takes one file. Nothing was chosen.");
      }
      await control.setInputFiles(made);
    } else {
      const dialog = s.page.waitForEvent("filechooser", { timeout: LOCATE_TIMEOUT_MS }).catch(() => undefined);
      await control.click();
      const chooser = await dialog;
      if (!chooser) {
        throw new Error(`${describeRef(element)} was clicked and opened no file dialog, so it is not a control for choosing files. Nothing was chosen.`);
      }
      if (made.length > 1 && !chooser.isMultiple()) {
        await chooser.setFiles([]).catch(() => undefined);
        throw new Error("This file field takes one file. Nothing was chosen.");
      }
      await chooser.setFiles(made);
    }
    await settle(s.page);
    const listing = made.map((f) => `${f.name} (${f.buffer.length} bytes, ${f.mimeType}${f.mimeType === "text/plain" ? `, content ${JSON.stringify(f.buffer.toString("utf8"))}` : ""})`).join("; ");
    return `Chose ${made.length} file${made.length === 1 ? "" : "s"}: ${listing}\n${await describePage(s)}`;
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
    // What this answer says about values entered earlier, then what this request itself carried.
    const state = suppliedOf(s);
    noteAnswer(state, { method, url, status: response.status(), body: async () => text });
    const accepted = method !== "GET" && response.status() < 400;
    for (const part of [...addressData(url), ...scalars(body)]) noteSupplied(state, s.steps.length + 1, "request", part, { responseId: id, written: accepted });
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
    const { text, raw, locator, scope } = await readTarget(s, target);
    await requireSubject(locator, target, "value", `Observation "${name}"`);
    const trail = trailOf(s);
    const reading = () => {
      trail.observed[name] = s.steps.length + 1;
      (trail.readings ??= {})[name] = {
        step: s.steps.length + 1,
        from: target.source,
        locatedBy: `${describeTarget(target)}${scope ? `, counted ${scope}` : ""}`,
        raw: clip(raw, 200),
        ...(target.source === "page" ? { page: pagePath(s) } : { responseId: target.responseId }),
        ...(trail.actor ? { actor: trail.actor } : {}),
      };
    };
    if (mine?.type === "text") {
      await independent(s, `Observation "${name}" was not recorded`, { texts: [text] }, target, locator);
      (s.texts ??= {})[name] = text;
      reading();
      return `Recorded ${name} = ${JSON.stringify(text)}`;
    }
    const read = parseNumber(text);
    const value = reconcile(mine?.unit, raw, read);
    if (!value.comparable) throw new Error(`Observation "${name}" was not recorded: ${value.why}.`);
    await independent(s, `Observation "${name}" was not recorded`, { numbers: [read, value.value] }, target, locator);
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
    let scope: string | undefined;
    let counted: { shown: number; present: number } | undefined;
    let entered: { step: number; how: string; confirmedBy: string } | undefined;

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
      if (s.quotedOnly) {
        // What counts as the thing looked for must be worded by the approved text, not by the plan.
        const quote = squash(assertion.provenance?.quote ?? "").toLowerCase();
        const wording = target.source === "page" && target.by !== "testid" ? squash(target.value).toLowerCase() : "";
        if (wording.length < 2 || !quote.includes(wording)) {
          throw new Error(
            `Assertion ${assertionId} was not compared: in this run a presence check must look for wording the approved text states, by text, label or role name. The approved text is ${JSON.stringify(clip(assertion.provenance?.quote ?? "", 200))}. No result was recorded.`,
          );
        }
      }
      if (pass && assertion.kind === "present" && target.source === "page" && target.by !== "testid") {
        entered = await independent(s, `Assertion ${assertionId} was not compared`, { texts: [target.value] }, target, locator);
      }
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
      scope = read.scope;
      if (read.present !== undefined) counted = { shown: Number(read.raw), present: read.present };
      const loop = circular(target, expected, assertion);
      if (loop) throw new Error(`Assertion ${assertionId} was not compared: ${loop} No result was recorded.`);
      if ("formula" in assertion.expected) {
        // A value compared with a reading of the same place, with nothing done in between, is compared with itself.
        const trail = trailOf(s);
        const here = `${describeTarget(target)}${read.scope ? `, counted ${read.scope}` : ""}`;
        const same = formulaVariables(assertion.expected.formula).filter((v) => {
          const reading = trail.readings?.[v];
          return reading !== undefined && reading.locatedBy === here && reading.from === target.source && (trail.action === undefined || trail.action.step < reading.step);
        });
        if (same.length > 0) {
          throw new Error(
            `Assertion ${assertionId} was not compared: its expected value is calculated from ${same.join(", ")}, read from this same place with nothing done since. That compares a value with itself. No result was recorded.`,
          );
        }
      }
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
      // A match with a value the executor itself entered counts only with evidence that is not the executor's.
      if (pass) {
        entered = await independent(
          s,
          `Assertion ${assertionId} was not compared`,
          typeof actual === "number" ? { numbers: [actual, ...(readAs === undefined ? [] : [readAs])] } : { texts: [actual, String(expected)] },
          target,
          locator,
        );
      }
    }

    const evidence = { ...(await gatherEvidence(s, assertion, target, { locator, raw, matched, scope, ...counted })), ...(entered ? { entered } : {}) };
    const shot = await screenshot(s, `check-${assertionId}`, locator);
    s.assertionResults.push({ assertionId, expected, actual, pass, target, ...(readAs === undefined ? {} : { readAs }), evidence, screenshot: shot });
    return `Recorded ${assertionId}: expected ${expected}, actual ${actual}${readAs === undefined ? "" : ` (read as ${readAs}, converted to the assertion's unit)`} -> ${pass ? "match" : "MISMATCH"}. This result is final.`;
  },

  async finish(s, { outcome, reason, cause, error }) {
    if (outcome === "blocked" && cause === "application-error") {
      if (error) {
        // The executor says where the error is; code reads what it says.
        const read = await readTarget(s, error);
        if (read.text.trim() === "") throw new Error("The element pointed at as the error shows no text. Point at the element that shows the error message.");
        const trail = trailOf(s);
        (s.appErrors ??= []).push({
          step: s.steps.length + 1,
          source: "page",
          ...(trail.actor ? { actor: trail.actor } : {}),
          ...(trail.action ? { action: trail.action } : {}),
          page: pagePath(s),
          locatedBy: describeTarget(error),
          text: clip(read.text, 300),
        });
      } else if (!(s.appErrors ?? []).length) {
        throw new Error('No error answer of the application was recorded in this scenario. If the page shows an error message, point "error" at the element that shows it; otherwise choose another cause.');
      }
    }
    s.outcome = outcome === "blocked" ? { kind: outcome, reason, ...(cause ? { cause } : {}) } : { kind: outcome, reason };
    return "Scenario ended.";
  },
};

/**
 * Words a failing application writes into a page it still answers with
 * status 200. Each must start its line, or be a marker nobody writes in
 * prose, so that a sentence which merely mentions an error is not one.
 */
const FAILURE_WORDS = [
  /^internal (server )?error\b/i,
  /^(\w+ )?(fatal|parse) error\b/i,
  /^traceback \(most recent call last\)/i,
  /^(unhandled|uncaught) (exception|error)\b/i,
  /^[A-Za-z_][\w.\\]*(Exception|Error): \S/,
  /\bSQLSTATE\[/,
  /^(sql|database|query) error\b/i,
];
const readsLikeFailure = (line: string) => FAILURE_WORDS.some((p) => p.test(line));

/**
 * The lines the page shows that read like a failure of the application.
 * Left out: quoted or sample text (pre, code, blockquote and the like),
 * where documentation and logs show such words, and anything editable.
 */
async function failureLines(page: Page): Promise<string[]> {
  const lines = await page
    .evaluate(() => {
      const skip = new Set<string>();
      const quoted = document.querySelectorAll("pre, code, kbd, samp, blockquote, textarea, [contenteditable]");
      for (let i = 0; i < quoted.length; i++) {
        const inner = ((quoted[i] as HTMLElement).innerText ?? "").split("\n");
        for (let j = 0; j < inner.length; j++) skip.add(inner[j]!.trim());
      }
      const all = (document.body?.innerText ?? "").split("\n");
      const out: string[] = [];
      for (let i = 0; i < all.length; i++) {
        const line = all[i]!.trim();
        if (line !== "" && line.length <= 500 && !skip.has(line)) out.push(line);
      }
      return out;
    })
    .catch(() => [] as string[]);
  return [...new Set(lines.filter(readsLikeFailure))];
}

/** Tools that do what a user does. An error answer to one of them is the application's answer to a user. */
const USER_ACTIONS = new Set<string>(["navigate", "click", "fill", "select", "press", "upload"]);

const errorNote = (e: ApplicationError) =>
  `NOTE: the application answered ${e.request?.method} ${e.request?.path} with HTTP ${e.request?.status}${e.text ? `: "${e.text}"` : ""}. That is an error of the application, not of your step. If it keeps you from the checks, call finish with outcome "blocked" and cause "application-error".`;

/**
 * Notes an error answer of the application, if this response is one: same
 * origin, status 500 or above, while a user action is being carried out.
 * Requests the executor sends itself are not included; an error there may be
 * the test's own doing, and its response is already on record.
 */
export function noteResponse(session: Session, response: { url(): string; status(): number; request(): { method(): string }; text(): Promise<string> }): void {
  if (!session.acting || response.status() < 500) return;
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (url.origin !== new URL(session.baseUrl).origin) return;
  const entry: ApplicationError = {
    step: session.steps.length + 1,
    source: "response",
    request: { method: response.request().method(), path: clip(`${url.pathname}${url.search}`, 200), status: response.status() },
    text: "",
  };
  (session.appErrors ??= []).push(entry);
  // The body of a page that has since been replaced may never arrive; the
  // status is the finding, the text a help, so the wait for it is short.
  (session.pendingErrors ??= []).push(
    Promise.race([response.text(), new Promise<string>((resolve) => setTimeout(() => resolve(""), 2_000))])
      .then((body) => {
        entry.text = session.vault.scrub(clip(squash(body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")), 300));
      })
      .catch(() => {}),
  );
}

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
    const before = session.appErrors?.length ?? 0;
    session.acting = USER_ACTIONS.has(tool) ? tool : undefined;
    // What already read like a failure before this step is not this step's doing.
    const shownBefore = session.acting ? new Set(await failureLines(session.page)) : undefined;
    try {
      output = await (handlers[tool] as (s: Session, i: unknown) => Promise<string>)(session, resolved);
    } finally {
      await Promise.all(session.pendingErrors ?? []);
      session.pendingErrors = [];
      if (session.supplied) await settled(session.supplied);
      session.acting = undefined;
    }
    const met = (session.appErrors ?? []).slice(before).filter((e) => e.source === "response");
    if (met.length > 0) {
      const trail = trailOf(session);
      for (const e of met) {
        e.step = session.steps.length + 1;
        if (trail.actor) e.actor = trail.actor;
        // The action that was answered with the error is this one, not the last one noted before it.
        const given = resolved as { element?: { by: string; role?: string; value: string }; path?: string };
        e.action = { step: e.step, tool, what: session.vault.scrub(given.element ? describeRef(given.element) : clip(String(given.path ?? ""), 120)) };
      }
      output = `${met.map(errorNote).join("\n")}\n${output}`;
    }
    if (shownBefore) {
      const given = resolved as { element?: { by: string; role?: string; value: string }; path?: string; text?: string };
      if (tool === "fill" && typeof given.text === "string" && given.text.trim() !== "") (session.typed ??= []).push(given.text.trim());
      // New on the page, and not the executor's own words shown back to it.
      const own = (session.typed ?? []).filter(readsLikeFailure);
      const fresh = (await failureLines(session.page)).filter((line) => !shownBefore.has(line) && !own.some((words) => line.includes(words)));
      if (fresh.length > 0 && met.length === 0) {
        const trail = trailOf(session);
        const step = session.steps.length + 1;
        const action = { step, tool, what: session.vault.scrub(given.element ? describeRef(given.element) : clip(String(given.path ?? ""), 120)) };
        for (const line of fresh.slice(0, 3)) {
          (session.errorSignals ??= []).push({ step, ...(trail.actor ? { actor: trail.actor } : {}), action, page: pagePath(session), text: session.vault.scrub(clip(line, 300)) });
        }
        output = `NOTE: after this step the page newly shows text that reads like an error of the application: "${clip(fresh[0]!, 300)}". Nothing is concluded from the words alone. If the application did fail and that keeps you from the checks, call finish with outcome "blocked", cause "application-error" and "error" pointing at the element that shows this text. If it is ordinary content, carry on.\n${output}`;
      }
    }
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
