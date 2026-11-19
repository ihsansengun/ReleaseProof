# CI integration: verified results, 18 November 2026

Real GitHub Actions runs of the three-stage workflow, started manually
against the two fixture pull requests. Design and trust boundaries:
[docs/CI-SECURITY.md](../../../docs/CI-SECURITY.md).

## Runs

| # | Pull request | Build run | QA run | Model | Result posted |
|---|---|---|---|---|---|
| 1 | [#2](https://github.com/ihsansengun/ReleaseProof/pull/2) time-off, `2151181` | [44390195815](https://github.com/ihsansengun/ReleaseProof/actions/runs/44390195815), 45 s | [44390342533](https://github.com/ihsansengun/ReleaseProof/actions/runs/44390342533), 89 s | recorded | Check neutral: 0 failed, 5 passed, 5 not verified |
| 2 | [#1](https://github.com/ihsansengun/ReleaseProof/pull/1) shop, `f724b32` | [44390666101](https://github.com/ihsansengun/ReleaseProof/actions/runs/44390666101), 96 s | [44390955618](https://github.com/ihsansengun/ReleaseProof/actions/runs/44390955618), 140 s | recorded | Check success: 0 failed, 9 passed |
| 3 | #1 shop again, same commit | [44391432071](https://github.com/ihsansengun/ReleaseProof/actions/runs/44391432071) | [44391713969](https://github.com/ihsansengun/ReleaseProof/actions/runs/44391713969) | recorded | Same result, as a re-run of the earlier plan; comment updated in place |

All three ran from `main` at `0008dd4`, the merge of pull request #3. No
workflow fix was needed after that merge.

**"Recorded" means no live model was used.** The `ANTHROPIC_API_KEY` secret
was not present when these ran, so the runs replayed the analysis, plan and
browser steps from the held-out evaluation. The browser actions and every
comparison were executed for real against the application built from the
pull request's commit; what was not exercised is a model deciding anything.

## An unplanned fourth run, and what it showed

Opening pull request [#4](https://github.com/ihsansengun/ReleaseProof/pull/4),
which adds the `pull_request` trigger, started the build workflow by itself:
GitHub takes that workflow file from the pull request, so the pull request
activated its own trigger. The QA stage on `main` then ran for it
([44392466061](https://github.com/ihsansengun/ReleaseProof/actions/runs/44392466061)),
accepted the build after checking its commit against the event and GitHub's
API, found that the pull request changes no application, and posted a
neutral Check.

- It shows the automatic path working end to end, including the provenance
  checks for a pull-request build.
- It also shows that keeping the trigger off `main` was not a real gate. The
  gate is now a repository variable read by the QA stage on `main`
  (`RELEASEPROOF_AUTO_TRIGGER`), which takes effect once that change is on
  `main`. Until then, any same-repository pull request that adds the trigger
  to its own copy of the build workflow will be tested. Fork pull requests
  are still skipped by the QA stage.
- Skipped runs no longer post a comment, only the Check.

## Against the acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A real Actions run starts against an approved pull request | Verified | Runs above, started with `workflow_dispatch` |
| 2 | ReleaseProof identifies the requirements and analyses the pull request | **Not verified live** | The ticket was resolved from the pull request title and the diff read through GitHub's API, but the analysis shown is the recorded one |
| 3 | Scenarios execute against the correct commit | Verified | Commit carried from checkout to image label to metadata, checked against GitHub's API, and reported back by the application; each comment states the commit |
| 4 | Real test evidence is produced and stored | Verified | `releaseproof-evidence` artifact on each QA run: report, per-scenario steps, 56 files including screenshots for run 1; 14-day retention |
| 5 | GitHub receives an accurate QA report | Verified | Check run "ReleaseProof QA" and one comment on each pull request, matching `run.json` |
| 6 | A new commit triggers another run | **Partly verified** | A pull-request event started a run automatically (the fourth run above), and a later push to that pull request started another. Neither tested an application, because that pull request changes none. Run 3 shows the re-run logic for an application when started by hand |
| 7 | Pull-request code cannot reach privileged credentials | Verified for the cases probed | See below |
| 8 | Cost, time and intervention metrics are recorded | Verified, with zero model cost | Each report states cost, tokens, model calls, tool calls and minutes against the limits; with a recorded driver these are all zero apart from time |
| 9 | Both applications work through the same integration | Verified | Runs 1 and 2 use the same workflows and engine commit; the shop is installed and built inside its image, the time-off app needs no build |

## Isolation, as measured in the runs

From inside the application container, on GitHub's runners, in every run:

- Outbound network: blocked
- Root filesystem: read-only
- User id: 10001
- Environment: 10 variables (time-off) and 11 (shop): the ones each
  manifest declares, the commit, and the base image's own. No token, key or
  secret among them; a variable outside the expected set fails the run.

By construction, checked by reading the workflows and not by a test:

- The build workflow references no secret and has a read-only token.
- The QA and report jobs run from `main` through `workflow_run`.
- The model key is in the environment of one step of the QA job. In these
  runs it was empty, so "the key never reaches the container" is shown by
  the probe's variable list and the explicit container environment, not by
  a run in which a key was present.

Not tested: a deliberately hostile pull request (one that tries to escape
the container, tamper with the artifact or poison the report). The schema,
provenance and escaping checks are unit-tested; no adversarial run was made.

## What the time-off result shows about recordings

Run 1 ended neutral, which is the right outcome for what was known:

- 5 scenarios passed by replay, including the one that had failed on the
  defective build (one employee cancelling another's request now gets 403).
  That closes the retest left unverified in the previous milestone.
- 2 diverged, because their recorded steps name request numbers that depend
  on the order scenarios ran in.
- 3 had no usable recording (their steps contained dates relative to the day
  they were recorded) and are listed as blocked.

None of these were reported as passes or failures.

## Metrics

| | Run 1 (time-off) | Run 2 (shop) | Run 3 (shop re-run) |
|---|---|---|---|
| Build stage | 45 s | 96 s | about 95 s |
| QA and report stages | 89 s | 140 s | about 140 s |
| Pipeline time inside QA | 0.3 min | 0.7 min | 0.7 min |
| Model cost | $0 (recorded) | $0 (recorded) | $0 (recorded) |
| Human interventions | none | none | none |

## Direct API driver

- Tested against a local stand-in for the model API, with the real SDK:
  request shape, tool loop, retry on overload (one failed attempt, then
  success), giving up after four retries, refusal, bad credentials stopping
  the run, structured output parsing, usage accounting including cache
  tokens, and refusing to call once the budget is spent.
- **Not run against the live API.** In particular, whether the API accepts
  the fallback parameters and the structured-output schema as sent is
  unknown. Setting the repository variable `RELEASEPROOF_FALLBACKS` to `off`
  removes the fallback parameters without a code change.

## Still unverified

Updated 19 November: live model runs have since been made; see
[../2026-11-19-live/README.md](../2026-11-19-live/README.md).

- The budget stopping a live run, and model fallback during a retest.
- Cancellation of a superseded run.
- Pull requests from forks, beyond stopping after the build stage.
- Jira's live API.
