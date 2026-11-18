import Link from "next/link";
import { requireCustomer } from "@/lib/session";
import { getCart, money } from "@/lib/shop";
import { updateQuantityAction } from "../actions";

export default async function CartPage() {
  const customer = await requireCustomer();
  const cart = getCart(customer.id);

  if (cart.lines.length === 0) {
    return (
      <>
        <h1>Cart</h1>
        <p>Your cart is empty.</p>
      </>
    );
  }

  return (
    <>
      <h1>Cart</h1>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
            <th>Quantity</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {cart.lines.map((line) => (
            <tr key={line.productId}>
              <td>{line.name}</td>
              <td>{money(line.priceCents)}</td>
              <td>
                <form action={updateQuantityAction} className="inline">
                  <input type="hidden" name="productId" value={line.productId} />
                  <input
                    name="quantity"
                    type="number"
                    min={0}
                    defaultValue={line.quantity}
                    aria-label={`Quantity for ${line.name}`}
                    style={{ width: "4.5rem" }}
                  />
                  <button type="submit" aria-label={`Update quantity for ${line.name}`}>
                    Update
                  </button>
                </form>
              </td>
              <td>{money(line.lineCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Subtotal: <strong data-testid="cart-subtotal">{money(cart.subtotalCents)}</strong>
      </p>
      <p>
        You could earn <strong data-testid="potential-points">{cart.potentialPoints}</strong> loyalty
        points with this purchase.
      </p>
      <p>
        <Link href="/checkout">Proceed to checkout</Link>
      </p>
    </>
  );
}
