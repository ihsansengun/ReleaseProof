# S7 A declined payment does not use up the code: it stays, can be removed and re-applied

**Verdict: FAILED** — A4: expected absent, got present; A5: expected 1300, got 0; A7: expected 1300, got 0

- Steps chosen by: external model via HTTP bridge
- Environment: http://localhost:3000, commit 5ca65f012d822e0a2fe3dc56b1dd3a6a0066570b
- Started 2026-11-18T19:00:26.948Z, took 109.9 s, 44 tool calls
- Basis: risk; requirements R23, R19

## Objective

Sign in as the customer. Add one Wool Throw Blanket ($129.95) to the cart and apply SAVE10. Call GET /api/cart and record discountCents (discBefore). Go to checkout and pay with card number 4000 0000 0000 0002 (declined). Return to the cart page, check that the applied code is still shown, and call GET /api/cart recording discountCents (discAfterDecline). Press Remove next to the code and call GET /api/cart recording discountCents (discRemoved). Apply SAVE10 again, look for any error message, and call GET /api/cart recording discountCents (discReapplied) and totalCents (totReapplied) and subtotalCents (subReapplied). Finally pay at checkout with card 4242 4242 4242 4242, call GET /api/account and record the paid order's totalCents (paidTotal) and discountCents (paidDiscount); if there is also a failed order, use the order whose status is paid.

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | After the declined payment, discountCents from GET /api/cart (discAfterDecline) equals discBefore: the code stays on the cart. | `discBefore` | 1300 | 1300 | match | [check-A1.png](check-A1.png) |
| A2 | After the declined payment, the cart page's applied-code display contains SAVE10. | `SAVE10` | SAVE10 | Promo code SAVE10 applied. | match | [check-A2.png](check-A2.png) |
| A3 | After pressing Remove following the decline, discountCents from GET /api/cart (discRemoved) is 0. | `0` | 0 | 0 | match | [check-A3.png](check-A3.png) |
| A4 | After re-applying SAVE10 following the decline, no 'You have already used promo code' error is shown on the cart page. | `absent` | absent | present | **MISMATCH** | [check-A4.png](check-A4.png) |
| A5 | After re-applying SAVE10 following the decline, discountCents from GET /api/cart (discReapplied) equals discBefore. | `discBefore` | 1300 | 0 | **MISMATCH** | [check-A5.png](check-A5.png) |
| A6 | The paid order's totalCents in GET /api/account (paidTotal) equals subReapplied minus discReapplied (the discounted total is charged). | `subReapplied - discReapplied` | 12995 | 12995 | match | [check-A6.png](check-A6.png) |
| A7 | The paid order's discountCents in GET /api/account (paidDiscount) equals discBefore. | `discBefore` | 1300 | 0 | **MISMATCH** | [check-A7.png](check-A7.png) |

## Observations

- `discBefore` = 1300
- `discAfterDecline` = 1300
- `discRemoved` = 0
- `discReapplied` = 0
- `totReapplied` = 12995
- `subReapplied` = 12995
- `paidTotal` = 12995
- `paidDiscount` = 0

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | Discover the app and find sign-in. |
| 2 | navigate | {"path":"/login"} | URL: /login | Sign in as the customer. |
| 3 | fill | {"element":{"by":"label","value":"Email"},"text":"s7-shopper@fixtures.test"} | URL: /login | Enter the shopper email. |
| 4 | fill | {"element":{"by":"label","value":"Password"},"text":"{{secret:shopper.password}}"} | URL: /login | Enter the shopper password. |
| 5 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: /account | Submit the sign-in form. |
| 6 | navigate | {"path":"/cart"} | URL: /cart | Confirm the cart starts empty. |
| 7 | navigate | {"path":"/"} | URL: / | Go to products to add the blanket. |
| 8 | click | {"element":{"by":"role","role":"button","value":"Add Wool Throw Blanket to cart"}} | URL: /cart | Add one Wool Throw Blanket. |
| 9 | navigate | {"path":"/cart"} | URL: /cart | Open the cart to apply the code. |
| 10 | fill | {"element":{"by":"label","value":"Promo code"},"text":"SAVE10"} | URL: /cart | Enter the promo code. |
| 11 | click | {"element":{"by":"role","role":"button","value":"Apply"}} | URL: /cart | Apply SAVE10. |
| 12 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R1","status":200,"body":{"lines":[{"productId":4,"name":"Wool Throw Blanket","priceCents":12995,"quantity":1,"lineCents":12995}],"subtotalCents":12995,"promoCode":"SAVE10","discountCents":1300,"totalCents":11695}} | Read discountCents before checkout. |
| 13 | observe | {"name":"discBefore","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"discountCents","count":false}} | Recorded discBefore = 1300 | Record discount after applying SAVE10. |
| 14 | navigate | {"path":"/checkout"} | URL: /checkout | Go to checkout to pay with the declined card. |
| 15 | fill | {"element":{"by":"label","value":"Card number"},"text":"4000 0000 0000 0002"} | URL: /checkout | Enter the declining card. |
| 16 | click | {"element":{"by":"role","role":"button","value":"Pay now"}} | URL: /checkout?error=declined | Attempt payment that should be declined. |
| 17 | navigate | {"path":"/cart"} | URL: /cart | Return to cart after the decline. |
| 18 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R2","status":200,"body":{"lines":[{"productId":4,"name":"Wool Throw Blanket","priceCents":12995,"quantity":1,"lineCents":12995}],"subtotalCents":12995,"promoCode":"SAVE10","discountCents":1300,"totalCents":11695}} | Read discountCents after the decline. |
| 19 | observe | {"name":"discAfterDecline","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded discAfterDecline = 1300 | Record discount after the decline. |
| 20 | check | {"assertionId":"A1","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded A1: expected 1300, actual 1300 -> match. This result is final. | Discount after decline should equal discBefore. |
| 21 | check | {"assertionId":"A2","target":{"source":"page","by":"text","value":"SAVE10","count":false}} | error: Error: Expected exactly one element for {"source":"page","by":"text","value":"SAVE10","count":false}, found 2. | Applied-code display on cart after decline should contain SAVE10. |
| 22 | check | {"assertionId":"A2","target":{"source":"page","by":"role","role":"strong","value":"SAVE10","count":false}} | error: Error: Expected exactly one element for {"source":"page","by":"role","role":"strong","value":"SAVE10","count":false}, found 0. | The strong element in the applied-code line shows the code. |
| 23 | check | {"assertionId":"A2","target":{"source":"page","by":"text","value":"applied.","count":false}} | Recorded A2: expected SAVE10, actual Promo code SAVE10 applied. -> match. This result is final. | Select the applied-code line, which reads SAVE10 applied. |
| 24 | click | {"element":{"by":"role","role":"button","value":"Remove promo code SAVE10"}} | URL: /cart | Remove the code after the decline. |
| 25 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R3","status":200,"body":{"lines":[{"productId":4,"name":"Wool Throw Blanket","priceCents":12995,"quantity":1,"lineCents":12995}],"subtotalCents":12995,"promoCode":null,"discountCents":0,"totalCents":12995}} | Read discountCents after removing the code. |
| 26 | observe | {"name":"discRemoved","target":{"source":"api","responseId":"R3","field":"body","jsonPath":"discountCents","count":false}} | Recorded discRemoved = 0 | Record discount after removal. |
| 27 | check | {"assertionId":"A3","target":{"source":"api","responseId":"R3","field":"body","jsonPath":"discountCents","count":false}} | Recorded A3: expected 0, actual 0 -> match. This result is final. | Discount after removal should be 0. |
| 28 | fill | {"element":{"by":"label","value":"Promo code"},"text":"SAVE10"} | URL: /cart | Re-enter SAVE10. |
| 29 | click | {"element":{"by":"role","role":"button","value":"Apply"}} | URL: /cart?promo=used&code=SAVE10 | Re-apply SAVE10 after the decline. |
| 30 | check | {"assertionId":"A4","target":{"source":"page","by":"text","value":"You have already used promo code","count":false}} | Recorded A4: expected absent, actual present -> MISMATCH. This result is final. | The already-used error should be absent after re-applying. |
| 31 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R4","status":200,"body":{"lines":[{"productId":4,"name":"Wool Throw Blanket","priceCents":12995,"quantity":1,"lineCents":12995}],"subtotalCents":12995,"promoCode":null,"discountCents":0,"totalCents":12995}} | Read cart totals after re-applying SAVE10. |
| 32 | observe | {"name":"discReapplied","target":{"source":"api","responseId":"R4","field":"body","jsonPath":"discountCents","count":false}} | Recorded discReapplied = 0 | Record cart value after re-applying. |
| 33 | observe | {"name":"totReapplied","target":{"source":"api","responseId":"R4","field":"body","jsonPath":"totalCents","count":false}} | Recorded totReapplied = 12995 | Record cart value after re-applying. |
| 34 | observe | {"name":"subReapplied","target":{"source":"api","responseId":"R4","field":"body","jsonPath":"subtotalCents","count":false}} | Recorded subReapplied = 12995 | Record cart value after re-applying. |
| 35 | check | {"assertionId":"A5","target":{"source":"api","responseId":"R4","field":"body","jsonPath":"discountCents","count":false}} | Recorded A5: expected 1300, actual 0 -> MISMATCH. This result is final. | Discount after re-applying should equal discBefore. |
| 36 | navigate | {"path":"/checkout"} | URL: /checkout | Go to checkout to pay with the accepted card. |
| 37 | fill | {"element":{"by":"label","value":"Card number"},"text":"4242 4242 4242 4242"} | URL: /checkout | Enter the accepted card. |
| 38 | click | {"element":{"by":"role","role":"button","value":"Pay now"}} | URL: /account?order=7 | Complete payment. |
| 39 | api_request | {"method":"GET","path":"/api/account"} | {"responseId":"R5","status":200,"body":{"customer":{"id":9,"email":"s7-shopper@fixtures.test","name":"Test Customer s7-shopper"},"balance":229,"transactions":[{"id":11,"orderId":7,"points":129,"reason":"purchase"},{"id":12,"orderId":7,"points":100,"reason":"welcome"}],"orders":[{"id":4,"totalCents": | Read the paid order totals. |
| 40 | observe | {"name":"paidTotal","target":{"source":"api","responseId":"R5","field":"body","jsonPath":"orders.1.totalCents","count":false}} | Recorded paidTotal = 12995 | Record the paid order total (order 7, status paid). |
| 41 | observe | {"name":"paidDiscount","target":{"source":"api","responseId":"R5","field":"body","jsonPath":"orders.1.discountCents","count":false}} | Recorded paidDiscount = 0 | Record the paid order discount. |
| 42 | check | {"assertionId":"A6","target":{"source":"api","responseId":"R5","field":"body","jsonPath":"orders.1.totalCents","count":false}} | Recorded A6: expected 12995, actual 12995 -> match. This result is final. | Paid order total vs subReapplied - discReapplied. |
| 43 | check | {"assertionId":"A7","target":{"source":"api","responseId":"R5","field":"body","jsonPath":"orders.1.discountCents","count":false}} | Recorded A7: expected 1300, actual 0 -> MISMATCH. This result is final. | Paid order discount vs discBefore. |
| 44 | finish | {"outcome":"completed","reason":"All assertions A1-A7 checked. After the declined payment, re-applying SAVE10 showed \"You have already used promo code SAVE10.\" and the code was not applied, so the paid order (#7) had no discount."} | Scenario ended. | Every planned assertion has been checked. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
- A1: ![A1](check-A1.png)
- A2: ![A2](check-A2.png)
- A3: ![A3](check-A3.png)
- A4: ![A4](check-A4.png)
- A5: ![A5](check-A5.png)
- A6: ![A6](check-A6.png)
- A7: ![A7](check-A7.png)
