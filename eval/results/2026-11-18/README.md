# Requirements-to-execution evaluation, 18 November 2026

Two feature tickets and their pull requests, never seen by the pipeline or
its author before the pipeline was frozen, were run through the whole
workflow: ingest → discover → analyse → plan → execute → report → retest.

## Set-up

- **Held-out material.** An isolated agent with no access to the pipeline
  chose and implemented one feature per demo app, wrote a Jira-format ticket
  with deliberately missing rules, and planted defects recorded in a sealed
  answer key (`SEALED-shop.md`, `SEALED-timeoff.md`, opened only after both
  runs finished).
- **Freeze.** The pipeline was frozen at commit `b5a0702` before the tickets,
  diffs or answer keys were looked at.
- **Inputs.** Tickets as Jira REST JSON files (`eval/tickets/NWG-342.json`,
  `LEAVE-58.json`). Pull requests
  [#1](https://github.com/ihsansengun/ReleaseProof/pull/1) and
  [#2](https://github.com/ihsansengun/ReleaseProof/pull/2), read through the
  GitHub REST API. Each app was built and started from the pull request's
  head commit; the pipeline refuses to run against any other commit.
- **Model.** Every model call (sign-in for discovery, analysis, planning,
  each scenario) was made by a separate Claude Opus subagent attached through
  the HTTP bridge, one fresh subagent per job. The direct API driver was not
  run: no API credential was available.

## Results with the frozen pipeline

| | Shop: promo codes (NWG-342) | Time-off: cancel requests (LEAVE-58) |
|---|---|---|
| Acceptance criteria in the ticket | 7 | 7 |
| Documented requirements extracted (each with a verified quote) | 29 | 29 |
| Inferred requirements (never used as an expectation) | 6 | 4 |
| Quotes rejected by the mechanical check | 0 | 0 |
| Scenarios planned: runnable / blocked on a question | 9 / 8 | 10 / 6 |
| Assertions planned / removed by validation | 63 / 0 | 40 / 0 |
| Scenarios executed: passed / failed / blocked | 5 / 4 / 0 | 5 / 3 / 2 |
| Assertions compared against the application | 63 | 36 |
| Documented requirements compared | 29 of 29 | 25 of 29 |
| **Planted defects detected** | **3 of 3** | **1 of 2** |
| **False-positive scenarios** (failed, behaviour correct) | **0** | **2** |
| Deliberately missing rules raised as questions | 2 of 2 | 2 of 2 |
| Expectations invented or taken from the code | 0 found | 0 found |
| Clarification requests raised | 8 | 7 |
| Stage time: discover / analyse / plan / execute | 52 / 84 / 181 / 243 s | 58 / 71 / 128 / 215 s |
| Total, including confirmation replays | 9.9 min | 8.2 min |
| Tool calls in execution (tool errors) | 349 (15) | 243 (0) |

Times include queueing: each job waited for a subagent to poll for it (up to
15 s) and, between stages, for workers to be launched by hand. They are upper
bounds for this set-up, not a measure of the pipeline.

### What was found

Shop, all three planted defects:
- A percentage discount is rounded to the nearest cent, where the ticket says
  to round down (S1: $2.50 on $24.99, expected $2.49; S5: $13.00 on $129.95,
  expected $12.99, carried into the stored order). The expected values came
  from the ticket; the code's own rounding was not adopted.
- The fixed-amount code stays applied after the cart falls below its minimum
  (S3: $15.00 still deducted at a $48.00 subtotal).
- A declined payment uses up the code (S7: re-applying it is refused as
  "already used", and the later paid order gets no discount).

Time-off:
- Detected: an employee can cancel another employee's approved request
  through the API (S3: 200 where 403 is required; the owner's balance was
  refunded).
- **Missed:** approved leave starting in two days can be cancelled, where the
  ticket requires three days' notice. The analysis flagged this as a risk
  from the diff and the plan contained the right scenario (S8), but the
  executor had no source for today's date and correctly reported it as
  blocked. S10 was blocked for the same reason.

### False positives

Two time-off scenarios (S1, S2; three assertions) failed although the
behaviour is correct. The assertions were about a button's accessible name;
the check tool could only read visible text and compared "Cancel" with a
date. One root cause, in the engine.

### What the plans did with the ambiguity traps

- The ticket descriptions were contradicted by later comments ($50 → $60
  minimum; "any time" → three days' notice). Both analyses followed the
  later comment and quoted it.
- All four deliberately missing rules became blocked scenarios with a
  question (second code applied over the first; emptied cart; cancelling a
  rejected request through the API; which "today" counts).
- Where a rule was only partly stated, plans asserted the stated part: a
  bound for "codes do not stack", two customers charged the same amount to
  test points without an undocumented points rule.

### Model-free confirmation was not a reliable signal

| Failure | Real defect? | Replay result |
|---|---|---|
| Shop S1, S3, S5, S7 | yes | reproduced |
| Time-off S3 | yes | replay diverged (the app's request numbers had moved on) |
| Time-off S1 | no (false positive) | reproduced |
| Time-off S2 | no (false positive) | replay diverged |

A replay repeats the same comparison against the same element, so it
confirms repeatability, not correctness. It should not be presented as
confirmation that a failure is a defect.

## Retest after the fix

The fix commits were pushed to the pull requests and the apps restarted on
the new head commits.

- **Shop, frozen pipeline:** all 9 scenarios pass on the fixed build. Six by
  replay with no model; three (S1, S3, S5) by a model re-run because their
  recorded locators contained the old, wrong amounts. No false failures.
  See `retest-shop/retest.md`.
- **Time-off:** only the two defect scenarios were retested, with the
  post-freeze engine. S8 passes on the fixed build (cancellation refused
  with the three-day message). S3 was not retested: the subagent's own
  permission check refused one of its tool calls, and the run was not
  repeated around that refusal. The fix for that defect is therefore
  unverified here.

## Changes made after the freeze

Two, both to the engine, both generic, both prompted by the time-off run:

1. Check and observe targets can read an element's accessible name.
2. The executor's briefing includes the application server's current date,
   read from its response headers.

With these, the four affected time-off scenarios were re-run on the
defective build (`post-freeze-reruns/`): S1 and S2 pass, S10 passes, and S8
fails with the missed defect (expected Approved and 19 days, got Cancelled
and 20). Counting those re-runs, time-off stands at 2 of 2 defects and no
false positives, but that figure is no longer a held-out result.

## Human interventions

- In the pipeline's decisions (requirements, plans, expectations, verdicts):
  none. No plan or scenario was edited, and no run was steered.
- Operational, outside the pipeline: installing dependencies in the pull
  request checkout before the shop would build, starting and restarting the
  apps, and launching one subagent per queued job.
- One executor (time-off S7) worked around the missing date by reading the
  job queue's own response header. Its result is valid on this machine, but
  two other executors given the same instruction declined to, so behaviour
  under a missing capability was not uniform.

## What this does and does not show

- It shows the workflow running end to end on two unseen features in two
  domains with one pipeline commit, with every expectation traced to quoted
  ticket text.
- Two features and five defects is a demonstration, not a measurement.
- The features were written by the same model family that tested them. A
  ticket written by a person would be a harder and fairer test.
- Verified live: GitHub pull-request ingestion. Not verified: Jira's REST
  API (tickets came from files in its format) and the direct model API
  driver.
- Secrets: fixture passwords reached no model and appear in no stored
  result, report or log (checked by search). Playwright traces do capture
  typed values and are not committed.
- Known engine gaps seen in these runs and not yet addressed: text locators
  match substrings ("Total:" also matches "Subtotal:"), which cost retries;
  replay breaks on app-generated identifiers and on locators that embed
  values.

## Folders

- `heldout-shop/`, `heldout-timeoff/` — the frozen runs: `report.md` (the QA
  report), `run.json`, `analysis.json`, `plan.json`, `appmap.json`,
  `context.json`, and one folder per scenario with steps and screenshots.
- `retest-shop/` — the retest on the fixed build.
- `post-freeze-reruns/` — the five scenario runs made after the engine changes.
- `dev-timeoff/` — the last development run before the freeze, on an
  existing ticket.
