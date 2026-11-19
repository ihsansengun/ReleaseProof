# Evaluation history

Every evaluation run so far, oldest first. Figures come from the linked
records; a dash means the figure was not captured at the time, not that it
was zero. "Driver" says who did the model work:

- **bridge**: a Claude Opus subagent attached through the HTTP bridge (no
  API key was available). Token counts and cost were not measured.
- **recorded**: no model; an earlier run's decisions replayed. Not evidence
  of autonomy.
- **live**: `claude-opus-5-5` through the direct API driver.

"Readiness" applies the current rule (Ready only when nothing failed, every
documented requirement was compared, and no scenario was left blocked,
unverified or dropped) to each run, whatever its Check showed at the time.

## Whole pipeline: ticket and pull request to report

| Date | App, ticket | Build under test | Driver | Engine commit | Requirements compared | Scenarios run: passed / failed / no verdict | Planned, not run | Questions | Defects found | False positives | Tokens | Cost | Stage time: discover / analyse / plan / execute | Interventions | Readiness | Record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 18 Nov | Shop, NWG-342 | PR #1 with 3 planted defects | bridge | `b5a0702` (frozen) | 29 of 29 | 5 / 4 / 0 | 8 | 8 | 3 of 3 | 0 | – | – | 52 / 84 / 181 / 243 s | workers started by hand | Not ready | [held-out](results/2026-11-18/README.md) |
| 18 Nov | Time-off, LEAVE-58 | PR #2 with 2 planted defects | bridge | `b5a0702` (frozen) | 25 of 29 | 5 / 3 / 2 | 6 | 7 | 1 of 2 | 2 scenarios | – | – | 58 / 71 / 128 / 215 s | workers started by hand | Not ready | [held-out](results/2026-11-18/README.md) |
| 18 Nov | Both, re-run after two engine fixes | same builds | bridge | after freeze | see record | see record | – | – | 5 of 5 | 0 | – | – | – | two engine changes, logged | Not ready | [post-freeze](results/2026-11-18/README.md), [interventions](INTERVENTIONS.md) |
| 18 Nov | Time-off, LEAVE-58 | PR #2 fixed, `2151181` | recorded, in CI | `0008dd4` | – | 5 / 0 / 5 | – | – | n/a | n/a | 0 | $0 | QA job 89 s | none | Incomplete (and recorded) | [CI](results/2026-11-18-ci/README.md) |
| 18 Nov | Shop, NWG-342 | PR #1 fixed, `f724b32` | recorded, in CI | `0008dd4` | 29 of 29 | 9 / 0 / 0 | 8 | – | n/a | n/a | 0 | $0 | QA job 140 s | none | Incomplete (and recorded) | [CI](results/2026-11-18-ci/README.md) |
| 18 Nov | Time-off, LEAVE-58 | PR #2 fixed, `2151181` | live, in CI | `94afc7a` | 20 of 23 | 4 / 0 / 0 | 6 | 7 | none planted, none reported | 0 | 780,996 | $1.28 | 10.8 / 68.2 / 111.3 / 111.1 s | none | Incomplete | [live run 1](results/2026-11-19-live/README.md) |
| 19 Nov | Time-off, LEAVE-58 | PR #5, fix reverted, `9b5e9b1` | live, in CI | `94afc7a` | 18 of 24 | 4 / 2 / 0 | 5 | 6 | 2 of 2 | 0 | 878,742 | $1.54 | 11.9 / 71.5 / 128.0 / 100.1 s | none | Not ready | [live run 2](results/2026-11-19-live/README.md) |
| 19 Nov | Shop, NWG-342 | PR #1 fixed, `f724b32` | live, in CI | `48d4c3c` | 26 of 33 | 6 / 0 / 0 | 14 | 10 | none planted, none reported | 0 | 1,327,409 | $1.95 | 14.1 / 110.7 / 151.2 / 102.8 s | none | Incomplete | [live run 3](results/2026-11-19-live/README.md) |
| 19 Nov | Shop, NWG-342 | PR #8, fix reverted, `36d46d4`, 3 planted defects | live, in CI | `795a240` | 31 of 33 (15 verified, 16 failed) | 1 / 7 / 0 | 8 | 8 | 3 of 3 | 0 scenarios, 1 assertion | 1,510,656 | $2.11 | 12.1 / 95.0 / 121.7 / 156.3 s | none; an earlier attempt was cancelled by a workflow bug and not scored | Not ready | [shop defects](results/2026-11-19-shop-defects/README.md) |
| 19 Nov | Time-off, LEAVE-58 | PR #9, hostile fixture with 2 defects, `9d29870` | live, in CI | `63eda12` | 17 of 21 (14 verified, 3 failed) | 3 / 3 / 0 | 7 | 7 | 2 of 2 | 1 scenario, probable | 1,544,011 | $2.01, stopped by the $2 limit | 16.6 / 78.8 / 124.4 / 121.0 s | none; first attempt failed in set-up and was re-run | Not ready | [security](results/2026-11-19-security/README.md) |
| 19 Nov | Shop, **KAN-4 from live Jira** | PR #14, `36d46d4`, 3 planted defects | live, in CI; first run with requirement-source authority | `06f52c9` | 25 of 33 (15 verified, 10 failed) | 2 / 4 / 0 | 9 | 11 | 3 of 3 | 0 scenarios, 1 assertion, probable | 1,999,821 | $2.52 | 13.7 / 120.5 / 149.6 / 191.3 s | none | Not ready | [KAN-4 live](results/2026-11-19-kan-4-live/README.md) |

Notes:

- The live runs were capped at 4 or 6 scenarios; the cap, not the model, set
  how many ran.
- Requirement counts differ between runs of the same ticket (29, 33; 23, 24,
  29) because each run analyses the ticket afresh and splits it differently.
  Coverage percentages are therefore comparable only roughly.
- Costs are estimates from token counts and list prices.

## Executor only: fixed scenario, model chooses the steps

| Date | Apps | Driver | Runs | Verdicts correct | False failures | Missed defects | Record |
|---|---|---|---|---|---|---|---|
| 17 Nov | Shop and time-off, clean and seeded-bug builds | bridge | 10 | 10 of 10 | 0 | 0 | [runs](results/2026-11-17/README.md) |

## Model routing

| Date | Configuration | Builds | Defects detected | False-positive scenarios | Cost | Record |
|---|---|---|---|---|---|---|
| 19 Nov | Opus 5.5 everywhere (baseline) | time-off and shop, fixed and defective | 5 of 5 | 0 | $6.88 | [live](results/2026-11-19-live/README.md), [shop defects](results/2026-11-19-shop-defects/README.md) |
| 19 Nov | Sonnet 5.5 analysis and planning at medium effort, Haiku 5.5 execution, Sonnet escalation | the same four | 3 of 5 | 3 | $1.13 | [benchmark A](results/2026-11-19-routing-benchmark/README.md) |

## What the history does not yet contain

- A run that reaches Ready.
- A live re-run on a new commit.
- A live run with a Jira comment from someone who is not a requirement owner.
