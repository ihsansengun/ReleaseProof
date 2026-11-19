/**
 * Units of the numbers a plan compares.
 *
 * A plan that expects 2160 and a page that shows 21.60 with a currency sign
 * may be saying the same thing. Comparing them as bare numbers reports a
 * defect that is not there. A plan therefore says what unit each number is
 * in, and the value read is brought to that unit where the page shows which
 * unit it uses. Where that cannot be established, nothing is compared.
 */
import { z } from "zod";

export const Unit = z.enum([
  /** A count, an identifier, a status code: no unit. */
  "plain",
  /** Money as people write it: 21.60. */
  "currency-units",
  /** Money in hundredths of the unit: 2160. */
  "currency-hundredths",
]);
export type Unit = z.infer<typeof Unit>;

const CURRENCY = /[$€£¥₹₩₺₽]|\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|INR)\b/;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Whether the text a number was read from shows a currency sign or code. */
export const showsCurrency = (raw: string) => CURRENCY.test(raw);

export type Reconciled =
  | { comparable: true; value: number; converted: boolean }
  | { comparable: false; why: string };

/**
 * Brings a number that was read to the unit the plan declared.
 * `raw` is the text it was read from, before any pattern narrowed it.
 */
export function reconcile(declared: Unit | undefined, raw: string, read: number): Reconciled {
  if (declared === undefined || declared === "plain") return { comparable: true, value: read, converted: false };
  if (showsCurrency(raw)) {
    // A value written with a currency sign is in whole units.
    if (declared === "currency-units") return { comparable: true, value: read, converted: false };
    const hundredths = read * 100;
    if (!near(hundredths, Math.round(hundredths))) {
      return { comparable: false, why: `the value ${read} has more than two decimal places, so it cannot be expressed in hundredths` };
    }
    return { comparable: true, value: Math.round(hundredths), converted: true };
  }
  if (declared === "currency-hundredths" && !Number.isInteger(read)) {
    return { comparable: false, why: `hundredths were expected, and ${read} was read with no currency sign beside it to say what unit it is in` };
  }
  return { comparable: true, value: read, converted: false };
}

/**
 * For a money comparison that did not match: is the difference exactly a
 * factor of 100, with nothing on the page saying which unit the value is in?
 * Then the two may be the same amount, and the comparison proves nothing.
 */
export function scaleUnclear(declared: Unit | undefined, raw: string, expected: number, actual: number): string | undefined {
  if (declared === undefined || declared === "plain" || showsCurrency(raw) || near(expected, actual)) return undefined;
  if (expected !== 0 && (near(actual * 100, expected) || near(expected * 100, actual))) {
    return `the value read (${actual}) and the expected value (${expected}) differ by exactly a factor of 100, and nothing beside the value says what unit it is in`;
  }
  return undefined;
}
