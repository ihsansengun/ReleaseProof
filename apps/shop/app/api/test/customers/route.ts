import { createCustomer, deleteCustomerByEmail } from "@/lib/shop";

/**
 * Test fixture: creates a customer with no orders and no loyalty history.
 * The same key always yields the same identity; calling it again resets that
 * customer. Only available when the server runs with TEST_MODE=1.
 */
export async function POST(request: Request) {
  if (process.env.TEST_MODE !== "1") return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.toLowerCase().replace(/[^a-z0-9-]/g, "-") : "";
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  const email = `${key}@fixtures.test`;
  const password = `pw-${key}`;
  const name = `Test Customer ${key}`;
  deleteCustomerByEmail(email);
  const customer = createCustomer(email, name, password);
  return Response.json({ id: customer.id, email, password, name });
}
