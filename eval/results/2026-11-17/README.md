# Model-driven execution runs, 17 November 2026

Ten runs in which a model that had never seen the application drove a test
scenario from a high-level objective. It was given no routes, no selectors and
no steps: only the objective, the assertions fixed in the plan, the prepared
test accounts and the environment's declared integrations.

## How these runs were driven

The steps were chosen by a Claude Opus subagent attached through the engine's
HTTP bridge (`releaseproof serve-scenario`). The bridge serves the same
instructions, briefing and tool definitions as the built-in loop and shares
all code that executes tools, compares values and computes verdicts. Each
subagent was restricted to HTTP calls to the bridge and told not to read any
file; that restriction is an instruction, not a sandbox.

The built-in loop that calls the model API directly (`execute/loop.ts`) was
not used, because no API credential was available in the build environment.
These runs therefore do not exercise the API request itself.

## Results

"Seeded bug" builds were made by a one-line change kept outside the repo:
App A grants the first-purchase bonus on every purchase; App B deducts days
for a rejected request as well as an approved one.

| Run | App | Build | Verdict | Correct | Tool calls | Tool errors | Time |
|---|---|---|---|---|---|---|---|
| [A-clean-1](A-clean-1/report.md) | A retail | clean | passed | yes | 27 | 1 | 73 s |
| [A-bug-1](A-bug-1/report.md) | A retail | seeded bug | failed (136 expected, 236 actual) | yes | 27 | 0 | 76 s |
| [A-clean-2](A-clean-2/report.md) | A retail | clean | passed | yes | 21 | 0 | 61 s |
| [A-bug-2](A-bug-2/report.md) | A retail | seeded bug | failed (183 expected, 283 actual) | yes | 24 | 1 | 70 s |
| [A-clean-3](A-clean-3/report.md) | A retail | clean | passed | yes | 23 | 0 | 71 s |
| [A-bug-3](A-bug-3/report.md) | A retail | seeded bug | failed (136 expected, 236 actual) | yes | 22 | 0 | 72 s |
| [B-clean-1](B-clean-1/report.md) | B time off | clean | passed | yes | 37 | 0 | 75 s |
| [B-bug-1](B-bug-1/report.md) | B time off | seeded bug | failed (17 expected, 15 actual) | yes | 36 | 0 | 76 s |
| [B-clean-2](B-clean-2/report.md) | B time off | clean | passed | yes | 35 | 0 | 67 s |
| [B-bug-2](B-bug-2/report.md) | B time off | seeded bug | failed (17 expected, 15 actual) | yes | 35 | 0 | 51 s |

10 of 10 verdicts correct; no false failures on clean builds and no missed
defects on seeded-bug builds. Ten runs is a small sample: it shows the
approach works, not what its error rate is.

Runs differed in what the model chose to do (which items it bought, which
dates it requested, which locators it used), and the verdicts held across
those differences.

Round 1 (A-clean-1, A-bug-1) ran before intervention #4 in
`../../INTERVENTIONS.md`; both drivers worked around stale page results by
re-navigating. Later rounds reported no stale pages.

## Model-free confirmation of the failures

Each failing run's recorded steps were replayed with no model.

| Run | Replay result |
|---|---|
| A-bug-1, A-bug-2, A-bug-3 | Failure reproduced, same values |
| B-bug-1, B-bug-2 against the same running instance | Replay diverged, reported as unverified. The app numbers its requests, the number is part of the button name, and the numbers had moved on |
| B-bug-1 against a freshly started instance | Failure reproduced (17 expected, 15 actual) |

Replay is only valid against an environment in the same starting state as the
recording. CI starts a fresh instance per run, which satisfies that. When it
does not hold, the engine says so instead of confirming.

## What each folder holds

`report.md` (objective, assertions, every step with the model's stated
reason), `result.json` (the same, machine-readable, replayable), one
screenshot per check with the compared element outlined, and for A-bug-3 and
B-bug-1 the Playwright trace.
