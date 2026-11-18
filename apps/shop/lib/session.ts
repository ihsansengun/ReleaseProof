import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCustomer, type Customer } from "./shop";

// Demo-only session: the cookie holds the customer id unsigned. Acceptable for
// a synthetic test target; do not copy into anything real.
const COOKIE = "sid";

export async function currentCustomer(): Promise<Customer | null> {
  const id = Number((await cookies()).get(COOKIE)?.value);
  return Number.isInteger(id) && id > 0 ? getCustomer(id) : null;
}

export async function requireCustomer(): Promise<Customer> {
  const customer = await currentCustomer();
  if (!customer) redirect("/login");
  return customer;
}

export async function signIn(customerId: number) {
  (await cookies()).set(COOKIE, String(customerId), { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}
