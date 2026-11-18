import type { ReactNode } from "react";
import Link from "next/link";
import { currentCustomer } from "@/lib/session";
import { logoutAction } from "./actions";
import "./globals.css";

export const metadata = { title: "Northwind Goods" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const customer = await currentCustomer();
  return (
    <html lang="en">
      <body>
        <header>
          <strong>Northwind Goods</strong>
          <nav style={{ display: "flex", gap: "1rem" }}>
            <Link href="/">Products</Link>
            <Link href="/cart">Cart</Link>
            <Link href="/account">Account</Link>
          </nav>
          {customer ? (
            <form action={logoutAction}>
              <button type="submit">Sign out</button>
            </form>
          ) : (
            <Link href="/login">Sign in</Link>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
