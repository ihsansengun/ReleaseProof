import { requireCustomer } from "@/lib/session";
import { getAccount, money } from "@/lib/shop";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const customer = await requireCustomer();
  const account = getAccount(customer.id);
  const { order } = await searchParams;

  return (
    <>
      <h1>Account overview</h1>
      {order && (
        <p role="status" className="notice">
          Order #{order} confirmed. Thank you for your purchase.
        </p>
      )}
      <p>
        Signed in as {customer.name} ({customer.email})
      </p>

      <h2>Loyalty</h2>
      <p>
        Loyalty balance: <strong data-testid="loyalty-balance">{account.balance}</strong> points
      </p>

      <h2>Orders</h2>
      {account.orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Discount</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {account.orders.map((o) => (
              <tr key={o.id}>
                <td>#{o.id}</td>
                <td>{o.promoCode ? `-${money(o.discountCents)} (${o.promoCode})` : "None"}</td>
                <td>{money(o.totalCents)}</td>
                <td>{o.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
