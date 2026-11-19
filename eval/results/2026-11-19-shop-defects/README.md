# Live defect detection on the shop, 19 November 2026

One live run of the whole pipeline against a build of the promo-code feature
(ticket `NWG-342`) with its three known defects put back. This record is
separate from the security evaluation: it was made with `main` at `795a240`,
before the security fixes.

- Pull request: [#8](https://github.com/ihsansengun/ReleaseProof/pull/8)
  (draft, never to be merged), commit `36d46d4`: the shop fixture with its
  fix commit `6089099` reverted.
- Run: build [44514667792](https://github.com/ihsansengun/ReleaseProof/actions/runs/44514667792),
  QA [44514903259](https://github.com/ihsansengun/ReleaseProof/actions/runs/44514903259).
- Model: `claude-opus-5-5` for every stage, through the direct API driver.
- Inputs to the agent: the ticket file, the pull request, the manifest and
  the README it lists. No defect list, no scenarios. The sealed key
  (`../2026-11-18/SEALED-shop.md`) is not read by the pipeline.
- Limits: $4.00, 8 scenarios, 20 minutes.
- Sources for the figures: the QA job log and the comment the workflow
  posted, saved as [comment-pr8.md](comment-pr8.md).

## Result

Check: **failure**. Title: "Not ready: 7 failed, 1 passed · 15 of 33
requirements verified · 8 scenarios blocked (autonomous)".

### Detection, scored against the sealed key

| Planted defect | Result | What the run recorded |
|---|---|---|
| A. Percentage discount rounded to the nearest cent, not down | Detected (S1, and again in S4, S5, S6, S7, S8) | $24.99 cart: discount 250 where 249 is required, total $22.49 where $22.50 is required, on the cart, the checkout page, the stored order and the account page. $129.95 cart: 1300 where 1299 is required |
| B. A declined payment uses up the code | Detected (S7) | After a declined payment, Remove, then SAVE10 again: the "already used" error is shown and the discount is 0 |
| C. TAKE15 minimum not re-checked after a quantity change | Detected (S2) | At 4 notebooks ($48.00) the code is still applied: discount 1500, total $33.00 where $48.00 is required |

**3 of 3 detected.** Every failure was repeated without a model on a fresh
session and reproduced (7 of 7).

### False positives

- **Scenarios: 0.** Each of the seven failed scenarios contains at least one
  comparison that fails because of a planted defect.
- **Assertions: 1.** In S8 the plan compared the points earned on a
  discounted first order with a formula of its own. The formula did not
  allow for the 100-point welcome bonus on a first paid order, which is
  correct behaviour, so the comparison failed (117.1 expected, 216 actual).
  The bonus is not in the ticket or the README. This is an expectation the
  planner should have raised as a question instead of computing: the rule
  "no invented expectations" was broken once. The scenario still fails for a
  real reason (the stored total is one cent off).

### Attribution is noisier than detection

Defect A changes every amount computed with SAVE10, so it surfaced in six
scenarios written for other requirements. The report marks 16 requirements
as failed, but several of those are correct behaviour measured with a wrong
amount: for example R8 ("spaces around the code are ignored") is marked
failed because the discount on that cart was 1300 instead of 1299, although
the code was accepted with its spaces. The failures are real; the list of
failed requirements overstates how many rules are broken. Three distinct
defects account for all of them. Grouping failures by cause is not
implemented.

### Coverage

| | Verified | Failed | Blocked | Unverified | Not planned |
|---|---|---|---|---|---|
| Documented requirements (33) | 15 | 16 | 0 | 0 | 2 |
| Scenarios (16 planned, 8 executed) | 1 passed | 7 | 8 not run | 0 | none dropped by the limit |

Untested, as reported by the run:

- Not planned: R3 ("TAKE15 takes $15.00 off the cart") and R6 ("The TAKE15
  minimum is checked against the subtotal before any discount"). S2 does
  exercise a $15.00 discount at $60.00, but no assertion was tied to R3.
- Eight scenarios not run, each waiting on a question for the ticket owner:
  second valid code while one is applied; casing of the code in the "already
  used" message; a code used elsewhere while still on a cart; a declined
  order later confirmed by webhook; emptying and refilling the cart; a notice
  when TAKE15 is removed; internal spaces and tabs; the cart's "points you
  could earn" figure. The key's two deliberately missing rules (second code,
  emptied cart) are both among the questions.
- Correct behaviour the key warns about was not reported as a defect: the
  $60.00 minimum from the later comment was used (S3 passed at $59.50).

### Usage, cost and time

| Stage | Model calls | Input, uncached | Cache read | Cache write | Output | Cost | Time |
|---|---|---|---|---|---|---|---|
| Discover | 5 | 12 | 9,501 | 3,500 | 693 | $0.03 | 12.1 s |
| Analyse | 1 | 11,492 | 0 | 0 | 11,240 | $0.27 | 95.0 s |
| Plan | 1 | 12,628 | 0 | 0 | 14,988 | $0.35 | 121.7 s |
| Execute | 131 | 278 | 1,289,111 | 129,537 | 27,676 | $1.46 | 156.3 s |
| Replay of failures | 0 | | | | | $0 | 52.3 s |
| **Total** | 138 | 24,410 | 1,298,612 | 133,037 | 54,597 | **$2.11 of $4.00** | 7.3 min |

1,510,656 tokens, 233 tool calls. No model API errors. Not stopped by a
limit. No human intervention during the run. Costs are estimates from token
counts and list prices.

Isolation probe (the version before the security fixes): outbound network
blocked, root filesystem read-only, user 10001, 11 environment variables,
none unexpected.

## An earlier attempt that produced no result

The first attempt
([QA run 44513301780](https://github.com/ihsansengun/ReleaseProof/actions/runs/44513301780))
was cancelled 7½ minutes in, during execution. Opening draft pull request #9
started a build event; because of a bug in the workflows every QA run shared
one concurrency group, so the new (skipped) run cancelled it. Nothing was
scored from it and its plan was not looked at. Its model usage was not
logged; from the completed run's profile it is probably between $1.50 and
$2.00. The run above is therefore the first and only scored run. The bug is
finding 1 in [docs/SECURITY-REVIEW.md](../../../docs/SECURITY-REVIEW.md).

## What this adds to the earlier evidence

- The shop's three defects were previously found only with a model attached
  through the bridge. This is the same result with the live API, in CI, from
  a fresh plan.
- First run under the readiness rule: the Check is red, the title leads
  with "Not ready", and untested requirements are listed.
- First run with per-stage usage: execution is 69% of the cost, and within
  execution cache writes ($0.65) and output ($0.55) are the larger parts;
  cache reads are $0.26.

## What it does not show

- One run. Detection on a second run of the same build may differ.
- Nothing about a build with defects the pipeline's authors have not seen
  results for: these three were found once before, on 18 November.
