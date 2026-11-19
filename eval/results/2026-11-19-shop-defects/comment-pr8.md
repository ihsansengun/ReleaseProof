<!-- releaseproof-report -->
## ReleaseProof QA: NWG-342

### Release readiness: Not ready

- 7 scenarios failed
- 2 of 33 documented requirements were not verified
- 8 planned scenarios are waiting on a decision or a capability

### Execution results

On `36d46d437a` (the application under test reported this commit)

| | Passed / verified | Failed | Blocked | Unverified | Not planned |
|---|---|---|---|---|---|
| Scenarios (16 planned, 8 executed) | 1 | 7 | 8 | 0 | – |
| Documented requirements (33) | 15 | 16 | 0 | 0 | 2 |

- Questions for the ticket owner: 8
- Execution mode: autonomous (a live model analysed, planned and executed this run)
- Model: claude-opus-5-5
- Cost and time: about $2.11 of $4, 1,510,656 tokens, 138 model calls, 233 tool calls, 7.3 of 20 minutes
- By stage: discover 13,706 tokens ($0.03), analyse 22,732 tokens ($0.27), plan 27,616 tokens ($0.35), execute 1,446,602 tokens ($1.46)

### Failures

**S1 SAVE10 on a $24.99 cart rounds the discount down and the checkout page shows the same amounts**
- Repeated without a model on a fresh session: reproduced
- After applying SAVE10, the Total shown on the cart page, in dollars, equals 22.50.: expected `22.5`, actual `22.49`
  - Requirement R10: "a Total that equals subtotal minus discount"
- After applying SAVE10, GET /api/cart discountCents equals 249 \(10% of 2499 rounded down\).: expected `249`, actual `250`
  - Requirement R13: "A percentage discount is rounded down to the whole cent."
- After applying SAVE10, GET /api/cart totalCents equals 2250 \(2499 - 249\).: expected `2250`, actual `2249`
  - Requirement R10: "a Total that equals subtotal minus discount"
- On the checkout page, before paying, the discount amount shown in dollars equals 2.49.: expected `2.49`, actual `2.5`
  - Requirement R11: "The checkout page shows the same discount"
- On the checkout page, before paying, the Order total in dollars equals 22.50.: expected `22.5`, actual `22.49`
  - Requirement R12: "its Order total is the discounted total"

**S2 TAKE15 at exactly $60.00 applies, then is removed when the quantity drops below the minimum**
- Repeated without a model on a fresh session: reproduced
- After reducing the quantity to 4 and reloading, the cart page Total in dollars equals 48.00.: expected `48`, actual `33`
  - Requirement R19: "the Total equals the subtotal again"
- After reducing the quantity to 4, GET /api/cart promoCode is null or missing, so the code was removed.: expected `absent`, actual `present`
  - Requirement R18: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart"
- After reducing the quantity to 4, GET /api/cart discountCents equals 0.: expected `0`, actual `1500`
  - Requirement R18: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart"
- After reducing the quantity to 4, GET /api/cart totalCents equals 4800, the same as the subtotal.: expected `4800`, actual `3300`
  - Requirement R19: "the Total equals the subtotal again"

**S4 Code with spaces and lowercase applies; an unknown code keeps it; Remove clears it**
- Repeated without a model on a fresh session: reproduced
- After applying ' save10 ', GET /api/cart discountCents equals 1299 \(10% of 12995 rounded down\).: expected `1299`, actual `1300`
  - Requirement R8: "spaces around the code are ignored"
- After applying NOPE99, GET /api/cart discountCents still equals 1299 \(SAVE10 stays applied\).: expected `1299`, actual `1300`
  - Requirement R15: "changes nothing: a code that was already applied stays applied."
- After applying NOPE99, GET /api/cart totalCents still equals 11696.: expected `11696`, actual `11695`
  - Requirement R15: "changes nothing: a code that was already applied stays applied."

**S5 Paying with SAVE10 charges the discounted total, clears the code and uses it up**
- Repeated without a model on a fresh session: reproduced
- After successful payment, GET /api/account shows the order with totalCents equal to 2250.: expected `2250`, actual `2249`
  - Requirement R22: "The order is charged the discounted total."
- After successful payment, GET /api/account shows the order with discountCents equal to 249.: expected `249`, actual `250`
  - Requirement R29: "GET /api/account returns discountCents and promoCode for each order \(0 and null when no code was used\)"
- On the account overview page, the order's row or entry contains the charged total '22.50'.: expected `22.50`, actual `\#1 -$2.50 \(SAVE10\) $22.49 paid`
  - Requirement R28: "The account overview lists each order's discount and the total charged."

**S6 One customer using SAVE10 does not block another customer**
- Repeated without a model on a fresh session: reproduced
- For customer 'second' after applying SAVE10, GET /api/cart discountCents equals 249.: expected `249`, actual `250`
  - Requirement R25: "Other customers are not affected."

**S7 A declined payment keeps the code, and it can be removed and applied again**
- Repeated without a model on a fresh session: reproduced
- After the declined payment, GET /api/cart discountCents equals 249.: expected `249`, actual `250`
  - Requirement R26: "A declined payment does not use up the code: it stays on the cart"
- After re-applying SAVE10, no 'You have already used promo code' error message is shown on the cart page.: expected `absent`, actual `present`
  - Requirement R27: "can still be removed and applied again"
- After re-applying SAVE10, GET /api/cart discountCents equals 249.: expected `249`, actual `0`
  - Requirement R27: "can still be removed and applied again"

**S8 Loyalty points follow the charged amount; an order without a code reports 0 and null**
- Repeated without a model on a fresh session: reproduced
- GET /api/account shows the first order \(with SAVE10\) with totalCents equal to 11696.: expected `11696`, actual `11695`
  - Requirement R33: "Each order carries \`totalCents\` \(the amount charged\)"
- Points earned on the discounted order \(balance1 - balance0\) are at most the points earned on the undiscounted order \(balance2 - balance1\) scaled by 11696/12995, plus 1 point for rounding. Points are earned on the charged amount, not on …: expected `117.1049634474798`, actual `216`
  - Requirement R32: "points are still earned on the amount the customer is actually charged."

### Requirements not verified

| Id | Status | Requirement | Why |
|---|---|---|---|
| R3 | not planned | TAKE15 takes $15.00 off the cart. | No scenario in the plan compares this requirement. |
| R6 | not planned | The TAKE15 minimum is checked against the subtotal before any discount. | No scenario in the plan compares this requirement. |

<details><summary>All scenarios</summary>

| Id | Scenario | Result |
|---|---|---|
| S1 | SAVE10 on a $24.99 cart rounds the discount down and the checkout page shows the same amounts | failed |
| S2 | TAKE15 at exactly $60.00 applies, then is removed when the quantity drops below the minimum | failed |
| S3 | TAKE15 is rejected at $59.50, and codes never stack | passed |
| S4 | Code with spaces and lowercase applies; an unknown code keeps it; Remove clears it | failed |
| S5 | Paying with SAVE10 charges the discounted total, clears the code and uses it up | failed |
| S6 | One customer using SAVE10 does not block another customer | failed |
| S7 | A declined payment keeps the code, and it can be removed and applied again | failed |
| S8 | Loyalty points follow the charged amount; an order without a code reports 0 and null | failed |
| S9 | Applying a second valid code while another is applied | not run: The ticket only says one code per order. It must be decided whether a second valid code replaces the applied one or is rejected. |
| S10 | Already-used error text when the code is typed in lowercase with spaces | not run: It must be decided whether &lt;CODE&gt; in the error is the canonical uppercase code or the text as typed. |
| S11 | Code already on a cart is used again in a second session | not run: The ticket does not say whether an already-applied code that has since been used must be blocked at payment time. |
| S12 | Declined order later confirmed via payment webhook | not run: The ticket defines 'used' only through checkout success or decline. It must be decided how a webhook-confirmed payment affects promo usage and the cart. |
| S13 | Emptying and refilling a cart with SAVE10 applied | not run: The ticket is silent on whether the code survives an emptied cart. |
| S14 | Notice when TAKE15 is removed automatically | not run: It must be decided whether a notice is required and what it should say. |
| S15 | Codes with internal spaces or tabs | not run: The ticket only covers spaces around the code. Handling of internal spaces and other whitespace is undecided. |
| S16 | Cart potential loyalty points reflect the discounted total | not run: This requirement is only inferred from the PR. It must be confirmed that the cart's potential-points figure should use the discounted total. |

</details>

<details><summary>Questions for the ticket owner</summary>

- When a valid code is already applied and the customer applies the other valid code, should it replace the first code or be rejected with an error?
- What exact wording should the TAKE15 minimum-subtotal error use, beyond naming $60.00?
- In the 'already used' error, should &lt;CODE&gt; be the canonical uppercase code or the text exactly as the customer typed it?
- Should the customer see a message when TAKE15 is removed automatically after a quantity change drops the subtotal below $60.00?
- If the cart is emptied while SAVE10 is applied and items are added again later, should SAVE10 still be applied?
- Should codes with internal spaces \(e.g. 'SAVE 10'\) or other surrounding whitespace such as tabs be accepted?
- If a code is already on the cart when the customer completes a paid order with it elsewhere \(e.g. in another session or tab\), should a second checkout with that code be blocked at payment time?
- If an order first declined \(payment\_failed\) is later reported as payment.succeeded via POST /api/webhooks/payment, does that order use up its code, and should the code be cleared from the cart?

</details>

Application ran isolated: outbound network blocked, filesystem read-only, user id 10001, 11 environment variables, none of them credentials.

Full report, steps and screenshots: [workflow run and evidence artifact](https://github.com/ihsansengun/ReleaseProof/actions/runs/44514903259) (kept 14 days).