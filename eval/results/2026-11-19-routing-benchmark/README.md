# Model-routing benchmark A: Sonnet 5.5 + Haiku 5.5, 19 November 2026

Four live runs with the default routing introduced that day, on the four
builds that already had an all-Opus baseline and a sealed key. One run per
build. The question: does the cheaper configuration keep defect detection?

**It does not, as configured.** Cost fell by about 84%. Defect recall fell
from 5 of 5 to 3 of 5, and false-positive scenarios rose from 0 to 3.

- Engine: `main` at `6b0a3ea`. Analysis and planning `claude-sonnet-5-5` at
  medium effort; discovery and execution `claude-haiku-5-5`; escalation
  `claude-sonnet-5-5`. Planning from scratch, started by hand, ticket files.
- Limits: $2 a run, $3 in total; scenario limits as in the baselines.
  Spent: **$1.13**.
- Sources: the QA job logs, including the redacted diagnostics, and the
  reports the workflow posted. Baselines: `../2026-11-19-live/`,
  `../2026-11-19-shop-defects/`. Keys: `../2026-11-18/SEALED-*.md`.
- The baselines were run earlier the same day on an older engine, before
  requirement precedence, the "claimed" rules and the coverage changes. The
  comparison is therefore of whole configurations, not of models alone.

## Results

| Run | Build | | Opus 5.5 everywhere | Sonnet + Haiku |
|---|---|---|---|---|
| 1 [44587164257](https://github.com/ihsansengun/ReleaseProof/actions/runs/44587164257) | Time-off, fixed (PR #2) | scenarios executed / passed / failed | 4 / 4 / 0 | 4 / 4 / 0 |
| | | false-positive scenarios | 0 | 0 |
| | | requirements found / compared | 23 / 20 | 13 / 12 |
| | | escalated | – | 2 (blocked, then passed) |
| | | cost | $1.28 | $0.27 |
| 2 [44588809626](https://github.com/ihsansengun/ReleaseProof/actions/runs/44588809626) | Time-off, 2 defects (PR #5) | defects detected | 2 of 2 | **1 of 2** |
| | | scenarios executed / passed / failed | 6 / 4 / 2 | 4 / 2 / 2 |
| | | false-positive scenarios | 0 | 1 probable (S2) |
| | | requirements found / compared | 24 / 18 | 13 / 10 |
| | | failures reproduced without a model | not recorded | 0 of 2 |
| | | escalated | – | 2 (failed again, first results kept) |
| | | cost | $1.54 | $0.33 |
| 3 [44590910608](https://github.com/ihsansengun/ReleaseProof/actions/runs/44590910608) | Shop, fixed (PR #1) | scenarios executed / passed / failed | 6 / 6 / 0 | 5 / 4 / 1 |
| | | false-positive scenarios | 0 | **1 confirmed (S3)** |
| | | requirements found / compared | 33 / 26 | 22 / 19 |
| | | escalated | – | 1 (blocked, then failed) |
| | | cost | $1.95 | $0.27 |
| 4 [44596436243](https://github.com/ihsansengun/ReleaseProof/actions/runs/44596436243) | Shop, 3 defects (PR #8) | defects detected | 3 of 3 | **2 of 3** |
| | | scenarios executed / passed / failed | 8 / 1 / 7 | 8 / 5 / 3 |
| | | false-positive scenarios | 0 | **1 (S7)** |
| | | requirements found / compared | 33 / 31 | 21 / 16 |
| | | failures reproduced without a model | 7 of 7 | 3 of 3 |
| | | escalated | – | 1 (blocked, then failed) |
| | | cost | $2.11 | $0.26 |
| **All** | | defects detected | **5 of 5** | **3 of 5** |
| | | false-positive scenarios | **0** | **3** (2 confirmed, 1 probable) |
| | | cost | **$6.88** | **$1.13** |

No run needed a human, hit a limit or had a model API error. Model time per
run was 2.8 to 4.1 minutes.

## What was missed

- **Time-off: an employee can cancel another employee's request.** A
  scenario with exactly that title (S5) passed. Its steps are not in the
  public diagnostics, which cover only scenarios that did not pass, so the
  cause is not established: either the plan's assertions did not test the
  rule, or a check was pointed at the wrong thing.
- **Shop: a declined payment uses up the promo code.** No failing scenario
  touched it. The key notes this defect needs a specific sequence (decline,
  remove the code, apply it again); the plan had 9 scenarios where the
  Opus plan had 16.

## The false positives

All three come from the plan, not from how the browser was driven.

| Run | Scenario | What was compared | Cause |
|---|---|---|---|
| 2 | S2 | Balance expected to be exactly 20, seen 18 | The plan fixed a number that depends on what the executor set up; the balance before cancelling was 16, so the refund of 2 was correct. Probable: the first comparison in the same scenario confirms the refund |
| 3 | S3 | Total 7200 against "subtotal" 4800 | The plan used one observation name for two moments. The value recorded first could not be recorded again after the quantity was restored, so the total was compared with a stale subtotal. The application's own response shows subtotal 7200, total 7200. Confirmed |
| 4 | S7 | Order total expected 2160, seen 21.6 | The plan expected cents; the checkout page shows dollars. $21.60 is the correct total. Confirmed |

Two of the three (runs 3 and 4) were produced by the escalation run on
Sonnet after Haiku was blocked, and both reproduced in the model-free
repeat. Reproducing shows that a failure repeats, not that the expectation
was right.

## Cost by stage (US dollars)

| Run | Discover | Analyse | Plan | Execute (Haiku) | Escalate (Sonnet) | Total |
|---|---|---|---|---|---|---|
| 1 | 0.00 | 0.05 | 0.05 | 0.02 | 0.14 | 0.27 |
| 2 | 0.00 | 0.05 | 0.05 | 0.02 | 0.20 | 0.33 |
| 3 | 0.00 | 0.07 | 0.06 | 0.03 | 0.11 | 0.27 |
| 4 | 0.00 | 0.07 | 0.06 | 0.03 | 0.09 | 0.26 |

Tokens: run 1 943,695; run 2 1,271,816; run 3 1,419,511; run 4 1,298,533.
Execution on Haiku is nearly free at these sizes. Escalation is the largest
item, 33% to 61% of each run.

## Where quality was lost

- **Analysis and planning were much thinner.** Sonnet at medium effort wrote
  3,400 to 4,400 output tokens of analysis; the Opus runs wrote 9,000 to
  14,000. It listed 13 to 22 documented requirements where Opus listed 23
  to 33, and planned 5 to 9 scenarios where Opus planned 10 to 20. Both
  missed defects and all three false positives trace to the plan. Model and
  effort changed together here, so the runs do not say which matters more.
- **Haiku was blocked in 6 of 21 executed scenarios** and needed escalation.
  Why is not recorded: when an escalated run replaces the first, the first
  run's reason is lost. Where the scenario was sound (run 1), Sonnet then
  passed it.
- **Escalation worked as a mechanism and was misled by the plan.** It never
  turned an inconclusive result into a pass without comparisons, and it
  left non-reproducing failures as they were. It cannot repair a plan whose
  expectation is wrong.

## What the new reporting did

- The redacted diagnostics were enough to confirm two false positives from
  the job log alone, without the evidence artifact.
- Failure patterns: run 4's four failed comparisons were grouped into three
  patterns; run 2's four into one.
- Every run reported the inferred supersession of the old notice or minimum
  rule and stayed short of "Ready" on it, as designed.

## Limits

- One run per build. Model output varies; a second run could differ.
- The baselines used an older engine.
- Whether Opus's higher scenario counts, rather than its plans' quality,
  explain its recall cannot be separated here.
- The cause of the pass on run 2's S5 is unknown.

## Found along the way, not fixed here

- An observation name cannot be recorded twice, and the planner is not told
  to name each moment separately (run 3).
- Nothing checks that an expected number and the value read are in the same
  unit (run 4).
- An escalated run that replaces the first discards the first run's reason.
- The posted report still ends "Full report, steps and screenshots" although
  only sanitised evidence is uploaded.
