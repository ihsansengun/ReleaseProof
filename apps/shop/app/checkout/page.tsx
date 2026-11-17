import { redirect } from "next/navigation";
import { requireCustomer } from "@/lib/session";
import { getCart, money } from "@/lib/shop";
import { payAction } from "../actions";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const customer = await requireCustomer();
  const cart = getCart(customer.id);
  if (cart.lines.length === 0) redirect("/cart");
  const { error } = await searchParams;

  return (
    <>
      <h1>Checkout</h1>
      {error && (
        <p role="alert" className="notice error">
          Payment declined. Your card was not charged.
        </p>
      )}
      <p>
        Order total: <strong data-testid="order-total">{money(cart.subtotalCents)}</strong>
      </p>
      <form action={payAction}>
        <label htmlFor="card">Card number</label>
        <input id="card" name="card" inputMode="numeric" autoComplete="off" required />
        <p>
          <button type="submit">Pay now</button>
        </p>
      </form>
    </>
  );
}
