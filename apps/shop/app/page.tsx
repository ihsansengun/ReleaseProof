import { getProducts, money } from "@/lib/shop";
import { addToCartAction } from "./actions";

export default function ProductsPage() {
  return (
    <>
      <h1>Products</h1>
      <ul className="products">
        {getProducts().map((p) => (
          <li key={p.id}>
            <h2>{p.name}</h2>
            <p>{money(p.priceCents)}</p>
            <form action={addToCartAction}>
              <input type="hidden" name="productId" value={p.id} />
              <button type="submit" aria-label={`Add ${p.name} to cart`}>
                Add to cart
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
