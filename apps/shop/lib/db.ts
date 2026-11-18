import { DatabaseSync } from "node:sqlite";

// One connection per server process. The file is created on first use, so a
// fresh checkout (or a fresh CI runner) always starts from the seed below.
const globalForDb = globalThis as unknown as { shopDb?: DatabaseSync };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cart_items (
  customer_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL,
  type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  order_id INTEGER,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const PRODUCTS: [number, string, number][] = [
  [1, "Canvas Tote Bag", 2499],
  [2, "Ceramic Pour-Over Set", 5950],
  [3, "Notebook, Dotted A5", 1200],
  [4, "Wool Throw Blanket", 12995],
];

export function db(): DatabaseSync {
  if (!globalForDb.shopDb) {
    const conn = new DatabaseSync(process.env.DATABASE_FILE ?? "shop.db");
    conn.exec(SCHEMA);
    const insert = conn.prepare(
      "INSERT OR IGNORE INTO products (id, name, price_cents) VALUES (?, ?, ?)",
    );
    for (const p of PRODUCTS) insert.run(...p);
    globalForDb.shopDb = conn;
  }
  return globalForDb.shopDb;
}
