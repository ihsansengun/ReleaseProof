import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db";

export const WELCOME_POINTS = 100;
const SUCCESS_CARD = "4242424242424242";

export type Customer = { id: number; email: string; name: string };
export type CartLine = {
  productId: number;
  name: string;
  priceCents: number;
  quantity: number;
  lineCents: number;
};

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** One point per whole currency unit spent. */
export const purchasePoints = (cents: number) => Math.floor(cents / 100);

// ---- customers ------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

export function createCustomer(email: string, name: string, password: string): Customer {
  const res = db()
    .prepare("INSERT INTO customers (email, name, password_hash) VALUES (?, ?, ?)")
    .run(email, name, hashPassword(password));
  return { id: Number(res.lastInsertRowid), email, name };
}

export function deleteCustomerByEmail(email: string): void {
  const row = db().prepare("SELECT id FROM customers WHERE email = ?").get(email) as
    | { id: number }
    | undefined;
  if (!row) return;
  const d = db();
  d.prepare(
    "DELETE FROM payment_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ?)",
  ).run(row.id);
  for (const table of ["cart_items", "cart_promos", "orders", "loyalty_transactions"]) {
    d.prepare(`DELETE FROM ${table} WHERE customer_id = ?`).run(row.id);
  }
  d.prepare("DELETE FROM customers WHERE id = ?").run(row.id);
}

export function authenticate(email: string, password: string): Customer | null {
  const row = db()
    .prepare("SELECT id, email, name, password_hash FROM customers WHERE email = ?")
    .get(email) as (Customer & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export function getCustomer(id: number): Customer | null {
  const row = db().prepare("SELECT id, email, name FROM customers WHERE id = ?").get(id);
  return (row as Customer | undefined) ?? null;
}

// ---- catalogue and cart ---------------------------------------------------

export function getProducts() {
  return db().prepare("SELECT id, name, price_cents AS priceCents FROM products ORDER BY id").all() as {
    id: number;
    name: string;
    priceCents: number;
  }[];
}

export function getCart(customerId: number) {
  const lines = db()
    .prepare(
      `SELECT p.id AS productId, p.name, p.price_cents AS priceCents, c.quantity,
              p.price_cents * c.quantity AS lineCents
       FROM cart_items c JOIN products p ON p.id = c.product_id
       WHERE c.customer_id = ? ORDER BY p.id`,
    )
    .all(customerId) as CartLine[];
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
  const promo = appliedPromo(customerId);
  const discountCents = promo ? discountFor(promo, subtotalCents) : 0;
  const totalCents = subtotalCents - discountCents;
  return {
    lines,
    subtotalCents,
    promoCode: promo?.code ?? null,
    discountCents,
    totalCents,
    potentialPoints: purchasePoints(totalCents),
  };
}

export function addToCart(customerId: number, productId: number): void {
  db()
    .prepare(
      `INSERT INTO cart_items (customer_id, product_id, quantity) VALUES (?, ?, 1)
       ON CONFLICT (customer_id, product_id) DO UPDATE SET quantity = quantity + 1`,
    )
    .run(customerId, productId);
}

export function setQuantity(customerId: number, productId: number, quantity: number): void {
  if (quantity <= 0) {
    db()
      .prepare("DELETE FROM cart_items WHERE customer_id = ? AND product_id = ?")
      .run(customerId, productId);
  } else {
    db()
      .prepare("UPDATE cart_items SET quantity = ? WHERE customer_id = ? AND product_id = ?")
      .run(quantity, customerId, productId);
  }
}

// ---- promo codes ----------------------------------------------------------

type Promo = {
  code: string;
  kind: "percent" | "fixed";
  /** Percentage points for "percent", cents for "fixed". */
  value: number;
  minSubtotalCents: number;
};

const PROMOS: Promo[] = [
  { code: "SAVE10", kind: "percent", value: 10, minSubtotalCents: 0 },
  { code: "TAKE15", kind: "fixed", value: 1500, minSubtotalCents: 6000 },
];

const findPromo = (code: string) => PROMOS.find((p) => p.code === code) ?? null;

function discountFor(promo: Promo, subtotalCents: number): number {
  const discount =
    promo.kind === "percent" ? Math.round((subtotalCents * promo.value) / 100) : promo.value;
  return Math.min(discount, subtotalCents);
}

function appliedPromo(customerId: number): Promo | null {
  const row = db().prepare("SELECT code FROM cart_promos WHERE customer_id = ?").get(customerId) as
    | { code: string }
    | undefined;
  return row ? findPromo(row.code) : null;
}

/** A code counts as used once the customer has placed an order with it. */
function hasUsedPromo(customerId: number, code: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM orders WHERE customer_id = ? AND promo_code = ? LIMIT 1")
    .get(customerId, code);
  return row !== undefined;
}

export type PromoProblem = "unknown" | "used" | "minimum";
export type ApplyPromoResult = { ok: true; code: string } | { ok: false; reason: PromoProblem; code: string };

/** Applies a promo code to the customer's cart, replacing any code already on it. */
export function applyPromo(customerId: number, input: string): ApplyPromoResult {
  const code = input.trim().toUpperCase();
  const promo = findPromo(code);
  if (!promo) return { ok: false, reason: "unknown", code };
  if (hasUsedPromo(customerId, code)) return { ok: false, reason: "used", code };
  if (getCart(customerId).subtotalCents < promo.minSubtotalCents) {
    return { ok: false, reason: "minimum", code };
  }
  db()
    .prepare(
      `INSERT INTO cart_promos (customer_id, code) VALUES (?, ?)
       ON CONFLICT (customer_id) DO UPDATE SET code = excluded.code`,
    )
    .run(customerId, code);
  return { ok: true, code };
}

export function removePromo(customerId: number): void {
  db().prepare("DELETE FROM cart_promos WHERE customer_id = ?").run(customerId);
}

export function promoProblemMessage(reason: string, code: string): string {
  const promo = findPromo(code);
  if (reason === "used" && promo) return `You have already used promo code ${promo.code}.`;
  if (reason === "minimum" && promo) {
    return `${promo.code} needs a subtotal of at least ${money(promo.minSubtotalCents)}.`;
  }
  return "That promo code is not valid.";
}

// ---- checkout, payment and loyalty ----------------------------------------

export type CheckoutResult =
  | { ok: true; orderId: number }
  | { ok: false; reason: "empty_cart" | "payment_declined"; orderId?: number };

/** Creates the order, charges the (fake) card and, on success, settles it. */
export function checkout(customerId: number, cardNumber: string): CheckoutResult {
  const cart = getCart(customerId);
  if (cart.lines.length === 0) return { ok: false, reason: "empty_cart" };

  const res = db()
    .prepare(
      `INSERT INTO orders (customer_id, total_cents, discount_cents, promo_code, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    )
    .run(customerId, cart.totalCents, cart.discountCents, cart.promoCode);
  const orderId = Number(res.lastInsertRowid);

  if (cardNumber.replace(/\D/g, "") !== SUCCESS_CARD) {
    db().prepare("UPDATE orders SET status = 'payment_failed' WHERE id = ?").run(orderId);
    return { ok: false, reason: "payment_declined", orderId };
  }

  applyPaymentEvent({ eventId: `evt_checkout_${orderId}`, orderId, type: "payment.succeeded" });
  db().prepare("DELETE FROM cart_items WHERE customer_id = ?").run(customerId);
  removePromo(customerId);
  return { ok: true, orderId };
}

export type PaymentEvent = { eventId: string; orderId: number; type: string };

/**
 * Settles an order from a payment-provider event. Each event id is processed
 * at most once, and an order that is already paid is never credited again.
 */
export function applyPaymentEvent(event: PaymentEvent): "applied" | "duplicate" | "ignored" {
  const d = db();
  const seen = d.prepare("SELECT 1 FROM payment_events WHERE event_id = ?").get(event.eventId);
  if (seen) return "duplicate";
  d.prepare("INSERT INTO payment_events (event_id, order_id, type) VALUES (?, ?, ?)").run(
    event.eventId,
    event.orderId,
    event.type,
  );

  if (event.type !== "payment.succeeded") return "ignored";
  const order = d
    .prepare("SELECT id, customer_id AS customerId, total_cents AS totalCents, status FROM orders WHERE id = ?")
    .get(event.orderId) as
    | { id: number; customerId: number; totalCents: number; status: string }
    | undefined;
  if (!order || order.status === "paid") return "ignored";

  const paidBefore = d
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'paid'")
    .get(order.customerId) as { n: number };
  d.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);

  const credit = d.prepare(
    "INSERT INTO loyalty_transactions (customer_id, order_id, points, reason) VALUES (?, ?, ?, ?)",
  );
  credit.run(order.customerId, order.id, purchasePoints(order.totalCents), "purchase");
  if (paidBefore.n === 0) {
    credit.run(order.customerId, order.id, WELCOME_POINTS, "welcome");
  }
  return "applied";
}

export function getAccount(customerId: number) {
  const d = db();
  const balance = d
    .prepare("SELECT COALESCE(SUM(points), 0) AS balance FROM loyalty_transactions WHERE customer_id = ?")
    .get(customerId) as { balance: number };
  const transactions = d
    .prepare(
      "SELECT id, order_id AS orderId, points, reason FROM loyalty_transactions WHERE customer_id = ? ORDER BY id",
    )
    .all(customerId);
  const orders = d
    .prepare(
      `SELECT id, total_cents AS totalCents, discount_cents AS discountCents, promo_code AS promoCode, status
       FROM orders WHERE customer_id = ? ORDER BY id`,
    )
    .all(customerId) as {
    id: number;
    totalCents: number;
    discountCents: number;
    promoCode: string | null;
    status: string;
  }[];
  return { balance: balance.balance, transactions, orders };
}
