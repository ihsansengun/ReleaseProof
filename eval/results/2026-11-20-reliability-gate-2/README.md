# Reliability gate, second attempt, 20 November 2026

The gate of earlier the same day (`../2026-11-20-reliability-gate/`) failed
on three false-positive scenarios and an unrun threshold case. After four
engine changes it was repeated unchanged on the same two builds.

**The gate passed.** Both planted defects were found, no scenario failed on
correct behaviour, the scenarios just below and exactly at the notice
threshold ran, and at most one scenario per run ended without a verdict.

It is one run per build on two small applications written for this project.
It is evidence that the specific causes of the earlier failure are gone, not
proof of reliability elsewhere.

- Engine: `main` at `8859390`. Preset `opus-planning`: analysis and planning
  `claude-opus-5-5` at high effort, discovery and execution
  `claude-haiku-5-5`, escalation `claude-sonnet-5-5`. Planning from scratch,
  started by hand, ticket files, six scenarios each.
- Limits: $2 a run, $4 in total, 15 minutes. Spent: **$2.98**. No run needed
  a human or had a model error. Run B's escalation was stopped by the $2
  limit.
- Changes since the first attempt: an escalated failure needs evidence
  beyond one page reading to replace a result; targets by row and column
  and by label; assertions about recorded observations; threshold-first
  selection; two corrections.
- Sources: the QA job logs with their redacted diagnostics, and the posted
  reports. Key: `../2026-11-18/SEALED-timeoff.md`. The evidence artifacts
  could not be read from where this record was written, so the planner's
  validation notes for run B are not included.

## The gate

| Criterion | First attempt | This attempt |
|---|---|---|
| Both time-off defects detected | 2 of 2 | 2 of 2 |
| No false-positive scenario | **3** (A: S4, S7; B: S5) | 0 |
| Threshold scenarios generated | yes | yes |
| Just-below and exactly-at scenarios run | 2 days only | 2 days and 3 days |
| At most one unverified scenario per run | 1 and 0 | 0 and 1 |
| Result | failed | **passed** |

## Results

| | Run A [44733066723](https://github.com/ihsansengun/ReleaseProof/actions/runs/44733066723) | Run B [44735855564](https://github.com/ihsansengun/ReleaseProof/actions/runs/44735855564) |
|---|---|---|
| Build | Time-off, 2 planted defects (PR #5) | Shop, fixed (PR #1) |
| Scenarios planned | 18: 12 runnable candidates, 6 blocked | 19: 12 runnable candidates, 7 blocked |
| Executed / passed / failed / unverified | 6 / 4 / 2 / 0 | 6 / 5 / 0 / 1 |
| Failed scenarios that are real defects | 2 (S1, S2) | – |
| False-positive scenarios | 0 | 0 |
| Requirements | 29: 13 verified, 4 failed, 3 unverified, 7 not run (limit), 1 blocked, 1 not planned | 39: 29 verified, 4 blocked, 6 not run (limit) |
| Evidence complete (all seven parts) | 20 of 20 comparisons | 37 of 37 comparisons |
| Comparisons made against a recorded observation | 13 of 20 | 23 of 37 |
| Targets by row and column | 11 uses, all resolved to one cell | 3 uses: 2 resolved, 1 malformed call |
| Targets by label | 2 uses, both refused, both retried by text | 11 uses, all refused, all retried by text |
| Escalations | 2, first results kept | 1, first result kept |
| Time | 8.3 min | 11.2 min |
| Cost | $1.14 | $1.84 |

Cost by stage (US dollars), with the first attempt in brackets:

| Run | Analyse | Plan | Execute | Escalate | Total |
|---|---|---|---|---|---|
| A | 0.31 (0.28) | 0.61 (0.51) | 0.04 (0.04) | 0.18 (0.48) | 1.14 (1.31) |
| B | 0.44 (0.36) | 1.28 (0.60) | 0.05 (0.05) | 0.07 (0.31) | 1.84 (1.32) |

The two runs together cost $2.98 against $2.63. Escalation fell from $0.79
to $0.25. Planning rose from $1.11 to $1.89, almost all of it in run B,
where the planner was called twice: its first plan had faults the validator
found and it was sent back once to repair them. What the faults were is in
the artifact's notes, which were not readable here.

## Thresholds (run A)

- **Generated:** an Approved request starting in 2 days (S2), in exactly 3
  days (S7) and in 4 days (S12).
- **Selected:** S2 at rank 1 and S7 at rank 2, both taken first as threshold
  scenarios. S12 was deferred and reported as planned and not run.
- A third threshold slot went to S9, "a Pending request starting today can
  still be cancelled", which the planner labelled "just below the
  threshold". A Pending request has no notice threshold. The slot was taken
  from breadth on a wrong label; the validator can only check that the
  scenario compares the requirement it names, and it did.

In run B both threshold scenarios of the $60.00 minimum ran: exactly $60.00
(rank 1) and $59.50 (rank 2). The scenario at $60.99 was deferred.

## Detection, and what stands behind it (run A)

| Defect | Scenario | Comparisons | Evidence independent of the replay |
|---|---|---|---|
| Another employee can cancel a request | S1 | API status expected 403, was 200; owner's balance from the API expected 18, was 20; status cell expected Approved, read Cancelled | Two readings of the application's own responses and one page reading by row and column agree. Actor `intruder`, the request, its response and the after-state are on record, 7 of 7 parts |
| Notice period counted inclusively | S2 | Status cell expected Approved, read Cancelled; balance from the API expected 19, was 20 | The API accepted the cancel of a request starting in 2 days; the escalated attempt read the same cell through a different row identifier and saw the same |

Both defects have evidence that does not rest on the replay. The report
nevertheless shows **0 evidence-backed defect candidates**: that label also
requires the model-free repeat to reproduce the failure, and both repeats
diverged, because the application assigns new request ids on each run. The
label under-states what was found. This is the one cause from the first
attempt that was not addressed.

## What the new mechanisms did

- **Row and column.** Every status check in run A went through a cell
  target, including the kind that produced two false positives before. In
  run B the order's total and discount were read from the account table by
  row and column.
- **Label.** All 13 uses were refused. The pages show label and value in one
  line ("Days remaining: 20", "Subtotal: $60.00"), which is neither a term
  with its item nor a header with its cell. Each was retried by text with a
  pattern and read correctly. The target as built does not fit the most
  common layout in these two applications.
- **Observations.** 36 of 57 comparisons were made against a value recorded
  at its own moment. No check was pointed at the live page for one of them.
  The first attempt's own case, a subtotal before a quantity change, was not
  exercised: that scenario was deferred in run B.
- **Escalation rule.** No escalated failure replaced a result. In run A both
  escalations re-ran the two real failures because their replays diverged;
  both failed the same way and the first results stood. In run B the one
  escalation was stopped by the cost limit.
- **Circular rule.** No refusal in either run's visible log, and none on a
  code name.

## The one scenario without a verdict (run B, S9)

"A used code is refused for the same customer but still works for another
customer." Two of its three comparisons matched. The third expects the
refusal message, in full, on the page.

- The first attempt did not find a way to name the alert without quoting the
  whole expected message, and left it unchecked.
- The escalated attempt looked it up by an "alert" role with the message as
  its name, found nothing, and was then stopped: the run had spent $1.84 of
  its $2.
- A correct way existed. The circular rule refuses only a locator that
  contains the whole expected text; a fragment of the message is allowed,
  and another scenario in the same run (S2) did exactly that.

Cause: the executor gave up where a fragment would have worked, and the
budget, most of it spent on planning twice, cut the second attempt short.
The requirement behind it counts as verified through the scenario's other
comparison.

## Weak passes

- Run B, S1: a discount was read from "Discount (TAKE15): -$15.00" with a
  pattern that captures the first number in the line, which is the 15 inside
  the code name. It would have read 15 whatever the discount was. The API
  comparison of the same amount in the same scenario is sound and matched.
- Run B, S1: a unit price was located by its own text.
- Run A, S4: a count of zero rows within a region cannot tell an absent row
  from a wrong region; two other comparisons place the row elsewhere.
- Several absence checks in run B are backed by API values.

None of these turns a wrong application into a pass in these runs. Each is a
comparison that could.

## Not run because of the limit

- Run A: seven requirements are compared only by deferred scenarios (R1,
  R3, R5, R20, R26, R27, R28): cancelling a Pending request from the list, a
  manager being unable to cancel, and three details of the API. The 4-day
  scenario was deferred too.
- Run B: six requirements (R7, R8, R15, R19, R20, R32): code entry in other
  cases and with spaces, an unknown code, removal of the code when the
  quantity drops, and loyalty points. The $60.99 scenario was deferred.

Threshold-first selection is part of why: three of six slots in run A went
to threshold scenarios, one of them on a wrong label.

## Other observations

- "Thresholds left untested" is noisy. It lists a position as never planned
  for each requirement a threshold scenario was tagged with, even where a
  sibling requirement's scenario ran at that position.
- Run A leaves two requirements "unverified" that the failed scenarios
  directly violate, because their own comparison was not the one that
  failed.
- The step listing in the job log still shows only late steps of long
  scenarios; the per-comparison evidence does not depend on it.
- The report lists its own comment under "Approval commands" as refused.
- The results table renders.

## Limits

- One run per build. Model output varies; run B's planning cost more than
  doubled between two runs of the same build on the same day.
- Two small applications written for this project, whose pages the engine's
  recent changes were shaped around.
- "False positive" is judged from the redacted logs and the application's
  own responses in them.
- Run B came within $0.16 of its cost limit.
