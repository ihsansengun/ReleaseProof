# Models, effort and spending limits

Which model does which part of a run, what a run may spend, and when a
scenario gets a second attempt. None of this changes what is checked:
quotes, source authority, isolation and comparisons are enforced in code
whatever model ran.

## Defaults

| Stage | What it does | Model | Effort |
|---|---|---|---|
| analyse | reads the requirement sources, writes the analysis | `claude-sonnet-5-5` | medium |
| plan | writes the scenarios and assertions | `claude-sonnet-5-5` | medium |
| discover | signs in for the application map | `claude-haiku-5-5` | low |
| execute | drives the browser through each scenario | `claude-haiku-5-5` | medium |
| escalate | re-runs a scenario that gave no trustworthy verdict | `claude-sonnet-5-5` | medium |

`claude-opus-5-5` is not used by any stage and is refused unless
`RELEASEPROOF_ALLOW_OPUS` is `on`. A request cannot choose it at all.

## Configuration

Environment variables; in CI, repository variables of the same names.

| Variable | Meaning |
|---|---|
| `RELEASEPROOF_MODEL_<STAGE>` | model for one stage: `ANALYSE`, `PLAN`, `DISCOVER`, `EXECUTE`, `ESCALATE` |
| `RELEASEPROOF_MODEL` | model for every stage not set individually |
| `RELEASEPROOF_EFFORT_<STAGE>`, `RELEASEPROOF_EFFORT` | effort: `low`, `medium`, `high`, `xhigh`, `max` |
| `RELEASEPROOF_ESCALATION=off` | never re-run a scenario on the escalation model |
| `RELEASEPROOF_ALLOW_OPUS=on` | permit `claude-opus-5-5` where a stage names it |
| `RELEASEPROOF_MAX_USD` | cost limit of a run; default $2 |
| `RELEASEPROOF_MAX_USD_<STAGE>` | cost limit of one stage; escalation defaults to two fifths of the run's limit |

A value that is not a known model or effort stops the run with an error. It
is never replaced by a default.

## What is counted, and when a run stops

Every response's uncached input, output, cache-read and cache-written tokens
are charged at the list price of the model that served it, per stage,
escalation included. `claude-haiku-5-5` has a second, dearer rate card for
prompts over 100,000 tokens; a request over that size is charged on it. A
model with no listed price is charged at the dearest known rates.

Before every model call the engine works out the most that call could cost
(the whole prompt billed as a cache write, the whole output allowance used)
and does not make it if that could pass the run's limit or the stage's. For
analysis and planning the output allowance is cut to what the remaining
budget covers. A scenario that could not finish for lack of budget is
reported as unverified.

Costs are estimates from token counts and list prices. The invoice is
authoritative.

## Escalation

After execution and the model-free repeat of failures, a scenario is re-run
once on the escalation model if its first run settled nothing:

- it ended without completing its comparisons (unverified);
- the executor reported it could not get through (blocked), after it had
  started working;
- it failed, and the repeat without a model did not reproduce the failure.

Not escalated: a failure that reproduced (it stays a failure), a scenario
that never started, and one that stopped for lack of budget.

The second run is judged by the same code. It replaces the first only if it
is conclusive: it passed on its own recorded comparisons, or it failed and
that failure reproduced. Otherwise the first result stands as it was. Every
escalation is listed in the report with the reason and both outcomes.

## Why: the cost of the Opus-only configuration

Latest run before routing (KAN-4, 6 scenarios, all stages on
`claude-opus-5-5`): $2.52, of which execution $1.73 (132 model calls, 232
tool calls, about 8,300 tokens and $0.0075 per browser interaction),
analysis and planning $0.76, discovery $0.03. Within execution: output
$0.74, cache writes $0.64 (page snapshots), cache reads $0.35 (the
conversation re-read on each call). 93% of execution input was served from
cache. The seven live runs of 19 November came to $11.44 together.

At the same token volumes the defaults above come to about $0.45 a run.
Whether the cheaper executor keeps defect detection is a matter for
measurement, not of this estimate.

Not done yet, on purpose, so that routing can be measured alone: smaller
page observations and clearing old snapshots from a scenario's context.
