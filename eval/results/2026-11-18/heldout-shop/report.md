# QA report: NWG-342 — pull request #1

**NWG-342 Promo codes in the cart** · ihsansengun/ReleaseProof @ `5ca65f012d`

## Summary

- Scenarios executed: 9 — 5 passed, 4 failed, 0 blocked during execution, 0 unverified
- Scenarios planned but not run: 8 (waiting on a decision or a missing capability)
- Documented requirements compared against the application: 29 of 29
- Clarification requests: 8
- Environment: http://localhost:3000, commit `5ca65f012d822e0a2fe3dc56b1dd3a6a0066570b`
- Model work done by: external model via HTTP bridge

## Failures

### S1 SAVE10 on a $24.99 cart: field, Apply, rounding down, cart display and GET /api/cart

- **After applying SAVE10, the Discount line on the cart page (uiDiscount, dollars) equals 2.49.**: expected 2.49, actual 2.5
  - Requirement R3: "A percentage discount is rounded down to the whole cent."
  - Evidence: [screenshot](scenarios/S1/check-A6.png), [steps](scenarios/S1/report.md)
- **After applying SAVE10, discountCents from GET /api/cart (apiDiscount) equals 249: 10% of 2499 cents rounded down to the whole cent (the ticket's own example: 10% of $24.99 = $2.49).**: expected 249, actual 250
  - Requirement R3: "A percentage discount is rounded down to the whole cent."
  - Evidence: [screenshot](scenarios/S1/check-A4.png), [steps](scenarios/S1/report.md)
- **After applying SAVE10, apiDiscount equals 10% of apiSubtotal rounded down: floor(apiSubtotal / 10).**: expected 249, actual 250
  - Requirement R2: "SAVE10 takes 10% off the cart subtotal"
  - Evidence: [screenshot](scenarios/S1/check-A5.png), [steps](scenarios/S1/report.md)
- Replayed without a model: reproduced

### S3 TAKE15 at exactly $60.00 applies; dropping the quantity below the minimum removes it

- **After changing the quantity to 4 (subtotal $48.00), discountCents from GET /api/cart (afterDiscount) is 0.**: expected 0, actual 1500
  - Requirement R16: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart and the Total equals the subtotal again."
  - Evidence: [screenshot](scenarios/S3/check-A3.png), [steps](scenarios/S3/report.md)
- **After changing the quantity to 4, totalCents from GET /api/cart (afterTotal) equals subtotalCents (afterSubtotal).**: expected 4800, actual 3300
  - Requirement R16: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart and the Total equals the subtotal again."
  - Evidence: [screenshot](scenarios/S3/check-A4.png), [steps](scenarios/S3/report.md)
- **After changing the quantity to 4, the Total shown on the cart page (uiTotal, dollars) equals the displayed Subtotal (uiSubtotal).**: expected 48, actual 33
  - Requirement R16: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart and the Total equals the subtotal again."
  - Evidence: [screenshot](scenarios/S3/check-A5.png), [steps](scenarios/S3/report.md)
- Replayed without a model: reproduced

### S5 Paying with SAVE10: checkout matches cart, order records discount, code cleared and then refused

- **The checkout page's Order total (checkoutTotal) equals 116.96: $129.95 minus 10% rounded down to the cent ($12.99).**: expected 116.96, actual 116.95
  - Requirement R12: "its Order total is the discounted total."
  - Evidence: [screenshot](scenarios/S5/check-A3.png), [steps](scenarios/S5/report.md)
- **After payment, the order's totalCents in GET /api/account (orderTotal) equals 11696, the discounted total that was charged.**: expected 11696, actual 11695
  - Requirement R19: "The order is charged the discounted total."
  - Evidence: [screenshot](scenarios/S5/check-A4.png), [steps](scenarios/S5/report.md)
- **After payment, the order's discountCents in GET /api/account (orderDiscount) equals 1299.**: expected 1299, actual 1300
  - Requirement R25: "GET /api/account returns discountCents and promoCode for each order (0 and null when no code was used)"
  - Evidence: [screenshot](scenarios/S5/check-A5.png), [steps](scenarios/S5/report.md)
- **On the account overview, the order's discount (accountDiscount, dollars) equals 12.99.**: expected 12.99, actual 13
  - Requirement R24: "The account overview lists each order's discount and the total charged."
  - Evidence: [screenshot](scenarios/S5/check-A8.png), [steps](scenarios/S5/report.md)
- **On the account overview, the order's total charged (accountTotal, dollars) equals 116.96.**: expected 116.96, actual 116.95
  - Requirement R24: "The account overview lists each order's discount and the total charged."
  - Evidence: [screenshot](scenarios/S5/check-A9.png), [steps](scenarios/S5/report.md)
- Replayed without a model: reproduced

### S7 A declined payment does not use up the code: it stays, can be removed and re-applied

- **After re-applying SAVE10 following the decline, no 'You have already used promo code' error is shown on the cart page.**: expected absent, actual present
  - Requirement R23: "A declined payment does not use up the code: it stays on the cart and can still be removed and applied again."
  - Evidence: [screenshot](scenarios/S7/check-A4.png), [steps](scenarios/S7/report.md)
- **After re-applying SAVE10 following the decline, discountCents from GET /api/cart (discReapplied) equals discBefore.**: expected 1300, actual 0
  - Requirement R23: "A declined payment does not use up the code: it stays on the cart and can still be removed and applied again."
  - Evidence: [screenshot](scenarios/S7/check-A5.png), [steps](scenarios/S7/report.md)
- **The paid order's discountCents in GET /api/account (paidDiscount) equals discBefore.**: expected 1300, actual 0
  - Requirement R25: "GET /api/account returns discountCents and promoCode for each order (0 and null when no code was used)"
  - Evidence: [screenshot](scenarios/S7/check-A7.png), [steps](scenarios/S7/report.md)
- Replayed without a model: reproduced

## Requirement coverage

| Id | Requirement | Source quote | Compared by |
|---|---|---|---|
| R1 | The cart page has a "Promo code" input field and an "Apply" button. | "The cart page has a "Promo code" field and an "Apply" button." | S1/A1 match<br>S1/A2 match |
| R2 | Applying SAVE10 gives a discount of 10% of the cart subtotal. | "SAVE10 takes 10% off the cart subtotal" | S1/A5 MISMATCH |
| R3 | A percentage discount (SAVE10) is rounded down to the whole cent (e.g. 10% of $24.99 = $2.49, not $2.50). | "A percentage discount is rounded down to the whole cent." | S1/A4 MISMATCH<br>S1/A6 MISMATCH |
| R4 | Applying TAKE15 to a qualifying cart gives a fixed discount of $15.00. | "TAKE15 takes $15.00 off" | S2/A4 match<br>S2/A5 match |
| R5 | TAKE15 requires a minimum subtotal of $60.00 (overriding the $50.00 in the description). | "the minimum for TAKE15 is $60.00, not $50.00." | S2/A3 match |
| R6 | A subtotal of exactly $60.00 qualifies for TAKE15. | "A subtotal of exactly $60.00 qualifies." | S3/A1 match |
| R7 | The TAKE15 minimum is checked against the subtotal before any discount. | "The minimum is checked against the subtotal before any discount." | S3/A2 match |
| R8 | Promo codes are accepted regardless of letter case (e.g. save10, Take15). | "Codes are not case-sensitive" | S4/A1 match |
| R9 | Leading and trailing spaces around an entered code are ignored. | "spaces around the code are ignored" | S4/A2 match |
| R10 | While a code is applied, the cart shows the applied code, a Discount line, and a Total equal to subtotal minus discount. | "While a code is applied, the cart shows the code, a Discount line and a Total that equals subtotal minus discount." | S1/A3 match<br>S1/A7 match<br>S2/A6 match<br>S2/A7 match |
| R11 | The checkout page shows the same discount as the cart. | "The checkout page shows the same discount" | S5/A1 match |
| R12 | The checkout page's Order total is the discounted total. | "its Order total is the discounted total." | S5/A2 match<br>S5/A3 MISMATCH |
| R13 | Entering an unknown code shows the error "That promo code is not valid." | "An unknown code shows the error "That promo code is not valid."" | S4/A3 match |
| R14 | An unknown code changes nothing: a code that was already applied stays applied, with the same discount and total. | "changes nothing: a code that was already applied stays applied." | S4/A4 match<br>S4/A5 match<br>S4/A6 match |
| R15 | Applying TAKE15 to a cart below the minimum subtotal shows an error that names the minimum ($60.00), and the code is not applied. | "Applying TAKE15 to a cart below its minimum subtotal shows an error that names the minimum, and the code is not applied." | S2/A1 match<br>S2/A2 match |
| R16 | If a later quantity change takes the subtotal below the TAKE15 minimum, the code is removed from the cart and the Total equals the subtotal again. | "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart and the Total equals the subtotal again." | S3/A3 MISMATCH<br>S3/A4 MISMATCH<br>S3/A5 MISMATCH |
| R17 | A "Remove" button next to the applied code removes it, after which the Total equals the subtotal. | "A "Remove" button next to the applied code removes it; the Total then equals the subtotal." | S4/A7 match<br>S4/A8 match<br>S4/A9 match |
| R18 | Only one promo code applies per order; the two codes do not stack. | "One code per order." | S9/A1 match<br>S9/A2 match |
| R19 | The order is charged the discounted total. | "The order is charged the discounted total." | S5/A4 MISMATCH<br>S6/A6 match<br>S7/A6 match |
| R20 | After a successful payment, the promo code is cleared from the cart. | "After a successful payment the code is cleared from the cart" | S5/A10 match<br>S5/A11 match |
| R21 | After a successful payment with a code, that customer cannot apply the same code again and sees the error "You have already used promo code <CODE>." | "that customer cannot apply the same code again (error: "You have already used promo code <CODE>.")" | S5/A12 match<br>S6/A1 match |
| R22 | One customer using a code does not prevent other customers from applying and using the same code. | "Other customers are not affected." | S6/A3 match<br>S6/A4 match<br>S6/A5 match |
| R23 | A declined payment does not use up the code: the code stays on the cart, can be removed and can be applied again. | "A declined payment does not use up the code: it stays on the cart and can still be removed and applied again." | S7/A1 match<br>S7/A2 match<br>S7/A3 match<br>S7/A4 MISMATCH<br>S7/A5 MISMATCH |
| R24 | The account overview lists each order's discount and the total charged. | "The account overview lists each order's discount and the total charged." | S5/A8 MISMATCH<br>S5/A9 MISMATCH |
| R25 | GET /api/account returns discountCents and promoCode for each order, with 0 and null when no code was used. | "GET /api/account returns discountCents and promoCode for each order (0 and null when no code was used)" | S5/A5 MISMATCH<br>S5/A6 match<br>S7/A7 MISMATCH<br>S8/A4 match |
| R26 | GET /api/cart returns subtotalCents, promoCode, discountCents and totalCents for the current cart. | "GET /api/cart returns subtotalCents, promoCode, discountCents and totalCents for the current cart." | S1/A8 match<br>S1/A9 match<br>S9/A3 match |
| R27 | Loyalty points are earned on the amount actually charged (the discounted total), not on the pre-discount subtotal. | "points are still earned on the amount the customer is actually charged." | S8/A3 match |
| R28 | Each order's totalCents in GET /api/account is the amount charged (discounted total). | "Each order carries `totalCents` (the amount charged)" | S5/A7 match<br>S8/A1 match<br>S8/A2 match |
| R29 | Each customer can use a given code on one paid order only. | "each customer can use a code on one paid order only." | S5/A13 match<br>S6/A2 match |

Inferred, not stated in any source (never used as an expected value):

- R30: The "You could earn N loyalty points" estimate on the cart reflects the discounted total while a code is applied.
- R31: Applying a valid code when another code is already applied replaces the existing code (the cart holds at most one code).
- R32: The discount never exceeds the subtotal; the total is never negative.
- R33: GET /api/cart returns 401 for a request that is not signed in.
- R34: Orders placed without a code show no discount on the account overview ("None") and their totals are unchanged.
- R35: A customer's applied code is per customer and is not visible on or applied to any other customer's cart.

## Clarification requests

- **Q1** When a different valid code is applied while one is already on the cart, should it replace the existing code or be refused with an error?
  - Comment 2 says one code per order but not what happens on a second Apply; the expected cart state after applying TAKE15 over SAVE10 (and vice versa) cannot be asserted.
- **Q2** If a code is already applied and the customer tries a code that fails for the minimum or already-used reason, should the existing code stay applied?
  - The ticket only states that an unknown code leaves an applied code in place; for the minimum and used errors the effect on an existing code is unspecified, so the cart state after such a failure cannot be checked.
- **Q3** What is the exact wording of the TAKE15 minimum-subtotal error message?
  - The ticket only says the error 'names the minimum'; a tester can check that $60.00 appears but not the exact text.
- **Q4** If the subtotal drops below $60.00 and then rises back above it, should TAKE15 come back automatically or must the customer re-apply it? And does the auto-removal show any message?
  - The ticket says the code is removed but not whether removal is permanent or signalled to the customer, so the post-change UI cannot be fully specified.
- **Q5** Does the 'already used' rule count only paid orders, or also orders that are pending or later reach paid through the payment webhook after an initial decline?
  - The ticket says a declined payment does not use up the code and README says 'one paid order only', but the lifecycle of a payment_failed order that later succeeds via POST /api/webhooks/payment is not addressed.
- **Q6** What should happen to an applied code when the cart is emptied (all quantities set to 0), and can a code be applied to an empty cart?
  - The empty cart page shows no promo section; whether the code should persist invisibly and reappear when items are added is undefined, so the expected state after re-adding items cannot be asserted.
- **Q7** Should the 'already used' check also be enforced at payment time (e.g. if the code was applied before it became used in another session), or only when applying?
  - The ticket only defines the error on apply; whether checkout must reject or strip a no-longer-eligible code is undefined.
- **Q8** Does the 'spaces are ignored' rule cover only leading/trailing spaces, or also spaces inside the code (e.g. 'SAVE 10')?
  - 'Spaces around the code' suggests surrounding whitespace only, but whether internal spaces should be rejected as unknown is not stated.

## Scenarios

| Id | Basis | Title | Result | Detail |
|---|---|---|---|---|
| [S1](scenarios/S1/report.md) | requirement | SAVE10 on a $24.99 cart: field, Apply, rounding down, cart display and GET /api/cart | failed | A6: expected 2.49, got 2.5; A4: expected 249, got 250; A5: expected 249, got 250 |
| [S2](scenarios/S2/report.md) | requirement | TAKE15 refused at $59.50 with an error naming $60.00, then accepted at $71.50 | passed | All 7 assertions matched. |
| [S3](scenarios/S3/report.md) | risk | TAKE15 at exactly $60.00 applies; dropping the quantity below the minimum removes it | failed | A3: expected 0, got 1500; A4: expected 4800, got 3300; A5: expected 48, got 33 |
| [S4](scenarios/S4/report.md) | requirement | Lower-case code with surrounding spaces applies; unknown code errors and keeps it; Remove clears it | passed | All 9 assertions matched. |
| [S5](scenarios/S5/report.md) | requirement | Paying with SAVE10: checkout matches cart, order records discount, code cleared and then refused | failed | A3: expected 116.96, got 116.95; A4: expected 11696, got 11695; A5: expected 1299, got 1300; A8: expected 12.99, got 13; A9: expected 116.96, got 116.95 |
| [S6](scenarios/S6/report.md) | requirement | A code used by one customer is refused for them but still works for another customer | passed | All 6 assertions matched. |
| [S7](scenarios/S7/report.md) | risk | A declined payment does not use up the code: it stays, can be removed and re-applied | failed | A4: expected absent, got present; A5: expected 1300, got 0; A7: expected 1300, got 0 |
| [S8](scenarios/S8/report.md) | risk | Loyalty points follow the charged amount: $108.00 after SAVE10 earns the same as $108.00 without a code | passed | All 4 assertions matched. |
| [S9](scenarios/S9/report.md) | requirement | SAVE10 and TAKE15 do not stack | passed | All 3 assertions matched. |
| S10 | requirement | Applying a second valid code over an applied one: replace or refuse? | not run | The ticket says one code per order but not whether a second valid code replaces the applied one or is refused with an error; replacement (R31) is only inferred from the diff. Product must decide the expected cart state and message. |
| S11 | requirement | Applied code after a failed minimum or already-used attempt | not run | The ticket only states that an unknown code leaves an applied code in place; for the minimum and already-used errors it is not said whether the existing code stays applied. |
| S12 | requirement | TAKE15 after the subtotal drops below and rises back above $60.00 | not run | It is not specified whether removal is permanent (customer must re-apply) or whether the code returns automatically, nor whether removal is signalled to the customer. |
| S13 | risk | Declined order later paid via the payment webhook: is the code used up and cleared? | not run | The ticket does not cover a payment_failed order that later becomes paid through the webhook: whether that counts as using the code and whether the code must then be cleared from the cart needs a decision. |
| S14 | risk | Code applied in one session, used in another before paying here | not run | The ticket defines the already-used error only when applying; whether payment must reject or strip a code that became used in the meantime is undefined. |
| S15 | risk | Applied code when the cart is emptied and refilled | not run | It is not defined what happens to an applied code when the cart is emptied, or whether a code can be applied to an empty cart. |
| S16 | risk | Code with internal spaces (e.g. 'SAVE 10') | not run | The ticket says spaces around the code are ignored; whether spaces inside the code are also ignored or make it unknown is not stated. |
| S17 | requirement | Cart loyalty-points estimate while a code is applied | not run | That the cart's points estimate must follow the discounted total (R30) is only inferred from the pull request; the ticket only states that earned points follow the amount charged. Product must confirm the estimate's expected behaviour. |

## Risks identified

- **K1** Percentage discount may be rounded to nearest instead of rounded down, overstating the discount by a cent on some subtotals. — probed by S1, S5
- **K2** TAKE15 may stay applied (and keep discounting $15.00) after a quantity change drops the subtotal below $60.00. — probed by S3, S12
- **K3** A declined payment may use up the code, so the customer gets 'You have already used promo code ...' when re-applying it after a decline. — probed by S7, S13
- **K4** Boundary at exactly $60.00 and the $50.00 vs $60.00 conflict between description and comment. — probed by S2, S3
- **K5** Loyalty points might be earned on the pre-discount subtotal rather than the charged amount. — probed by S8, S17
- **K6** Charged amount, checkout total, cart total and API totals could diverge, since each is computed from cart state at different times. — probed by S5, S14
- **K7** Applying a second valid code silently replaces the first, which may or may not be intended. — probed by S9, S10
- **K8** Failed apply attempts (used, minimum) leave a previously applied code in place, and error rendering depends on URL query parameters that can be crafted. — probed by S4, S11
- **K9** Used-code tracking could leak across customers or fail to be case-normalised. — probed by S5, S6
- **K10** Orders from before the migration, or without a code, may return wrong discountCents/promoCode values. — probed by S8
- **K11** Code cleared from the cart only on the synchronous checkout success path, not when a payment succeeds via the webhook. — probed by S13
- **K12** Discount capped at subtotal hides or masks edge cases; empty cart with an applied code may leave a stale code. — probed by S15
- **K13** Whitespace handling may be wider or narrower than intended. — probed by S4, S16

## Inputs and timing

- Documentation read: README.md
- Changed files: apps/shop/README.md, apps/shop/app/account/page.tsx, apps/shop/app/actions.ts, apps/shop/app/api/cart/route.ts, apps/shop/app/cart/page.tsx, apps/shop/app/checkout/page.tsx, apps/shop/lib/db.ts, apps/shop/lib/shop.ts
- Stages: ingest 0s, discover 51.9s, analyse 84.3s, plan 180.9s, execute 242.7s, confirm 35s
- Tool calls in execution: 349
