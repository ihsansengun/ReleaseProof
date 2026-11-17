"use server";

import { redirect } from "next/navigation";
import { requireCustomer, signIn, signOut } from "@/lib/session";
import { addToCart, authenticate, checkout, setQuantity } from "@/lib/shop";

export async function loginAction(form: FormData) {
  const customer = authenticate(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (!customer) redirect("/login?error=1");
  await signIn(customer.id);
  redirect("/account");
}

export async function logoutAction() {
  await signOut();
  redirect("/login");
}

export async function addToCartAction(form: FormData) {
  const customer = await requireCustomer();
  addToCart(customer.id, Number(form.get("productId")));
  redirect("/cart");
}

export async function updateQuantityAction(form: FormData) {
  const customer = await requireCustomer();
  const quantity = Math.max(0, Math.floor(Number(form.get("quantity")) || 0));
  setQuantity(customer.id, Number(form.get("productId")), quantity);
  redirect("/cart");
}

export async function payAction(form: FormData) {
  const customer = await requireCustomer();
  const result = checkout(customer.id, String(form.get("card") ?? ""));
  if (result.ok) redirect(`/account?order=${result.orderId}`);
  redirect(result.reason === "empty_cart" ? "/cart" : "/checkout?error=declined");
}
