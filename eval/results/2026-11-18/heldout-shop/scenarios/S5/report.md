# S5 Paying with SAVE10: checkout matches cart, order records discount, code cleared and then refused

**Verdict: FAILED** — A3: expected 116.96, got 116.95; A4: expected 11696, got 11695; A5: expected 1299, got 1300; A8: expected 12.99, got 13; A9: expected 116.96, got 116.95

- Steps chosen by: external model via HTTP bridge
- Environment: http://localhost:3000, commit 5ca65f012d822e0a2fe3dc56b1dd3a6a0066570b
- Started 2026-11-18T18:58:14.120Z, took 169.2 s, 49 tool calls
- Basis: requirement; requirements R11, R12, R19, R20, R21, R24, R25, R28, R29, R8

## Objective

Sign in as the customer. Add one Wool Throw Blanket ($129.95) to the cart, open the cart page and apply SAVE10. Record the cart page's Discount (cartDiscount) and Total (cartTotal) in dollars. Go to checkout and record the checkout page's discount (checkoutDiscount) and Order total (checkoutTotal) in dollars. Pay with card number 4242 4242 4242 4242. Then call GET /api/account and, for the single order, record totalCents (orderTotal) and discountCents (orderDiscount) and check promoCode. Open the account overview and record that order's discount (accountDiscount) and total charged (accountTotal) in dollars. Then add one Notebook, Dotted A5 to the cart and call GET /api/cart, recording subtotalCents (newSubtotal), discountCents (newDiscount) and totalCents (newTotal). Finally, on the cart page apply 'save10' in lower case and record the error message shown, then call GET /api/cart again and record discountCents (retryDiscount).

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | The checkout page's discount (checkoutDiscount) equals the cart page's Discount (cartDiscount) recorded just before. | `cartDiscount` | 13 | 13 | match | [check-A1.png](check-A1.png) |
| A2 | The checkout page's Order total (checkoutTotal) equals the cart page's discounted Total (cartTotal). | `cartTotal` | 116.95 | 116.95 | match | [check-A2.png](check-A2.png) |
| A3 | The checkout page's Order total (checkoutTotal) equals 116.96: $129.95 minus 10% rounded down to the cent ($12.99). | `116.96` | 116.96 | 116.95 | **MISMATCH** | [check-A3.png](check-A3.png) |
| A4 | After payment, the order's totalCents in GET /api/account (orderTotal) equals 11696, the discounted total that was charged. | `11696` | 11696 | 11695 | **MISMATCH** | [check-A4.png](check-A4.png) |
| A5 | After payment, the order's discountCents in GET /api/account (orderDiscount) equals 1299. | `1299` | 1299 | 1300 | **MISMATCH** | [check-A5.png](check-A5.png) |
| A6 | After payment, the order's promoCode in GET /api/account equals SAVE10. | `SAVE10` | SAVE10 | SAVE10 | match | [check-A6.png](check-A6.png) |
| A7 | After payment, the order's totalCents (orderTotal) equals checkoutTotal * 100 (the amount charged equals the checkout Order total). | `round(checkoutTotal * 100)` | 11695 | 11695 | match | [check-A7.png](check-A7.png) |
| A8 | On the account overview, the order's discount (accountDiscount, dollars) equals 12.99. | `12.99` | 12.99 | 13 | **MISMATCH** | [check-A8.png](check-A8.png) |
| A9 | On the account overview, the order's total charged (accountTotal, dollars) equals 116.96. | `116.96` | 116.96 | 116.95 | **MISMATCH** | [check-A9.png](check-A9.png) |
| A10 | After the successful payment and adding a Notebook, discountCents from GET /api/cart (newDiscount) is 0: the code was cleared from the cart. | `0` | 0 | 0 | match | [check-A10.png](check-A10.png) |
| A11 | After the successful payment and adding a Notebook, totalCents from GET /api/cart (newTotal) equals subtotalCents (newSubtotal). | `newSubtotal` | 1200 | 1200 | match | [check-A11.png](check-A11.png) |
| A12 | After applying 'save10' again (lower case), the error message shown on the cart page contains 'You have already used promo code'. | `You have already used promo code` | You have already used promo code | You have already used promo code SAVE10. | match | [check-A12.png](check-A12.png) |
| A13 | After the refused re-apply of save10, discountCents from GET /api/cart (retryDiscount) is 0 (the used code was not applied). | `0` | 0 | 0 | match | [check-A13.png](check-A13.png) |

## Observations

- `cartDiscount` = 13
- `cartTotal` = 116.95
- `checkoutDiscount` = 13
- `checkoutTotal` = 116.95
- `orderTotal` = 11695
- `orderDiscount` = 1300
- `accountDiscount` = 13
- `accountTotal` = 116.95
- `newSubtotal` = 1200
- `newDiscount` = 0
- `newTotal` = 1200
- `retryDiscount` = 0

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
| 11 | observe | {"name":"cartDiscount","target":{"source":"page","by":"text","value":"Discount (SAVE10):","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded cartDiscount = 13 | Record cart discount in dollars. |
| 12 | observe | {"name":"cartTotal","target":{"source":"page","by":"text","value":"Total:","count":false,"pattern":"^\\s*Total:\\s*\\$([0-9]+\\.[0-9]{2})"}} | error: Error: Expected exactly one element for {"source":"page","by":"text","value":"Total:","count":false,"pattern":"^\\s*Total:\\s*\\$([0-9]+\\.[0-9]{2})"}, found 2. | Record cart discounted total in dollars. |
| 13 | observe | {"name":"cartTotal","target":{"source":"page","by":"text","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded cartTotal = 116.95 | Record cart discounted total (the strong after Total:) in dollars. |
| 14 | click | {"element":{"by":"role","role":"link","value":"Proceed to checkout"}} | URL: /checkout | Go to checkout. |
| 15 | observe | {"name":"checkoutDiscount","target":{"source":"page","by":"text","value":"Discount (SAVE10):","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded checkoutDiscount = 13 | Record checkout discount. |
| 16 | observe | {"name":"checkoutTotal","target":{"source":"page","by":"text","value":"Order total:","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded checkoutTotal = 116.95 | Record checkout order total. |
| 17 | check | {"assertionId":"A1","target":{"source":"page","by":"text","value":"Discount (SAVE10):","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded A1: expected 13, actual 13 -> match. This result is final. | Checkout discount vs cart discount. |
| 18 | check | {"assertionId":"A2","target":{"source":"page","by":"text","value":"Order total:","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded A2: expected 116.95, actual 116.95 -> match. This result is final. | Checkout order total vs cart total. |
| 19 | check | {"assertionId":"A3","target":{"source":"page","by":"text","value":"Order total:","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded A3: expected 116.96, actual 116.95 -> MISMATCH. This result is final. | Checkout order total vs 116.96. |
| 20 | fill | {"element":{"by":"label","value":"Card number"},"text":"4242 4242 4242 4242"} | URL: /checkout | Enter accepted card. |
| 21 | click | {"element":{"by":"role","role":"button","value":"Pay now"}} | URL: /account?order=1 | Pay. |
| 22 | api_request | {"method":"GET","path":"/api/account"} | {"responseId":"R1","status":200,"body":{"customer":{"id":2,"email":"s5-shopper@fixtures.test","name":"Test Customer s5-shopper"},"balance":216,"transactions":[{"id":1,"orderId":1,"points":116,"reason":"purchase"},{"id":2,"orderId":1,"points":100,"reason":"welcome"}],"orders":[{"id":1,"totalCents":11 | Read the recorded order. |
| 23 | observe | {"name":"orderTotal","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.totalCents","count":false}} | Recorded orderTotal = 11695 | Record order field. |
| 24 | observe | {"name":"orderDiscount","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.discountCents","count":false}} | Recorded orderDiscount = 1300 | Record order field. |
| 25 | check | {"assertionId":"A4","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.totalCents","count":false}} | Recorded A4: expected 11696, actual 11695 -> MISMATCH. This result is final. | Check order field. |
| 26 | check | {"assertionId":"A5","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.discountCents","count":false}} | Recorded A5: expected 1299, actual 1300 -> MISMATCH. This result is final. | Check order field. |
| 27 | check | {"assertionId":"A6","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.promoCode","count":false}} | Recorded A6: expected SAVE10, actual SAVE10 -> match. This result is final. | Check order field. |
| 28 | check | {"assertionId":"A7","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"orders.0.totalCents","count":false}} | Recorded A7: expected 11695, actual 11695 -> match. This result is final. | Check order field. |
| 29 | navigate | {"path":"/account"} | URL: /account | Open account overview. |
| 30 | observe | {"name":"accountDiscount","target":{"source":"page","by":"role","role":"cell","value":"-$13.00 (SAVE10)","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded accountDiscount = 13 | Record order discount. |
| 31 | observe | {"name":"accountTotal","target":{"source":"page","by":"role","role":"cell","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded accountTotal = 116.95 | Record order total. |
| 32 | check | {"assertionId":"A8","target":{"source":"page","by":"role","role":"cell","value":"-$13.00 (SAVE10)","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded A8: expected 12.99, actual 13 -> MISMATCH. This result is final. | Account order discount. |
| 33 | check | {"assertionId":"A9","target":{"source":"page","by":"role","role":"cell","value":"$116.95","count":false,"pattern":"\\$([0-9]+\\.[0-9]{2})"}} | Recorded A9: expected 116.96, actual 116.95 -> MISMATCH. This result is final. | Account order total. |
| 34 | navigate | {"path":"/"} | URL: / | Go to products. |
| 35 | click | {"element":{"by":"role","role":"button","value":"Add Notebook, Dotted A5 to cart"}} | URL: /cart | Add one Notebook. |
| 36 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R2","status":200,"body":{"lines":[{"productId":3,"name":"Notebook, Dotted A5","priceCents":1200,"quantity":1,"lineCents":1200}],"subtotalCents":1200,"promoCode":null,"discountCents":0,"totalCents":1200}} | Read cart after new item. |
| 37 | observe | {"name":"newSubtotal","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"subtotalCents","count":false}} | Recorded newSubtotal = 1200 | Record cart field. |
| 38 | observe | {"name":"newDiscount","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded newDiscount = 0 | Record cart field. |
| 39 | observe | {"name":"newTotal","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"totalCents","count":false}} | Recorded newTotal = 1200 | Record cart field. |
| 40 | check | {"assertionId":"A10","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded A10: expected 0, actual 0 -> match. This result is final. | Check cart field. |
| 41 | check | {"assertionId":"A11","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"totalCents","count":false}} | Recorded A11: expected 1200, actual 1200 -> match. This result is final. | Check cart field. |
| 42 | navigate | {"path":"/cart"} | URL: /cart | Open cart page. |
| 43 | fill | {"element":{"by":"label","value":"Promo code"},"text":"save10"} | URL: /cart | Enter lower-case code. |
| 44 | click | {"element":{"by":"role","role":"button","value":"Apply"}} | URL: /cart?promo=used&code=SAVE10 | Try to re-apply the used code. |
| 45 | check | {"assertionId":"A12","target":{"source":"page","by":"text","value":"You have already used promo code","count":false}} | Recorded A12: expected You have already used promo code, actual You have already used promo code SAVE10. -> match. This result is final. | Check error message on cart page. |
| 46 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R3","status":200,"body":{"lines":[{"productId":3,"name":"Notebook, Dotted A5","priceCents":1200,"quantity":1,"lineCents":1200}],"subtotalCents":1200,"promoCode":null,"discountCents":0,"totalCents":1200}} | Read cart after refused code. |
| 47 | observe | {"name":"retryDiscount","target":{"source":"api","responseId":"R3","field":"body","jsonPath":"discountCents","count":false}} | Recorded retryDiscount = 0 | Record discount after refused code. |
| 48 | check | {"assertionId":"A13","target":{"source":"api","responseId":"R3","field":"body","jsonPath":"discountCents","count":false}} | Recorded A13: expected 0, actual 0 -> match. This result is final. | Check discount stays 0. |
| 49 | finish | {"outcome":"completed","reason":"All 13 assertions checked. App computes the SAVE10 discount on $129.95 as $13.00 (rounded, not floored), total $116.95, consistently on cart, checkout, order record and account page."} | Scenario ended. | Every assertion has been checked. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
- A1: ![A1](check-A1.png)
- A2: ![A2](check-A2.png)
- A3: ![A3](check-A3.png)
- A4: ![A4](check-A4.png)
- A5: ![A5](check-A5.png)
- A6: ![A6](check-A6.png)
- A7: ![A7](check-A7.png)
- A8: ![A8](check-A8.png)
- A9: ![A9](check-A9.png)
- A10: ![A10](check-A10.png)
- A11: ![A11](check-A11.png)
- A12: ![A12](check-A12.png)
- A13: ![A13](check-A13.png)
