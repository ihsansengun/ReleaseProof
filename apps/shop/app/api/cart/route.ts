import { currentCustomer } from "@/lib/session";
import { getCart } from "@/lib/shop";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { lines, subtotalCents, promoCode, discountCents, totalCents } = getCart(customer.id);
  return Response.json({ lines, subtotalCents, promoCode, discountCents, totalCents });
}
