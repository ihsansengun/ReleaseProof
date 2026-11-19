/**
 * A check, with no model, that a started application answers and that the
 * accounts its manifest declares can sign in. Used by verification runs.
 *
 * It knows nothing about any one application. It opens the address, and if
 * the page has exactly one password field it fills that field and the first
 * ordinary input of the same form from the manifest, submits, and looks
 * whether the password field is gone.
 */
import path from "node:path";
import { closeSession, openSession } from "../execute/run.ts";
import type { Manifest, Scenario } from "../schema.ts";

export type Availability = {
  /** HTTP status of the first page, after redirects. 0 if nothing answered. */
  status: number;
  accounts: { alias: string; outcome: "signed in" | "not signed in" | "no sign-in form found" }[];
  ok: boolean;
};

const PASSWORD = 'input[type="password"]';
const NAME = 'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])';

export async function checkAvailability(manifest: Manifest, outDir: string): Promise<Availability> {
  const result: Availability = { status: 0, accounts: [], ok: false };
  const aliases = Object.keys(manifest.accounts);
  // One visit without an account, then one fresh browser per declared account.
  for (const alias of [undefined, ...aliases]) {
    const scenario: Scenario = { id: `availability-${alias ?? "anonymous"}`, title: "availability", basis: "exploratory", requirementIds: [], intent: "", fixtures: {}, assertions: [] };
    const open = await openSession({ scenario, manifest, outDir: path.join(outDir, scenario.id) });
    const { page } = open.session;
    try {
      const response = await page.goto(manifest.baseUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => null);
      if (alias === undefined) {
        result.status = response?.status() ?? 0;
        continue;
      }
      const account = manifest.accounts[alias]!;
      const passwords = page.locator(PASSWORD).filter({ visible: true });
      if ((await passwords.count()) !== 1) {
        result.accounts.push({ alias, outcome: "no sign-in form found" });
        continue;
      }
      const form = page.locator("form").filter({ has: page.locator(PASSWORD) }).first();
      const name = ((await form.count()) > 0 ? form : page).locator(NAME).filter({ visible: true }).first();
      if ((await name.count()) === 0) {
        result.accounts.push({ alias, outcome: "no sign-in form found" });
        continue;
      }
      await name.fill(account.username);
      await passwords.first().fill(account.password);
      await passwords.first().press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      const still = await page.locator(PASSWORD).filter({ visible: true }).count();
      result.accounts.push({ alias, outcome: still === 0 ? "signed in" : "not signed in" });
    } catch {
      if (alias !== undefined) result.accounts.push({ alias, outcome: "not signed in" });
    } finally {
      open.session.outcome = { kind: "completed", reason: "availability check" };
      await closeSession(open, { mode: "replay" }).catch(() => {});
    }
  }
  result.ok = result.status > 0 && result.status < 500 && result.accounts.every((a) => a.outcome === "signed in");
  return result;
}
