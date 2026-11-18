# SEALED answer key: shop, NWG-342 "Promo codes in the cart"

- Feature branch: `claude/heldout-shop-promo-codes` (commit `5ca65f0`), base `965be18`
- Fixed branch: `claude/heldout-shop-promo-codes-fixed` (commit `6089099`)
- Line numbers below refer to the feature branch.

## Feature

Customers can apply one promo code on the cart page. `SAVE10` takes 10% off the subtotal; `TAKE15` takes $15.00 off a subtotal of at least $60.00 (the ticket description says $50.00, the last comment changes it to $60.00 inclusive, and the code follows the comment). The applied code is stored per customer (`cart_promos`), shown on the cart and checkout with a Discount line and a Total, stored on the order (`discount_cents`, `promo_code`, discounted `total_cents`), shown on the account overview and exposed by `GET /api/account` and the new `GET /api/cart`. A code can be used on one paid order per customer.

Catalogue prices used in the examples: Canvas Tote Bag $24.99, Ceramic Pour-Over Set $59.50, Notebook Dotted A5 $12.00, Wool Throw Blanket $129.95. Accepted card: 4242 4242 4242 4242; any other number is declined.

## Acceptance criteria

| # | Criterion (short) | Feature branch |
|---|---|---|
| 1 | Promo code field + Apply; SAVE10 = 10%, TAKE15 = $15.00 off with minimum subtotal (refined to $60.00, inclusive); case-insensitive, surrounding spaces ignored | Correct |
| 2 | Cart shows code, Discount, Total = subtotal - discount; checkout shows the same; percentage discount rounded DOWN to the whole cent | **Defect A** (rounding); the rest is correct |
| 3 | Unknown code: "That promo code is not valid.", previously applied code stays | Correct |
| 4 | TAKE15 below minimum: error naming the minimum, not applied; a later quantity change below the minimum removes the code | First half correct; **Defect C** (second half) |
| 5 | Remove button removes the code, Total = subtotal | Correct |
| 6 | Order charged the discounted total; code cleared after successful payment; same customer cannot reuse; other customers unaffected; a declined payment does not use up the code | **Defect B** (declined payment); the rest is correct |
| 7 | Account overview shows discount and total; `/api/account` has `discountCents`/`promoCode`; `/api/cart` has `subtotalCents`, `promoCode`, `discountCents`, `totalCents` | Correct (the fields are present and consistent; their values inherit Defect A where a rounding case is involved) |

## Planted defects

### Defect A: percentage discount is rounded to the nearest cent, not down (different rule than the ticket)

- Where: `apps/shop/lib/shop.ts` line 142, `discountFor`: `Math.round((subtotalCents * promo.value) / 100)`. Fixed branch uses `Math.floor`.
- Violates: criterion 2 ("A percentage discount is rounded down to the whole cent").
- Steps: sign in as a fresh customer, add 1 Canvas Tote Bag (subtotal $24.99), apply `SAVE10`.
  - Expected: Discount -$2.49, Total $22.50 (`discountCents` 249, `totalCents` 2250).
  - Actual: Discount -$2.50, Total $22.49 (`discountCents` 250, `totalCents` 2249). Checkout "Order total" shows $22.49 and the paid order is stored with `totalCents` 2249, `discountCents` 250.
- Second example: 1 Wool Throw Blanket ($129.95) with `SAVE10`: expected discount $12.99 / total $116.96; actual $13.00 / $116.95.
- Only visible when 10% of the subtotal has a fraction of a cent of 0.5 or more. Not visible with the Pour-Over Set ($59.50 -> $5.95 exactly) or with notebooks ($12.00 -> $1.20), so a tester who only uses those products sees correct numbers.

### Defect B: a declined payment uses up the promo code (off the happy path: failed payment, then repeat action)

- Where: `apps/shop/lib/shop.ts` line 156, `hasUsedPromo`: the query `SELECT 1 FROM orders WHERE customer_id = ? AND promo_code = ?` counts every order, including `payment_failed` ones. Fixed branch adds `AND status = 'paid'`.
- Violates: criterion 6 ("A declined payment does not use up the code: it stays on the cart and can still be removed and applied again").
- Steps: fresh customer, add 1 Ceramic Pour-Over Set ($59.50), apply `SAVE10` (Discount -$5.95, Total $53.55). Go to checkout, pay with card `4000 0000 0000 0002` -> "Payment declined. Your card was not charged." Back on the cart the code is still shown (that part is correct). Click Remove, then apply `SAVE10` again.
  - Expected: code is applied again, Discount -$5.95, Total $53.55.
  - Actual: error alert "You have already used promo code SAVE10."; no code on the cart, Total $59.50. The customer can never apply SAVE10 again, although they have no paid order with it (`/api/account` shows only a `payment_failed` order with `promoCode: "SAVE10"`).
- Note: if the tester does NOT remove the code after the decline and simply pays again with the good card, the discount is still applied and everything looks right. The defect needs the remove + re-apply (or switching to the other code and back) after a decline.

### Defect C: the minimum for TAKE15 is only checked when the code is applied (off the happy path: later cart change)

- Where: `apps/shop/lib/shop.ts` lines 111-121, `setQuantity`: nothing re-checks the applied code after a quantity change (and `getCart`, lines 82-100, applies the stored code without checking `minSubtotalCents`). Fixed branch removes the code at the end of `setQuantity` when the subtotal is below the code's minimum.
- Violates: criterion 4, second sentence ("If a later quantity change takes the subtotal below the minimum, the code is removed from the cart and the Total equals the subtotal again").
- Steps: fresh customer, add Notebook Dotted A5 and set its quantity to 5 (subtotal $60.00). Apply `TAKE15` -> Discount -$15.00, Total $45.00 (correct). Now set the quantity to 4 (subtotal $48.00).
  - Expected: no promo code on the cart, no Discount line, Total $48.00 (`/api/cart`: `promoCode: null`, `discountCents: 0`, `totalCents: 4800`).
  - Actual: "Promo code TAKE15 applied.", Discount (TAKE15): -$15.00, Total $33.00 (`promoCode: "TAKE15"`, `discountCents: 1500`, `totalCents: 3300`). Checkout charges $33.00.
  - Extreme: quantity 1 (subtotal $12.00) gives Discount -$12.00 and Total $0.00, because the discount is capped at the subtotal.

## Deliberately missing business rules (the ticket does not say; the code does something)

1. **Applying a second valid code while one is already applied.** The ticket thread only says "one code per order"; it does not say whether the second code is refused or replaces the first. The code replaces: with SAVE10 applied on a $129.95 cart, applying TAKE15 succeeds silently and the cart then shows TAKE15, Discount -$15.00, Total $114.95. (Verified by running, both branches.)
2. **What happens to an applied code when the cart is emptied without paying.** Not addressed. The code stays attached to the customer's (empty) cart: the empty cart page shows only "Your cart is empty." (no promo section), and when products are added again the code is applied again without re-entering it. On the fixed branch this is true for SAVE10 only; TAKE15 is removed when the quantity change that empties the cart takes the subtotal below $60.00. (This behaviour follows from the code, `cart_promos` is only deleted by Remove, by a successful payment or, on the fixed branch, by the minimum re-check; it was not exercised in the verification run.)

A tester should raise these as questions about the requirement, not as defects.

## Easy to mistake for a defect, but correct

- **TAKE15 minimum is $60.00, not $50.00.** The description still says $50.00; the last comment (authoritative) changes it to $60.00, inclusive. A cart of one Pour-Over Set ($59.50) is correctly REFUSED with "TAKE15 needs a subtotal of at least $60.00." even though it is above $50.00. A cart of exactly $60.00 (5 notebooks) is correctly ACCEPTED. Both verified on both branches.
- **Codes are trimmed and case-insensitive.** ` save10 ` and `take15` are accepted and displayed as `SAVE10` / `TAKE15`.
- **The code disappears from the cart after a successful payment** and a later attempt by the same customer says "You have already used promo code SAVE10." That is criterion 6 working. A second customer can still use SAVE10.
- **An unknown code while another is applied leaves the old code and discount in place** next to the error alert. That is criterion 3, not a failure to apply.
- **Loyalty points go down when a code is used.** The cart's "You could earn N loyalty points" and the points credited are based on the discounted total (e.g. 22 points for $22.49/$22.50, plus the 100 welcome points on a first paid order). The ticket background says points are earned on the amount actually charged, so this is intended.
- **After the minimum re-check removes TAKE15 (fixed branch), raising the quantity back to $60.00 does not bring the code back.** The ticket says the code is removed; the customer has to apply it again.
- **The Total line is shown on the cart even without a code** (equal to the subtotal), and the checkout only shows Subtotal/Discount lines when a code is applied.
- **A failed order keeps its `promoCode` and `discountCents` in `/api/account`** (status `payment_failed`). That is a record of the attempt, not a use of the code (on the fixed branch the code can still be applied afterwards).
- The error messages are carried in the URL (`/cart?promo=unknown&code=...`), so they are shown after the redirect and stay until the next navigation; reloading that URL shows the message again. That is how the existing login and checkout errors work too.

## Verification performed

Both branches: `npx tsc --noEmit` passes, `npm run build -w apps/shop` equivalent (`npm run build` in `apps/shop`) passes, server started with `TEST_MODE=1` against a fresh database and driven through the real HTML forms (server actions) plus `/api/cart` and `/api/account`.

| Check | Feature branch | Fixed branch |
|---|---|---|
| SAVE10 on $24.99 | discount 250, total 2249 (defect A) | discount 249, total 2250 |
| SAVE10 on $129.95 | discount 1300 (defect A) | discount 1299 |
| SAVE10 on $59.50 | 595 | 595 |
| TAKE15 at $59.50 | refused with minimum message | same |
| TAKE15 at $60.00 | applied, total 4500 | same |
| TAKE15 then quantity down to $48.00 | still applied, total 3300 (defect C) | removed, total 4800 |
| Unknown code with SAVE10 applied | error, SAVE10 stays | same |
| Remove | total = subtotal | same |
| Decline, remove, re-apply SAVE10 | "already used" (defect B) | applied again, paid order total 5355 |
| Reuse after paid order | "already used" | same |
| Second customer uses SAVE10 | applied | same |
| Order without a code | totalCents = subtotal, discountCents 0, promoCode null | same |
