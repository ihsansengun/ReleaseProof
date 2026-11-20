# Reliability gate before the independent evaluation, 20 November 2026

Two live runs to decide whether the locator, evidence and scenario-selection
changes made after routing benchmark C hold with a live model.

**The gate failed.** Both planted defects were found and the threshold
scenarios were generated, but three scenarios failed on behaviour that was
correct, and the scenario exactly at the threshold was planned and not run.

- Engine: `main` at `819caaf`. Preset `opus-planning`: analysis and planning
  `claude-opus-5-5` at high effort, discovery and execution
  `claude-haiku-5-5`, escalation `claude-sonnet-5-5`. Planning from scratch,
  started by hand, ticket files, six scenarios each.
- Limits: $2 a run, $4 in total, 15 minutes. Spent: **$2.63**. No run hit a
  limit, needed a human or had a model error.
- Sources: the QA job logs with their redacted diagnostics, and the posted
  reports. Key: `../2026-11-18/SEALED-timeoff.md`.
- One run per build. Model output varies.

## The gate

| Criterion | Run A | Run B | Result |
|---|---|---|---|
| Both time-off defects detected | 2 of 2 | – | met |
| No false-positive scenario | 2 (S4, S7) | 1 (S5) | **not met** |
| Threshold scenarios generated | 2, 3 and 4 days planned | – | met |
| Decisive threshold scenarios run | 2 days ran; 3 days deferred | – | **not met** |
| At most one unverified scenario per run | 1 | 0 | met |

## Results

| | Run A [44712842950](https://github.com/ihsansengun/ReleaseProof/actions/runs/44712842950) | Run B [44715181871](https://github.com/ihsansengun/ReleaseProof/actions/runs/44715181871) |
|---|---|---|
| Build | Time-off, 2 planted defects (PR #5) | Shop, fixed (PR #1) |
| Scenarios planned | 15: 12 runnable candidates, 3 blocked | 16: 12 runnable candidates, 4 blocked |
| Executed / passed / failed / unverified | 6 / 1 / 4 / 1 | 6 / 5 / 1 / 0 |
| Failed scenarios that are real defects | 2 (S1, S2) | 0 |
| False-positive scenarios | 2 (S4, S7) | 1 (S5) |
| Requirements | 27: 12 verified, 5 failed, 4 unverified, 4 not run (limit), 1 blocked, 1 not planned | 35: 24 verified, 1 failed, 3 unverified, 5 not run (limit), 2 blocked |
| Evidence complete (all seven parts) | 21 of 21 comparisons | 38 of 38 comparisons |
| Escalations | 5 | 3 |
| Failure counts (assertions / scenarios / patterns / evidence-backed candidates) | 7 / 4 / 4 / 0 | 1 / 1 / 1 / 0 |
| Time | 10.8 min | 9.8 min |
| Cost | $1.31 | $1.32 |

Cost by stage (US dollars):

| Run | Discover | Analyse | Plan | Execute | Escalate | Total |
|---|---|---|---|---|---|---|
| A | 0.00 | 0.28 | 0.51 | 0.04 | 0.48 | 1.31 |
| B | 0.00 | 0.36 | 0.60 | 0.05 | 0.31 | 1.32 |

Planning a pool of 12 candidates cost $0.51 and $0.60, against $0.42 and
$0.58 for the smaller plans of benchmark C. Escalation was the item that
grew: $0.48 and $0.31 against $0.20 and $0.14.

## Generation and selection (run A)

Generation and selection are separate questions.

- **Generated.** The planner wrote all three scenarios for the rule "at
  least 3 days before the first day": starting in 2 days (S1, just below),
  in exactly 3 days (S9) and in 4 days (S12).
- **Selected.** S1 was ranked first and ran. S9 and S12 were deferred. Each
  added only a threshold position, worth 2; every scenario ranked above them
  added first comparisons of two to five requirements, worth 3 each.

| Rank | Scenario | Adds |
|---|---|---|
| 1 | S1 Approved leave starting in 2 days cannot be cancelled | five requirements, just below the threshold, four risks |
| 2 | S4 Cancel a Pending request | five requirements, two risks |
| 3 | S5 The API returns the request; a second cancel is refused | five requirements |
| 4 | S2 Another employee cannot cancel | two requirements, ownership, one risk |
| 5 | S6 A manager cannot decide a Cancelled request | two requirements, one risk |
| 6 | S7 A manager sees it under Decided | two requirements, one risk |

Deferred, each listed in the report with what it would have added: S3
(refund on cancelling an Approved request), S8 (a manager cannot cancel),
S9 (exactly at the threshold), S10, S11, S12 (just above the threshold).
The report also listed, for a second requirement the planner tagged as a
threshold, that nothing was planned at or above it.

## Detection (run A)

- **Notice period counted inclusively: detected** (S1). A request starting
  in 2 days was cancelled. Status expected Approved, observed Cancelled;
  balance expected 19, observed 20.
- **Another employee can cancel a request: detected** (S2). Expected 403,
  observed 200; the request became Cancelled and the owner's balance went
  from 17 to 20.

The record behind the cross-user comparison, complete in all seven parts and
independent of the step listing:

- actor `other`, credentials entered at step 23;
- `POST /api/requests/3/cancel`, answered 200 at step 27, the body naming
  the request's owner as `s2-owner`;
- the requirement and its quoted rule;
- before: the owner's balance 17, read at step 20;
- after: status Cancelled, balance 20.

The owner is identified through the response body. The record has no
separate field for whose resource it is.

Neither defect was classed as an evidence-backed candidate. Both had
independent evidence, but the model-free repeat diverged on both.

## The three false positives

All three were created by the escalation run. In each, the first attempt
ended without a verdict, and the re-run on the escalation model recorded
one mismatch that replaced it. In each, the model's own closing note says
the mismatch was its error.

| Run | Scenario | First attempt | Escalated run | Why the mismatch is not a defect |
|---|---|---|---|---|
| A | S4 | blocked | failed: status expected `Cancelled`, read `Trip` | The status cell reads "Cancelled", the expected text, so targets naming it were refused as circular. The re-run pointed at the neighbouring Reason cell with a catch-all pattern |
| A | S7 | unverified | failed: status expected `Cancelled`, read `16` | Same cause; the re-run read the id cell |
| B | S5 | unverified | failed: subtotal at quantity 6 expected 72, read 60 | The check was made after the quantity had been reduced to 5. A check reads the live page; the first attempt had recorded 72 at the right moment and had no way to compare it later |

All three "repeat" when replayed, because the replay uses the same target at
the same moment.

## What the new rules did

| Rule | Run A | Run B |
|---|---|---|
| Target located by the expected value or text: refused | 8, all on a status cell reading the expected word; none could be resolved correctly | 7: 5 correct and resolved another way, 2 wrong ("Discount (TAKE15):" refused for an expected 15) |
| Assertion about a label pointed at something else: refused | 7; two comparisons never made | 0 |
| Ambiguous target: refused | 1; the comparison was never made | 1; retried correctly |
| Heading or label read as a value | 0 | 0 |
| Role that matches nothing while the text is shown | 0 | 0 (seven "alert" lookups found nothing and were retried) |
| Failure resting on one page reading sent for a second attempt | – | 1 (S4): the first failure was a wrong target; the second attempt passed, and the API agrees |

No refusal became a failure on the attempt that was refused. The failures
came from the next attempt choosing a different wrong element.

Unverified: run A's S6, whose "status is Cancelled" check was refused three
times and never made. None in run B.

Passes that rest on weak identification: run B's S4 final "absent" check
looked for a word in a different case than the page uses and is supported
mainly by the API reading; run B's S2 read an amount out of a whole table
by pattern.

## Causes

1. **An escalated failure replaces an inconclusive result if it repeats.**
   A wrong target, or a right target at the wrong moment, always repeats.
   This produced all three false positives.
2. **The executor sometimes has no correct way to make a check.** A cell
   whose text equals the expected text cannot be singled out, and there is
   no way to name a cell by its row and column. A check reads only the live
   page, so a value recorded earlier cannot be compared once the page has
   moved on.
3. **The circular rule matches digits inside words.**
4. **Selection weighs a threshold position below any first comparison**, so
   the scenario exactly at the threshold lost to broader ones.
5. **The model-free repeat diverges when the application assigns ids at run
   time.** Real defects then show no repeat, while a wrong locator does.
6. **The results table has eight header columns and seven separator cells**
   and does not render.

Planning and execution models are not among the causes. The planner
generated the threshold scenarios and the plan found both defects.

## Limits

- One run per build; two small applications written for this project.
- "False positive" is judged from the redacted logs and the application's
  own responses in them.
- Step listings in the job log are cut off for long scenarios; the
  per-comparison evidence is not.
