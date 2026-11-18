# S3 TAKE15 at exactly $60.00 applies; dropping the quantity below the minimum removes it

**Verdict: FAILED** — A3: expected 0, got 1500; A4: expected 4800, got 3300; A5: expected 48, got 33

- Steps chosen by: external model via HTTP bridge
- Environment: http://localhost:3000, commit 5ca65f012d822e0a2fe3dc56b1dd3a6a0066570b
- Started 2026-11-18T18:58:14.120Z, took 132.8 s, 31 tool calls
- Basis: risk; requirements R6, R7, R16, R4

## Objective

Sign in as the customer. Add Notebook, Dotted A5 ($12.00) to the cart with quantity 5 so the subtotal is exactly $60.00. On the cart page apply TAKE15. Call GET /api/cart and record subtotalCents (atSubtotal), discountCents (atDiscount) and totalCents (atTotal). Then, on the cart page, change the notebook quantity to 4 (subtotal $48.00). After the cart page has updated, record the displayed Subtotal (uiSubtotal) and Total (uiTotal) in dollars, then call GET /api/cart and record subtotalCents (afterSubtotal), discountCents (afterDiscount) and totalCents (afterTotal).

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | With 5 notebooks (subtotal exactly $60.00) and TAKE15 applied, discountCents from GET /api/cart (atDiscount) equals 1500: exactly $60.00 qualifies. | `1500` | 1500 | 1500 | match | [check-A1.png](check-A1.png) |
| A2 | With 5 notebooks and TAKE15 applied, totalCents from GET /api/cart (atTotal) equals atSubtotal minus 1500 (the code stays applied even though the discounted total is below $60.00, since the minimum is checked before discount). | `atSubtotal - 1500` | 4500 | 4500 | match | [check-A2.png](check-A2.png) |
| A3 | After changing the quantity to 4 (subtotal $48.00), discountCents from GET /api/cart (afterDiscount) is 0. | `0` | 0 | 1500 | **MISMATCH** | [check-A3.png](check-A3.png) |
| A4 | After changing the quantity to 4, totalCents from GET /api/cart (afterTotal) equals subtotalCents (afterSubtotal). | `afterSubtotal` | 4800 | 3300 | **MISMATCH** | [check-A4.png](check-A4.png) |
| A5 | After changing the quantity to 4, the Total shown on the cart page (uiTotal, dollars) equals the displayed Subtotal (uiSubtotal). | `uiSubtotal` | 48 | 33 | **MISMATCH** | [check-A5.png](check-A5.png) |

## Observations

- `atSubtotal` = 6000
- `atDiscount` = 1500
- `atTotal` = 4500
- `uiSubtotal` = 48
- `uiTotal` = 33
- `afterSubtotal` = 4800
- `afterDiscount` = 1500
- `afterTotal` = 3300

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | See the landing page to find sign-in. |
| 2 | navigate | {"path":"/login"} | URL: /login | Open the sign-in page to log in as the customer. |
| 3 | fill | {"element":{"by":"role","role":"textbox","value":"Email"},"text":"s3-shopper@fixtures.test"} | URL: /login | Enter the shopper email. |
| 4 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"{{secret:shopper.password}}"} | URL: /login | Enter the shopper password. |
| 5 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: /account | Submit the sign-in form. |
| 6 | navigate | {"path":"/cart"} | URL: /cart | Check the cart starts empty. |
| 7 | navigate | {"path":"/"} | URL: / | Go to products to add the notebook. |
| 8 | click | {"element":{"by":"role","role":"button","value":"Add Notebook, Dotted A5 to cart"}} | URL: /cart | Add the notebook to the cart. |
| 9 | fill | {"element":{"by":"role","role":"spinbutton","value":"Quantity for Notebook, Dotted A5"},"text":"5"} | URL: /cart | Set quantity to 5 for a $60.00 subtotal. |
| 10 | click | {"element":{"by":"role","role":"button","value":"Update quantity for Notebook, Dotted A5"}} | URL: /cart | Save the quantity of 5. |
| 11 | fill | {"element":{"by":"role","role":"textbox","value":"Promo code"},"text":"TAKE15"} | URL: /cart | Enter the TAKE15 promo code. |
| 12 | click | {"element":{"by":"role","role":"button","value":"Apply"}} | URL: /cart | Apply TAKE15 at a $60.00 subtotal. |
| 13 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R1","status":200,"body":{"lines":[{"productId":3,"name":"Notebook, Dotted A5","priceCents":1200,"quantity":5,"lineCents":6000}],"subtotalCents":6000,"promoCode":"TAKE15","discountCents":1500,"totalCents":4500}} | Read cart totals with 5 notebooks and TAKE15 applied. |
| 14 | observe | {"name":"atSubtotal","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"subtotalCents","count":false}} | Recorded atSubtotal = 6000 | Record subtotalCents at the $60 subtotal with TAKE15. |
| 15 | observe | {"name":"atDiscount","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"discountCents","count":false}} | Recorded atDiscount = 1500 | Record discountCents at the $60 subtotal with TAKE15. |
| 16 | observe | {"name":"atTotal","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"totalCents","count":false}} | Recorded atTotal = 4500 | Record totalCents at the $60 subtotal with TAKE15. |
| 17 | check | {"assertionId":"A1","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"discountCents","count":false}} | Recorded A1: expected 1500, actual 1500 -> match. This result is final. | Check discount at exactly $60. |
| 18 | check | {"assertionId":"A2","target":{"source":"api","responseId":"R1","field":"body","jsonPath":"totalCents","count":false}} | Recorded A2: expected 4500, actual 4500 -> match. This result is final. | Check total at exactly $60 with TAKE15. |
| 19 | fill | {"element":{"by":"role","role":"spinbutton","value":"Quantity for Notebook, Dotted A5"},"text":"4"} | URL: /cart | Drop quantity to 4 for a $48.00 subtotal. |
| 20 | click | {"element":{"by":"role","role":"button","value":"Update quantity for Notebook, Dotted A5"}} | URL: /cart | Save the quantity of 4. |
| 21 | observe | {"name":"uiSubtotal","target":{"source":"page","by":"text","value":"Subtotal:","count":false,"pattern":"Subtotal:\\s*\\$([0-9.,]+)"}} | Recorded uiSubtotal = 48 | Record the displayed subtotal after quantity change. |
| 22 | observe | {"name":"uiTotal","target":{"source":"page","by":"text","value":"Total:","count":false,"pattern":"Total:\\s*\\$([0-9.,]+)"}} | error: Error: Expected exactly one element for {"source":"page","by":"text","value":"Total:","count":false,"pattern":"Total:\\s*\\$([0-9.,]+)"}, found 2. | Record the displayed total after quantity change. |
| 23 | observe | {"name":"uiTotal","target":{"source":"page","by":"text","value":"Total: $33","count":false,"pattern":"Total:\\s*\\$([0-9.,]+)"}} | Recorded uiTotal = 33 | Record the displayed total after quantity change. |
| 24 | api_request | {"method":"GET","path":"/api/cart"} | {"responseId":"R2","status":200,"body":{"lines":[{"productId":3,"name":"Notebook, Dotted A5","priceCents":1200,"quantity":4,"lineCents":4800}],"subtotalCents":4800,"promoCode":"TAKE15","discountCents":1500,"totalCents":3300}} | Read cart totals after dropping quantity to 4. |
| 25 | observe | {"name":"afterSubtotal","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"subtotalCents","count":false}} | Recorded afterSubtotal = 4800 | Record subtotalCents after quantity 4. |
| 26 | observe | {"name":"afterDiscount","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded afterDiscount = 1500 | Record discountCents after quantity 4. |
| 27 | observe | {"name":"afterTotal","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"totalCents","count":false}} | Recorded afterTotal = 3300 | Record totalCents after quantity 4. |
| 28 | check | {"assertionId":"A3","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"discountCents","count":false}} | Recorded A3: expected 0, actual 1500 -> MISMATCH. This result is final. | Check discount removed below minimum. |
| 29 | check | {"assertionId":"A4","target":{"source":"api","responseId":"R2","field":"body","jsonPath":"totalCents","count":false}} | Recorded A4: expected 4800, actual 3300 -> MISMATCH. This result is final. | Check API total equals subtotal. |
| 30 | check | {"assertionId":"A5","target":{"source":"page","by":"text","value":"Total: $33","count":false,"pattern":"Total:\\s*\\$([0-9.,]+)"}} | Recorded A5: expected 48, actual 33 -> MISMATCH. This result is final. | Check displayed total equals displayed subtotal. |
| 31 | finish | {"outcome":"completed","reason":"All five assertions checked. At qty 5 ($60.00) TAKE15 gave discount 1500/total 4500. After qty 4 ($48.00) the cart page and GET /api/cart still applied TAKE15 (discount 1500, total 3300; UI total $33.00 vs subtotal $48.00)."} | Scenario ended. | Every planned assertion has been checked. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
- A1: ![A1](check-A1.png)
- A2: ![A2](check-A2.png)
- A3: ![A3](check-A3.png)
- A4: ![A4](check-A4.png)
- A5: ![A5](check-A5.png)
