import { currentCustomer } from "@/lib/session";
import { getAccount } from "@/lib/shop";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json({ customer, ...getAccount(customer.id) });
}
