# Live run from a real Jira ticket: KAN-4, 19 November 2026

The first run in which the requirements came from a live Jira issue over the
REST API instead of a ticket file, and the first live run of the
requirement-source authority rules. One run, in GitHub Actions, started by
hand. This record is separate from the fixture-based evaluations; none of
those was changed.

- Ticket: `KAN-4` "Promo codes in the cart" on `releaseproof.atlassian.net`,
  with one comment by the requirement owner changing the TAKE15 minimum from
  $50.00 to $60.00.
- Pull request: [#14](https://github.com/ihsansengun/ReleaseProof/pull/14)
  (draft, never to be merged), commit `36d46d4`: the shop's promo-code
  feature with its three known defects. The agent was given no defect list
  and no scenarios.
- Run: [QA run 44545840672](https://github.com/ihsansengun/ReleaseProof/actions/runs/44545840672)
  on `main` at `06f52c9`. Model `claude-opus-5-5` through the direct API,
  planning from scratch. Limits: $3.00, 6 scenarios, 15 minutes.
- Sources for every figure: the QA job log and the report the workflow
  posted, saved as [comment-pr14.md](comment-pr14.md). In the saved copy the
  requirement owner's display name is replaced by "the requirement owner";
  nothing else differs from what was posted. The evidence artifact (steps,
  screenshots, `run.json`, the audit trail) is on the run page for 14 days
  and could not be downloaded into the environment this was written in.

## 1. Jira authentication and retrieval

Succeeded. Every ticket source in the report has the origin "Jira issue KAN-4
on api.atlassian.com/ex/jira/…, fetched over the authenticated API". The
token is a scope-limited, read-only API token held as a repository secret;
the account email is a secret and the site address a variable. The isolation
check passed: 10 environment variables in the application container, none
unexpected, none a credential; network blocked, including the runner host.

## 2. Requirements and owner comments used

| Source | Trust | Why |
|---|---|---|
| T1 KAN-4 summary | authoritative | issue fields of an authenticated Jira record |
| T2 KAN-4 description | authoritative | issue fields of an authenticated Jira record |
| T3.1 comment 10000 by the requirement owner | authoritative | comment by a listed requirement owner, matched by Jira account id |
| D1 `apps/shop/README.md` as `main` has it (`06f52c9`) | authoritative | listed by the manifest at the protected revision |
| P1 pull request title and description | pr-controlled | written by the pull request's author |
| P2 text the pull request adds to the README | pr-controlled | changed by the pull request, not on the protected branch |

- 33 approved requirements were extracted, each with a quote verified
  against the one source it names. The failures quote the ticket's own
  sentences, for example "A percentage discount is rounded down to the
  whole cent." and "A declined payment does not use up the code".
- **The owner's amendment was used.** The plan tests TAKE15 "at exactly
  $60.00" (S2) and "rejected at $59.50 (between the old and new minimum),
  then accepted above $60.00" (S3). S3 passed. The requirement itself reads
  "The TAKE15 minimum subtotal is $60.00. This overrides the $50.00 in the
  ticket description."
- From the pull request's README text, 8 statements were recorded as claims
  and none was used as an expected value: 6 judged consistent with approved
  requirements, 2 flagged as rules no approved source states (the
  `GET /api/cart` endpoint and the `discountCents` / `promoCode` fields).

## 3. Scenarios

15 planned. 6 executed, which was the limit: 2 passed, 4 failed, none
unverified. 9 not run, each waiting on a question.

| Id | Scenario | Result |
|---|---|---|
| S1 | SAVE10 with lowercase and surrounding spaces, fractional-cent rounding, unknown code keeps the applied code, Remove clears it | failed |
| S2 | TAKE15 at exactly $60.00 qualifies and is removed when the quantity drops below the minimum | failed |
| S3 | TAKE15 rejected at $59.50, then accepted above $60.00 | passed |
| S4 | Paid checkout with SAVE10: checkout totals, account overview, code cleared, reuse blocked | failed |
| S5 | Declined payment keeps SAVE10 on the cart and does not use it up | failed |
| S6 | Another customer can still use a code after the first paid with it; loyalty points follow the charged amount | passed |
| S7–S15 | Second valid code; a rejected code while another is applied; emptied cart; notice and re-qualification after TAKE15 is removed; internal spaces; webhook success after a decline; discount display without a code; the API fields; the points preview | not run: each needs a decision |

11 questions were raised for the ticket owner. They include both rules the
ticket leaves out on purpose (a second valid code; an emptied cart), and one
that exists only because of the authority rules: "Are the GET /api/cart
endpoint and the discountCents/promoCode fields on /api/account orders part
of the required contract?"

## 4. Known defects

The build has the three defects of the sealed key
(`../2026-11-18/SEALED-shop.md`). **3 of 3 were detected.** All 4 failed
scenarios were repeated without a model on a fresh session and reproduced.

| Defect | Detected in | Evidence |
|---|---|---|
| A. Percentage discount rounded to the nearest cent, not down | S1, S4, S5 | $24.99 cart: discount 2.50 where 2.49 is required, total 22.49 where 22.50 is required, the same on the checkout page. $129.95 cart: discount 13.00 where 12.99 is required; the order is charged 116.95 where 116.96 is required |
| B. A declined payment uses up the code | S5 | After the declined payment and re-applying SAVE10: the message "You have already used promo code" is present, the discount is 0 where 2.49 is required, the total is 24.99 where 22.50 is required |
| C. TAKE15 minimum not re-checked after a quantity change | S2 | Quantity changed to 4 ($48.00): total 33 where 48 is required; TAKE15 still shown as applied; the checkout total is 33 where 48 is required |

## 5. False positives and invented expectations

- **False-positive scenarios: 0.** Each failed scenario contains at least one
  comparison that fails because of a planted defect.
- **Probable false-positive assertion: 1.** S1's first assertion reports that
  after applying ` save10 ` the cart shows no "indication of the applied
  promo code", while the same scenario records the discount as applied. The
  likely cause is a locator looking for the text as typed rather than the
  code as displayed. Not confirmed: the step record is in the artifact.
- **Invented expectations: none found.** Every assertion rests on an
  approved requirement with a verified quote; the validator removes any that
  does not. The loyalty-points comparison that failed wrongly in the earlier
  shop run (`../2026-11-19-shop-defects/`) passed here.
- **Attribution is still noisy.** The rounding defect changes every amount
  computed with SAVE10, so it is also reported under requirements it does
  not break: for example the README's "the cart unchanged" after a declined
  payment (R32) is marked failed because the discount was 2.50, not 2.49.
  The report lists 10 failed requirements; three defects account for all of
  them.

## 6. Coverage, cost and time

| | Verified | Failed | Blocked | Unverified | Not planned |
|---|---|---|---|---|---|
| Approved requirements (33) | 15 | 10 | 5 | 0 | 3 |
| Scenarios (15 planned, 6 executed) | 2 passed | 4 | 9 not run | 0 | none dropped by the limit |

25 of 33 approved requirements were compared against the application.

| Stage | Model calls | Input, uncached | Cache read | Cache write | Output | Cost | Time |
|---|---|---|---|---|---|---|---|
| Discover | 5 | 12 | 9,489 | 3,492 | 673 | $0.03 | 13.7 s |
| Analyse | 1 | 12,747 | 0 | 0 | 14,320 | $0.34 | 120.5 s |
| Plan | 1 | 17,055 | 0 | 0 | 17,484 | $0.42 | 149.6 s |
| Execute | 132 | 276 | 1,758,961 | 128,304 | 37,008 | $1.73 | 191.3 s |
| Replay of failures | 0 | | | | | $0 | 36.1 s |
| **Total** | 139 | 30,090 | 1,768,450 | 131,796 | 69,485 | **$2.52 of $3.00** | 8.5 min |

1,999,821 tokens, 232 tool calls. The QA job took about 10 minutes including
installation. No model API errors; not stopped by a limit; no human
intervention during the run. Costs are estimates from token counts and list
prices.

Compared with the fixture-based run of the same build earlier the same day
($2.11, 8 scenarios): analysis and planning cost more ($0.76 against $0.62),
because the analyst now also records and classifies the pull request's
claims, and execution cost more per scenario.

## 7. Check result and what the authority rules did

Check: **failure**. "Not ready: 4 failed, 2 passed · 15 of 33 requirements
verified · 9 scenarios blocked (autonomous)".

First live use of the requirement-source authority rules:

- The new analysis schema and prompt worked with the live model at the first
  attempt.
- Two conflicts were raised, both of kind "unstated addition": README text
  added by the pull request describes API fields no approved source states.
  The scenario that depended on them (S14) was not run, with the reason
  "These endpoints and fields are stated only in PR-controlled
  documentation."
- The report lists the README change as not approved and prints the exact
  command a requirement owner would post to approve it.
- Every failure in the report names the source of its requirement.

## Limitations seen in this run

- **Precedence held, but not by code.** The description still says $50.00
  and both it and the owner's comment are authoritative. The model used
  $60.00 because its instructions say to follow the later statement. A
  mechanism to enforce this is proposed in
  `docs/design/REQUIREMENT-AUTHORITY.md`; it is not implemented.
- **Coverage understates what was tested.** "The TAKE15 minimum subtotal is
  $60.00" (R5) is reported as not planned, although S2 and S3 exercise
  exactly that rule: no assertion was tied to that requirement. The same
  holds for R3 and R7.
- **Two pull requests share this commit.** PR #8 and PR #14 both point at
  `36d46d4`, and a Check belongs to a commit, so this run's Check also shows
  on PR #8 and is now the latest there. The comment went only to PR #14.
  PR #8's own recorded result is unchanged.
- **Identity in a public report.** The posted report gives the requirement
  owner's display name and Jira account id as the origin of the comment.
  The account id is needed for the audit trail; the display name is not.
- **The Jira description is trusted on Jira's own edit permissions**, which
  may include people outside the configured owner list. The report carries
  a note saying so. This remains an open authorisation gap.
- **One run.** The three defects were found in every run of this build so
  far (three runs, two requirement sources); that is still a small sample
  of one application.
- Non-owner Jira comments have not been exercised live; there is no second
  Jira account yet.
