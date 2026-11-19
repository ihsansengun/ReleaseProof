# Model-routing benchmark C: Opus 5.5 planning + Haiku 5.5 execution, 19 November 2026

Four live runs with the `opus-planning` preset on the same four builds as
the all-Opus baseline and benchmark A. One run per build. The question:
does putting the dearest model only where a run decides what to test keep
defect detection, at a lower cost than Opus everywhere?

**Partly.** Defect recall was 4 of 5 (baseline 5 of 5, benchmark A 3 of 5).
False-positive scenarios were 3 (baseline 0, benchmark A 3). Cost was $4.24
against $6.88, 38% lower. The target of 5 of 5 with no false positive was
not met.

- Engine: `main` at `5b89071`, which includes the reliability fixes made
  after benchmark A (declared observations, units, kept first attempts,
  diagnostics for passed scenarios). Analysis and planning
  `claude-opus-5-5` at high effort; discovery and execution
  `claude-haiku-5-5`; escalation `claude-sonnet-5-5`. Planning from scratch,
  started by hand, ticket files.
- Limits: $2 a run, $5 in total, 15 minutes; scenario limits as before.
  Spent: **$4.24**. No run hit a limit, needed a human or had a model error.
- Sources: the QA job logs with their redacted diagnostics, and the posted
  reports. Keys: `../2026-11-18/SEALED-*.md`. Earlier records:
  `../2026-11-19-routing-benchmark/`, `../2026-11-19-live/`,
  `../2026-11-19-shop-defects/`.
- The three configurations ran on three different engine versions. The
  comparison is of whole configurations, not of models alone.

## Results

| Run | Build | | Opus everywhere | Sonnet + Haiku (A) | Opus planning + Haiku (C) |
|---|---|---|---|---|---|
| 1 [44610628531](https://github.com/ihsansengun/ReleaseProof/actions/runs/44610628531) | Time-off, fixed (PR #2) | executed / passed / failed | 4 / 4 / 0 | 4 / 4 / 0 | 4 / 4 / 0 |
| | | false-positive scenarios | 0 | 0 | 0 |
| | | requirements found | 23 | 13 | 26 |
| | | scenarios planned | – | – | 10 |
| | | escalated | – | 2 | 1 (failed, then passed) |
| | | cost | $1.28 | $0.27 | $0.85 |
| 2 [44612564109](https://github.com/ihsansengun/ReleaseProof/actions/runs/44612564109) | Time-off, 2 defects (PR #5) | defects detected | 2 of 2 | 1 of 2 | **1 of 2** |
| | | executed / passed / failed | 6 / 4 / 2 | 4 / 2 / 2 | 6 / 4 / 2 |
| | | false-positive scenarios | 0 | 1 probable | **1 probable (S6)** |
| | | requirements found | 24 | 13 | 28 |
| | | scenarios planned | – | – | 10 |
| | | failures reproduced without a model | not recorded | 0 of 2 | 0 of 2 |
| | | escalated | – | 2 | 2 (first results kept) |
| | | cost | $1.54 | $0.33 | $0.95 |
| 3 [44615233517](https://github.com/ihsansengun/ReleaseProof/actions/runs/44615233517) | Shop, fixed (PR #1) | executed / passed / failed / unverified | 6 / 6 / 0 / 0 | 5 / 4 / 1 / 0 | 6 / 4 / 1 / 1 |
| | | false-positive scenarios | 0 | 1 | **1 (S1)** |
| | | requirements found | 33 | 22 | 39 |
| | | scenarios planned | – | – | 14 |
| | | escalated | – | 1 | 1 (unverified both times) |
| | | cost | $1.95 | $0.27 | $1.20 |
| 4 [44617927484](https://github.com/ihsansengun/ReleaseProof/actions/runs/44617927484) | Shop, 3 defects (PR #8) | defects detected | 3 of 3 | 2 of 3 | **3 of 3** |
| | | executed / passed / failed | 8 / 1 / 7 | 8 / 5 / 3 | 8 / 3 / 5 |
| | | false-positive scenarios | 0 | 1 | **1 (S3)** |
| | | requirements found | 33 | 21 | 34 |
| | | scenarios planned | – | – | 17 |
| | | failures reproduced without a model | 7 of 7 | 3 of 3 | 4 of 5 |
| | | escalated | – | 1 | 2 (one kept, one replaced) |
| | | cost | $2.11 | $0.26 | $1.25 |
| **All** | | defects detected | **5 of 5** | **3 of 5** | **4 of 5** |
| | | false-positive scenarios | **0** | **3** | **3** (2 confirmed, 1 probable) |
| | | cost | **$6.88** | **$1.13** | **$4.24** |

Time per run: 6.7, 7.9, 9.5 and 11.0 minutes of the 15 allowed.

## What was detected, and what was missed

- **Time-off, another employee can cancel a request: detected** (run 2, S4).
  A direct call expected 403 and received 200; the request became Cancelled
  and the owner's balance went from 17 to 20. Benchmark A missed this.
- **Time-off, notice period counted inclusively: missed.** The defect shows
  only for an Approved request starting in two days. The executed scenarios
  tried "tomorrow" and "today", both correctly refused on this build. Four
  planned scenarios were cut by the limit of six; the log does not say
  whether one of them covered the two-day boundary. Benchmark A and the
  baseline both detected this defect.
- **Shop, all three detected** (run 4): rounding to the nearest cent (S1,
  S8), a declined payment using up the code (S6), the minimum not
  re-checked after a quantity change (S4). No passed scenario should have
  failed.

## The false positives

| Run | Scenario | What was compared | Cause |
|---|---|---|---|
| 2 | S6 | Refusal message expected present, seen absent | Looked up by an "alert" role the page does not use. The refusal itself worked: status and balance unchanged. The escalated run found the message by its text, then ended unverified on another selector, so the first failure stood. Probable |
| 3 | S1 | Applied code expected `SAVE10`, read `Promo code` | The check read the section heading. Other comparisons in the scenario show the code applied. Reproduced without a model, because the repeat uses the same locator. Confirmed |
| 4 | S3 | Loyalty balance expected 416, seen 316 | The plan's formula counted a one-off 100-point welcome bonus twice. The key lists the bonus as correct behaviour. Confirmed |

Two come from how a value is located on the page; one is a wrong
expectation in the plan. In addition, run 4's S1 (a true positive) carries
one spurious comparison of the same heading kind, which marks a requirement
failed for no reason.

The two plan faults that caused benchmark A's shop false positives, a
reused observation and a cents-against-dollars comparison, did not recur.
No comparison across units was attempted in any run.

## Other observations on locating values

- A text locator for "Total:" also matches "Subtotal:". It left one scenario
  unverified (run 3, S3) and several comparisons unmade (run 4, S1). In
  each case the executor declined to compare rather than guess, and in run
  3 it refused to use a number read from an unrelated line.
- An "alert" role lookup found nothing in six scenarios across the runs.
  Four recovered by text; one was rescued by escalation (run 1, S4); one
  became the false positive above.
- Several passing comparisons locate a cell by the expected value itself
  (for example finding `$22.50` by searching for `$22.50`). That shows the
  value is somewhere on the page, not that it is in the right place.

## Do the passes test their rules?

Now checkable, since passed scenarios are in the redacted diagnostics. All
15 passed scenarios across the four runs carry comparisons that test the
rule in their title, with the weak value-located comparisons noted above.

One gap in the evidence: in both time-off runs, the step listing printed in
the job log does not show the second employee signing in before the
cross-employee call. That the caller was another employee rests on the
assertion's text, the 403 message in run 1 and the 200 with a refund in
run 2.

## Escalations

Six in four runs.

| Run | Scenario | First attempt | Escalated run | Kept |
|---|---|---|---|---|
| 1 | S4 | failed: message looked up by "alert" role | passed, by text | escalated |
| 2 | S4 | failed (the real defect), replay diverged | failed the same way | first |
| 2 | S6 | failed (false positive above) | unverified | first |
| 3 | S3 | unverified: ambiguous "Total:" | unverified | first |
| 4 | S3 | failed (false positive above), replay diverged | failed the same way | first |
| 4 | S5 | unverified: ambiguous "Total:" | passed, all 11 comparisons, by test id | escalated |

No inconclusive result became a pass without comparisons. The first
attempt's reason is now on record in every case.

## Cost by stage (US dollars)

| Run | Discover | Analyse (Opus) | Plan (Opus) | Execute (Haiku) | Escalate (Sonnet) | Total |
|---|---|---|---|---|---|---|
| 1 | 0.00 | 0.30 | 0.40 | 0.03 | 0.11 | 0.85 |
| 2 | 0.00 | 0.29 | 0.42 | 0.04 | 0.20 | 0.95 |
| 3 | 0.00 | 0.42 | 0.58 | 0.06 | 0.14 | 1.20 |
| 4 | 0.00 | 0.36 | 0.57 | 0.06 | 0.26 | 1.25 |

Analysis and planning are 74% to 84% of each run. Execution on Haiku is 4%
to 5%.

## Limits

- One run per build. Model output varies; a second run could differ. Four
  runs are evidence, not proof.
- Three engine versions across the three configurations.
- Scenario limits cut 6 to 9 planned scenarios per run. The missed defect
  may sit in a scenario that was planned and not executed.
- "Probable" marks a false positive judged from the redacted log alone.

## Found along the way, not fixed here

- Nothing checks that a locator returns the kind of thing the comparison
  is about; a heading can stand in for a value.
- A substring text locator matches labels that contain it ("Total:" in
  "Subtotal:").
- The model-free repeat replays the same locator, so "reproduced" does not
  distinguish a defect from a wrong locator.
- The failure-pattern grouping put a text mismatch in a numeric pattern
  ("off by 0.01", run 4) and labelled 403 against 200 as "off by 203"
  (run 2).
- The step listing in the job log starts late in long scenarios, which cut
  the cross-employee sign-in and call from view.
- Which planned scenarios are executed when the limit is lower than the
  plan is not ordered by risk.
