# S5 Paying with SAVE10: checkout matches cart, order records discount, code cleared and then refused

**Verdict: UNVERIFIED** — Not checked: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13. Replay diverged at observe {"name":"cartTotal","target":{"source":"page","by":"text","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"},"rationale":"Record cart discounted total (the strong after Total:) in dollars."}: Error: Expected exactly one element for {"source":"page","by":"text","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}, found 0.

- Steps chosen by: recording (no model)
- Environment: http://localhost:3000, commit 608909953f5ee06a34141dcbeea03fffc4bae337
- Started 2026-11-18T19:04:08.573Z, took 8.3 s, 12 tool calls
- Basis: requirement; requirements R11, R12, R19, R20, R21, R24, R25, R28, R29, R8

## Objective

Sign in as the customer. Add one Wool Throw Blanket ($129.95) to the cart, open the cart page and apply SAVE10. Record the cart page's Discount (cartDiscount) and Total (cartTotal) in dollars. Go to checkout and record the checkout page's discount (checkoutDiscount) and Order total (checkoutTotal) in dollars. Pay with card number 4242 4242 4242 4242. Then call GET /api/account and, for the single order, record totalCents (orderTotal) and discountCents (orderDiscount) and check promoCode. Open the account overview and record that order's discount (accountDiscount) and total charged (accountTotal) in dollars. Then add one Notebook, Dotted A5 to the cart and call GET /api/cart, recording subtotalCents (newSubtotal), discountCents (newDiscount) and totalCents (newTotal). Finally, on the cart page apply 'save10' in lower case and record the error message shown, then call GET /api/cart again and record discountCents (retryDiscount).

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | The checkout page's discount (checkoutDiscount) equals the cart page's Discount (cartDiscount) recorded just before. | `cartDiscount` |  |  | not checked |  |
| A2 | The checkout page's Order total (checkoutTotal) equals the cart page's discounted Total (cartTotal). | `cartTotal` |  |  | not checked |  |
| A3 | The checkout page's Order total (checkoutTotal) equals 116.96: $129.95 minus 10% rounded down to the cent ($12.99). | `116.96` |  |  | not checked |  |
| A4 | After payment, the order's totalCents in GET /api/account (orderTotal) equals 11696, the discounted total that was charged. | `11696` |  |  | not checked |  |
| A5 | After payment, the order's discountCents in GET /api/account (orderDiscount) equals 1299. | `1299` |  |  | not checked |  |
| A6 | After payment, the order's promoCode in GET /api/account equals SAVE10. | `SAVE10` |  |  | not checked |  |
| A7 | After payment, the order's totalCents (orderTotal) equals checkoutTotal * 100 (the amount charged equals the checkout Order total). | `round(checkoutTotal * 100)` |  |  | not checked |  |
| A8 | On the account overview, the order's discount (accountDiscount, dollars) equals 12.99. | `12.99` |  |  | not checked |  |
| A9 | On the account overview, the order's total charged (accountTotal, dollars) equals 116.96. | `116.96` |  |  | not checked |  |
| A10 | After the successful payment and adding a Notebook, discountCents from GET /api/cart (newDiscount) is 0: the code was cleared from the cart. | `0` |  |  | not checked |  |
| A11 | After the successful payment and adding a Notebook, totalCents from GET /api/cart (newTotal) equals subtotalCents (newSubtotal). | `newSubtotal` |  |  | not checked |  |
| A12 | After applying 'save10' again (lower case), the error message shown on the cart page contains 'You have already used promo code'. | `You have already used promo code` |  |  | not checked |  |
| A13 | After the refused re-apply of save10, discountCents from GET /api/cart (retryDiscount) is 0 (the used code was not applied). | `0` |  |  | not checked |  |

## Observations

- `cartDiscount` = 12.99

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | Find the sign-in entry point. |
| 2 | navigate | {"path":"/login"} | URL: /login | Sign in as the customer. |
| 3 | fill | {"element":{"by":"label","value":"Email"},"text":"s5-shopper@fixtures.test"} | URL: /login | Enter customer email. |
| 4 | fill | {"element":{"by":"label","value":"Password"},"text":"{{secret:shopper.password}}"} | URL: /login | Enter customer password. |
| 5 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: /account | Submit sign-in. |
| 6 | navigate | {"path":"/"} | URL: / | Go to products. |
| 7 | click | {"element":{"by":"role","role":"button","value":"Add Wool Throw Blanket to cart"}} | URL: /cart | Add one Wool Throw Blanket. |
| 8 | navigate | {"path":"/cart"} | URL: /cart | Open cart page to apply code. |
| 9 | fill | {"element":{"by":"label","value":"Promo code"},"text":"SAVE10"} | URL: /cart | Enter promo code. |
| 10 | click | {"element":{"by":"role","role":"button","value":"Apply"}} | URL: /cart | Apply SAVE10. |
| 11 | observe | {"name":"cartDiscount","target":{"source":"page","by":"text","value":"Discount (SAVE10):","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded cartDiscount = 12.99 | Record cart discount in dollars. |
| 12 | observe | {"name":"cartTotal","target":{"source":"page","by":"text","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | error: Error: Expected exactly one element for {"source":"page","by":"text","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}, found 0. | Record cart discounted total (the strong after Total:) in dollars. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
