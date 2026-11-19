<!-- releaseproof-report -->
## ReleaseProof QA: KAN-4

### Release readiness: Not ready

- 4 scenarios failed
- 8 of 33 documented requirements were not verified
- 9 planned scenarios are waiting on a decision or a capability
- 2 conflicts between this pull request's own statements and the approved requirements are unresolved

### Execution results

On `36d46d437a` (the application under test reported this commit)

| | Passed / verified | Failed | Blocked | Unverified | Not planned |
|---|---|---|---|---|---|
| Scenarios (15 planned, 6 executed) | 2 | 4 | 9 | 0 | – |
| Documented requirements (33) | 15 | 10 | 5 | 0 | 3 |

- Questions for the ticket owner: 11
- Execution mode: autonomous (a live model analysed, planned and executed this run)
- Model: claude-opus-5-5
- Cost and time: about $2.52 of $3, 1,999,821 tokens, 139 model calls, 232 tool calls, 8.5 of 15 minutes
- By stage: discover 13,666 tokens ($0.03), analyse 27,067 tokens ($0.34), plan 34,539 tokens ($0.42), execute 1,924,549 tokens ($1.73)

### Failures

**S1 SAVE10 with lowercase and surrounding spaces, fractional-cent rounding, unknown code keeps the applied code, Remove clears it**
- Repeated without a model on a fresh session: reproduced
- After applying ' save10 ', the cart shows an indication of the applied promo code.: expected `present`, actual `absent`
  - Requirement R2: "Applying a valid code shows the code, a Discount line and a Total that equals subtotal minus discount." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- discount\_applied \(cart Discount amount in dollars, as a positive number, after applying ' save10 '\) equals 2.49, which is 10% of $24.99 rounded down to the cent.: expected `2.49`, actual `2.5`
  - Requirement R30: "A cart whose 10% discount has a fraction of a cent \(for example a subtotal of $24.99\)." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- total\_applied \(cart Total in dollars after applying the code\) equals 22.50.: expected `22.5`, actual `22.49`
  - Requirement R30: "A cart whose 10% discount has a fraction of a cent \(for example a subtotal of $24.99\)." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)

**S2 TAKE15 at exactly $60.00 qualifies and is removed when the quantity drops below the minimum**
- Repeated without a model on a fresh session: reproduced
- total\_drop \(cart Total in dollars after changing the quantity to 4\) equals subtotal\_drop.: expected `48`, actual `33`
  - Requirement R20: "the code is removed from the cart and the Total equals the subtotal again." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- After the quantity is changed to 4, the cart no longer shows TAKE15 as an applied code.: expected `absent`, actual `present`
  - Requirement R19: "If a later quantity change takes the subtotal below the minimum, the code is removed from the cart" (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- checkout\_total\_drop \(Order total in dollars on the checkout page after the quantity drop\) equals 48.00, because the code was removed and no discount applies.: expected `48`, actual `33`
  - Requirement R13: "its Order total is the discounted total." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)

**S4 Paid checkout with SAVE10: checkout totals, account overview, code cleared, reuse blocked**
- Repeated without a model on a fresh session: reproduced
- cart\_discount \(cart Discount amount in dollars, as a positive number, after applying SAVE10 to $129.95\) equals 12.99, which is 10% rounded down to the cent.: expected `12.99`, actual `13`
  - Requirement R14: "A percentage discount is rounded down to the whole cent." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- account\_total \(total charged in dollars listed for the new order on the account overview\) equals 116.96, the discounted total.: expected `116.96`, actual `116.95`
  - Requirement R22: "The order is charged the discounted total." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)

**S5 Declined payment keeps SAVE10 on the cart and does not use it up**
- Repeated without a model on a fresh session: reproduced
- checkout\_total \(Order total in dollars on the checkout page with SAVE10 applied to $24.99\) equals 22.50.: expected `22.5`, actual `22.49`
  - Requirement R13: "its Order total is the discounted total." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- discount\_after\_decline \(cart Discount amount in dollars, as a positive number, after the declined payment\) equals 2.49.: expected `2.49`, actual `2.5`
  - Requirement R32: "declined payment leaves the order \`payment\_failed\` and the cart unchanged." (source: document README.md at protected revision 06f52c9927e5)
- After reapplying SAVE10, no message containing 'You have already used promo code' is shown.: expected `absent`, actual `present`
  - Requirement R26: "A declined payment does not use up the code" (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- total\_reapplied \(cart Total in dollars after reapplying SAVE10\) equals 22.50.: expected `22.5`, actual `24.99`
  - Requirement R27: "it stays on the cart and can still be removed and applied again." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)
- discount\_reapplied \(cart Discount amount in dollars, as a positive number, after reapplying SAVE10\) equals 2.49.: expected `2.49`, actual `0`
  - Requirement R27: "it stays on the cart and can still be removed and applied again." (source: Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description)

### Conflicts with approved requirements

Tests ran against the approved requirements. These must be settled by a requirement owner; until then the result cannot be "ready".

- **C1** (unstated-addition) text this pull request adds or changes in README.md states a rule that no approved source states: "charged\), \`discountCents\` and \`promoCode\` \(\`null\` when no code was used\).".
- **C2** (unstated-addition) text this pull request adds or changes in README.md states a rule that no approved source states: "\`GET /api/cart\` returns the signed-in customer's cart as JSON: \`lines\`,".

### Requirement documents changed by this pull request

- `README.md` changed: 8 line(s) added, 1 removed. **Not approved**, so not used as a requirement.
  - A listed requirement owner can approve exactly this change by commenting: `/releaseproof approve-requirements 36d46d437a683189c6f6e1e74af6de647b13b5f9 0cca4d8f613c564d83e679c402fc10cda441aed8bc09cfd15dcec9a40d6d5a1d`

### Stated by the pull request or by unverified sources (never used as an expected value)

- R36 (pr-controlled; consistent): "A customer can apply one promo code to their cart."; from text this pull request adds or changes in README.md
- R37 (pr-controlled; consistent): "\`SAVE10\` takes 10% off"; from text this pull request adds or changes in README.md
- R38 (pr-controlled; consistent): "\`TAKE15\` takes $15.00 off a subtotal of at least $60.00"; from text this pull request adds or changes in README.md
- R39 (pr-controlled; consistent): "are not case-sensitive."; from text this pull request adds or changes in README.md
- R40 (pr-controlled; consistent): "The order total is the subtotal minus the discount,"; from text this pull request adds or changes in README.md
- R41 (pr-controlled; consistent): "each customer can use a code on one paid order only."; from text this pull request adds or changes in README.md
- R42 (pr-controlled; adds): "charged\), \`discountCents\` and \`promoCode\` \(\`null\` when no code was used\)."; from text this pull request adds or changes in README.md
- R43 (pr-controlled; adds): "\`GET /api/cart\` returns the signed-in customer's cart as JSON: \`lines\`,"; from text this pull request adds or changes in README.md

### Requirement sources

- **Note:** The ticket's summary and description are trusted because Jira returned them over its authenticated API. Jira's own permissions decide who may edit an issue, and that can include people outside the configured requirement owners. Comments are checked against the owner list; the description is not.
- Protected revision: `06f52c9927e554dcf3601c27b538b952e1a6ac84`

| Id | Trust | Origin | Why |
|---|---|---|---|
| T1 | authoritative | Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: summary | issue fields of an authenticated Jira record |
| T2 | authoritative | Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: description | issue fields of an authenticated Jira record |
| T3.1 | authoritative | Jira issue KAN-4 on api.atlassian.com/ex/jira/5c055e14-ab2f-4f63-a4a9-35a57d2868bb, fetched over the authenticated API: comment 10000 by the requirement owner \(712020:7364b2f7-52b7-4279-b7ff-d81a5ea796ed\) at 2026-11-19T13:59… | comment by a listed requirement owner \(Jira account id\) |
| D1 | authoritative | document README.md at protected revision 06f52c9927e5 | listed by the manifest at the protected revision and read at that revision |
| P1 | **pr-controlled** | title and description of pull request \#14 | written by the pull request's author |
| P2 | **pr-controlled** | text this pull request adds or changes in README.md | changed by the pull request and not on the protected branch |

### Requirements not verified

| Id | Status | Requirement | Why |
|---|---|---|---|
| R3 | not planned | SAVE10 discounts 10% of the subtotal. | No scenario in the plan compares this requirement. |
| R5 | not planned | The TAKE15 minimum subtotal is $60.00. This overrides the $50.00 in the ticket description. | No scenario in the plan compares this requirement. |
| R7 | not planned | The TAKE15 minimum is checked against the subtotal before any discount. | No scenario in the plan compares this requirement. |
| R8 | blocked | Only one promo code can apply to an order. | S7: 'One code per order' does not say whether a second valid code should replace the first or be rejected with a message. The requirement owner must decide which outcome is expected. |
| R9 | blocked | Codes are accepted regardless of letter case \(e.g. 'save10' works\). | S11: Only spaces around the code are addressed. It must be decided whether internal spaces are ignored or make the code unknown. |
| R10 | blocked | Leading and trailing spaces around an entered code are ignored. | S11: Only spaces around the code are addressed. It must be decided whether internal spaces are ignored or make the code unknown. |
| R11 | blocked | Each customer can use a given code on only one paid order. | S12: It is not specified whether a declined order that is later paid via the webhook uses up the code, or whether the code should then be cleared from the cart. |
| R33 | blocked | Each payment webhook event id is processed at most once. | S12: It is not specified whether a declined order that is later paid via the webhook uses up the code, or whether the code should then be cleared from the cart. |

<details><summary>All scenarios</summary>

| Id | Scenario | Result |
|---|---|---|
| S1 | SAVE10 with lowercase and surrounding spaces, fractional-cent rounding, unknown code keeps the applied code, Remove clears it | failed |
| S2 | TAKE15 at exactly $60.00 qualifies and is removed when the quantity drops below the minimum | failed |
| S3 | TAKE15 rejected at $59.50 \(between the old and new minimum\), then accepted above $60.00 | passed |
| S4 | Paid checkout with SAVE10: checkout totals, account overview, code cleared, reuse blocked | failed |
| S5 | Declined payment keeps SAVE10 on the cart and does not use it up | failed |
| S6 | Another customer can still use a code after the first customer paid with it; loyalty points follow the charged amount | passed |
| S7 | Applying a second valid code while one is already applied | not run: 'One code per order' does not say whether a second valid code should replace the first or be rejected with a message. The requirement owner must decide which outcome is expected. |
| S8 | Below-minimum or already-used code applied while another code is applied | not run: 'Changes nothing' is only stated for unknown codes. It must be decided whether a previously applied code survives a below-minimum or already-used rejection, and which message wins when both rules appl… |
| S9 | Applied code after emptying the cart and adding items again | not run: The expected state of an applied code when the cart is emptied, and whether it should return when items are added again, is not specified. |
| S10 | Notice and re-qualification after TAKE15 is auto-removed | not run: It is not specified whether the customer should see a notice when TAKE15 is removed, or whether the code should reapply once the subtotal qualifies again. |
| S11 | Codes with internal spaces such as 'SAVE 10' | not run: Only spaces around the code are addressed. It must be decided whether internal spaces are ignored or make the code unknown. |
| S12 | Webhook success for a previously declined order that carried a code | not run: It is not specified whether a declined order that is later paid via the webhook uses up the code, or whether the code should then be cleared from the cart. |
| S13 | Account overview discount display for an order without a code | not run: The required display format for the discount of an order without a code \(for example 'None' or '$0.00'\) is not defined. |
| S14 | GET /api/cart and promo fields on GET /api/account orders | not run: These endpoints and fields are stated only in PR-controlled documentation. A requirement owner must confirm whether they are part of the required contract. |
| S15 | Cart loyalty points preview with a code applied | not run: The ticket does not say whether the cart's points preview should be based on the discounted total. Only the points actually earned are specified. |

</details>

<details><summary>Questions for the ticket owner</summary>

- When a valid code is already applied and the customer applies a different valid code, should the new code replace the old one, or be rejected with a message?
- When a code is rejected because it is below the TAKE15 minimum or already used, should a previously applied code stay applied, as it does for unknown codes?
- What exact wording should the TAKE15 below-minimum error use?
- If a code is both already used by this customer and below the TAKE15 minimum, which message should be shown?
- What should happen to an applied code when the cart is emptied, and should it reappear when items are added again?
- When TAKE15 is removed because of a quantity change, should the customer see a notice? Should the code reapply if the subtotal rises above $60.00 again?
- Should codes with internal spaces or other variations \(e.g. 'SAVE 10'\) be accepted or treated as unknown?
- If a checkout is declined and the payment provider later reports success for that order via the webhook, does the code count as used? Should it then be cleared from the cart?
- How should the account overview show the discount for orders placed without a code, for example 'None' or '$0.00'?
- Are the GET /api/cart endpoint and the discountCents/promoCode fields on /api/account orders part of the required contract?
- Should the cart's 'You could earn N loyalty points' preview be based on the discounted total?

</details>

Application ran isolated: outbound network blocked, filesystem read-only, user id 10001, 10 environment variables, none of them credentials.

Full report, steps and screenshots: [workflow run and evidence artifact](https://github.com/ihsansengun/ReleaseProof/actions/runs/44545840672) (kept 14 days).