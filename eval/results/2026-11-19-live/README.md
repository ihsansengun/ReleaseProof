# Live model runs in CI, 18–19 November 2026

The first runs in which a live model, called through the direct API driver,
did the analysis, planning and execution inside GitHub Actions. All were
started manually from `main`, with `claude-opus-5-5`, planning from scratch:
runs 1 and 2 on the time-off app at `94afc7a`, run 3 on the shop at
`48d4c3c`.

Sources for every figure here: the run logs and the comments the workflow
posted, saved as [comment-pr2.md](comment-pr2.md) and
[comment-pr5.md](comment-pr5.md). The evidence artifacts (steps, screenshots,
`run.json`) are on the run pages for 14 days; they could not be downloaded
into the environment these notes were written in, so nothing below comes
from them.

## Run 1: live path on a correct build

[QA run 44408691152](https://github.com/ihsansengun/ReleaseProof/actions/runs/44408691152)
on [pull request #2](https://github.com/ihsansengun/ReleaseProof/pull/2) at
`2151181`, the fixed commit. Limits: $2.50, 4 scenarios, 15 minutes.

- Check: success, "0 failed, 4 passed, 0 not verified".
- 4 scenarios run (the cap), 6 blocked on open questions, 7 questions raised.
- 20 of 23 documented requirements compared.
- No defect expected and none reported; no false positive.

## Run 2: defect detection

[QA run 44497928492](https://github.com/ihsansengun/ReleaseProof/actions/runs/44497928492)
on [pull request #5](https://github.com/ihsansengun/ReleaseProof/pull/5) at
`9b5e9b1`: the same feature with its fix commit reverted, which restores the
two defects in the sealed key (`../2026-11-18/SEALED-timeoff.md`). Limits:
$3.00, 6 scenarios, 15 minutes.

- Check: **failure**, "2 failed, 4 passed, 0 not verified (autonomous)".
- 6 scenarios run (the cap), 5 blocked on open questions, 6 questions raised.
- 18 of 24 documented requirements compared.

| Planted defect | Result | What the run recorded |
|---|---|---|
| An employee can cancel another employee's request | Detected (S2) | Expected 403, got 200; the request became Cancelled where it should stay Approved; the owner's balance went from 18 back to 20 |
| Approved leave starting in two days can be cancelled | Detected (S3) | After Cancel on a request starting today+2, the required refusal message was absent |

- False positives: none. The four passing scenarios cover behaviour the key
  lists as correct.
- Each failure quotes the ticket text it rests on. The notice-period failure
  cites the later comment ("today + 3 is fine, today + 2 is not"), not the
  description it supersedes.
- Caveat: the second detection rests on one "message is present" assertion.
  The planner blocked the stronger checks (request stays Approved, balance
  unchanged) as an open question about the later comment. The finding
  matches the key, but an absent-element check is the kind a wrong locator
  could also produce.
- The two failures were replayed without a model (12 s). The outcome of
  that replay is in the artifact's `run.json` and is not shown in the
  comment or the log, so it is not reported here.

## Run 3: live path on the shop, correct build

[QA run 44500644918](https://github.com/ihsansengun/ReleaseProof/actions/runs/44500644918)
on [pull request #1](https://github.com/ihsansengun/ReleaseProof/pull/1) at
`f724b32`, the fixed commit of the promo-code feature (ticket `NWG-342`).
Limits: $3.00, 6 scenarios, 15 minutes.

- Check as posted: success, "0 failed, 6 passed, 0 not verified (autonomous)".
- 6 scenarios run (the cap), 14 planned scenarios blocked on open questions,
  10 questions raised.
- 26 of 33 documented requirements compared; 7 were never compared.
- No defect expected and none reported; no false positive.

**The green Check was misleading.** Nothing that ran failed, but seven
documented requirements were untested and fourteen scenarios never started.
Under the readiness rule introduced after this run (see
[docs/CI-SECURITY.md](../../../docs/CI-SECURITY.md), "Result semantics"), the
same result is reported as **Incomplete** with a neutral Check. Run 1 would
also be Incomplete (20 of 23 requirements, 6 scenarios blocked).

| | Run 3 |
|---|---|
| Model calls | 111 |
| Tool calls | 200 |
| Input tokens, uncached | 25,805 |
| Cache-read tokens | 1,137,851 |
| Cache-write tokens | 110,393 |
| Output tokens | 53,360 |
| Total tokens | 1,327,409 |
| Estimated cost | $1.95 of $3.00 |
| Discover / analyse / plan / execute | 14.1 / 110.7 / 151.2 / 102.8 s |
| Whole QA job, with install | 441 s |
| Model API errors after retries | none |
| Stopped by the budget | no |
| Human interventions | none |
| Isolation probe | ok; 11 environment variables, none a credential |

Per-stage token counts were not printed by the workflow at the time and the
artifact could not be downloaded, so they are not recorded for runs 1 to 3.

## Usage, cost and time, runs 1 and 2

| | Run 1 | Run 2 |
|---|---|---|
| Model calls | 76 | 92 |
| Tool calls | 137 | 175 |
| Input tokens, uncached | 17,612 | 17,346 |
| Cache-read tokens | 660,345 | 728,517 |
| Cache-write tokens | 65,482 | 88,891 |
| Output tokens | 37,557 | 43,988 |
| Total tokens | 780,996 | 878,742 |
| Estimated cost | $1.28 of $2.50 | $1.54 of $3.00 |
| Discover | 10.8 s | 11.9 s |
| Analyse | 68.2 s | 71.5 s |
| Plan | 111.3 s | 128.0 s |
| Execute | 111.1 s | 100.1 s |
| Replay of failures | none | 11.8 s |
| Pipeline total | about 5.0 min | about 5.4 min |
| Whole QA job, with install | 378 s | 381 s |
| Model API errors after retries | none | none |
| Stopped by the budget | no | no |
| Human interventions | none | none |

The cost is an estimate from token counts and list prices; the cache-write
price used is an assumption. The provider's invoice is authoritative.

## What these runs establish

- The direct API driver works against the live API as written, including
  the structured-output schema and the fallback parameters. No request was
  rejected and no retry with fallbacks disabled was needed.
- With a real key on the runner, the isolation probe still found no
  credential in the application container (10 variables, all declared),
  no outbound network and a read-only filesystem.
- The live path detects real defects from a ticket and a pull request, and
  turns the Check red with quoted requirements.
- A run of this size costs about $1.30–1.55 and takes about 6.5 minutes of
  job time. Around 85% of tokens are cache reads.

Compared with the bridge-driven evaluation of the same ticket: the plans
have the same shape, the later ticket comment is followed in both, the
accessible-name false positives did not recur, and date-relative scenarios
ran because the server date is now in the briefing.

## What they do not establish

- Three runs, one of them on the shop. No live defect-detection run on the
  shop yet.
- No live run hit a budget limit, so budget enforcement is still shown only
  against the stand-in API.
- No re-run after a new commit with a live model.
- Retries that succeeded inside the SDK are not visible in the run record.
- No adversarial pull request has been run.

## Earlier attempt

[QA run 44406153571](https://github.com/ihsansengun/ReleaseProof/actions/runs/44406153571)
was meant to be the first live run but found no API key and used recorded
responses. It posted a neutral Check titled "Recorded replay, not an
autonomous run", which is the behaviour asked for, and applied the requested
limits. A pull-request-triggered build from the same period was not tested,
because `RELEASEPROOF_AUTO_TRIGGER` is not set.
