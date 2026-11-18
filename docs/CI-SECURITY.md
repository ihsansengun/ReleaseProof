# CI integration: architecture and security

How ReleaseProof runs in GitHub Actions, what each part is trusted with, and
what that rests on. Verified results are in `eval/results/`; this document
describes the design and its limits.

## What is treated as untrusted

- The pull request's code, including its build scripts and dependencies
- Repository content at the pull request's head: the app's manifest and docs
- Ticket text and comments
- Everything the running application shows or returns
- Model output

None of these can be made safe by inspection, so the design gives them
nothing worth stealing and no way to act.

## Three stages

| | 1. Build | 2. QA | 3. Report |
|---|---|---|---|
| Workflow | `releaseproof-build.yml` | `releaseproof-qa.yml`, job `qa` | `releaseproof-qa.yml`, job `report` |
| Trigger | `workflow_dispatch` (pull request number) | `workflow_run`, when a build completes | follows `qa` |
| Code it runs | ReleaseProof at the workflow's commit; pull-request code inside `docker build` only | ReleaseProof from the default branch | ReleaseProof from the default branch |
| Token | `contents: read` | `contents`, `actions`, `pull-requests`: read | `checks: write`, `pull-requests: write`, `contents: read` |
| Secrets | none | `ANTHROPIC_API_KEY`, in one step | none |
| Sees pull-request code | yes, inside the image build | only as a container image it runs | no |

There is no `pull_request_target` anywhere, and stage 1 never receives a
secret or a write permission.

### Stage 1: build

Checks out the pull request without credentials, works out which application
it changes (the nearest directory with a `releaseproof.yml`), and builds
`ci/sandbox/Dockerfile.node` with the manifest's install, build and run
commands as build arguments. Those commands run inside the image build, not
on the runner. It uploads the image, the manifest, the documents the manifest
lists, and `meta.json`.

### Stage 2: QA

`workflow_run` workflows always run the default branch's file and code. A
pull request cannot alter this stage, the agent, or the report renderer.

Before doing anything with stage 1's output it checks:

- `meta.json` matches a strict schema (numeric pull request, 40-hex commit, an
  application path with no `..`, no leading `/`, no shell characters).
- The build was started the expected way: a manual build must have run from
  the default branch; a pull-request build must be for the commit it names.
- GitHub's API agrees that the pull request's head is that commit and that
  the head branch is in this repository.
- The image carries a label with that commit.
- The application path is one the pull request changes.

It then loads the image and starts it with:

- an internal Docker network (no route out);
- a read-only root filesystem, with a 256 MB tmpfs at `/tmp`;
- all capabilities dropped and `no-new-privileges`;
- a non-root user;
- limits of 1 GB memory, 1.5 CPUs and 256 processes;
- only the variables the manifest lists, plus the commit.

**The isolation is probed on every run**, from inside the container: the
variable names it can see, whether it can reach the internet, whether it can
write to its filesystem, and its user id. If any probe fails, nothing is
tested and the run reports an error. The result of the probe is in every
report.

The agent talks to the application only over HTTP to the container's
address. The browser refuses every other origin. The manifest's own base URL
is ignored. Documents are read only from the handed-over context directory,
and a document path that points outside it is refused.

The model key is in the environment of one step. It is never passed to the
container, and fixture passwords are replaced by placeholders before any
text reaches the model or a stored file.

### Stage 3: report

Downloads one file, `ci-result.json`, validates it against a schema, and
renders the Check run and the comment itself. Every string that originated
in a ticket, a page or a model is escaped, has mentions and links
neutralised, and is cut to a bounded length. The run URL is only linked if
it has the expected form. Nothing in the file is executed or followed. A
result for a commit that is no longer the head does not replace the comment.

## How this answers the specific risks

| Risk | What stops it |
|---|---|
| Pull-request code reads the model key or a write token | It only ever runs in stage 1 (no secrets exist) or in the stage-2 container (a separate, explicit environment, probed each run) |
| Pull request replaces the agent, the workflow or the report code | Stages 2 and 3 run from the default branch through `workflow_run` |
| A malicious build poisons stage 2 through its artifacts | Artifacts are parsed as data against schemas and cross-checked with GitHub's API; the image is run, never unpacked or executed on the host |
| The application attacks the runner or calls out | No network route out, read-only filesystem, no capabilities, non-root, resource limits |
| Ticket or page text instructs the model | The model's only tools drive one browser against one origin and record comparisons; verdicts are computed in code from expectations fixed beforehand |
| Hostile text reaches the comment | The report stage renders from validated fields and escapes everything |
| A result is reported for the wrong commit | The commit is carried from checkout to image label to metadata, checked against GitHub, set in the container by the orchestrator, and compared again by the engine before each scenario |
| A run costs too much | Per-run limits on cost, tokens and time, checked before every model call; job timeouts; a newer build cancels an older run |

## Cost and reliability controls

- Defaults per run: $8, 3,000,000 tokens, 25 minutes, 10 scenarios, 60 tool
  calls per scenario, 3 scenarios at a time. Override with repository
  variables `RELEASEPROOF_MAX_USD`, `RELEASEPROOF_MAX_TOKENS`,
  `RELEASEPROOF_MAX_MINUTES`, `RELEASEPROOF_MAX_SCENARIOS`.
- The cost figure is an estimate from token counts and list prices.
- The API client retries rate limits, overload and connection errors up to
  four times with backoff. A scenario whose model calls still fail ends as
  unverified with the reason; bad credentials stop the run.
- When a limit is reached, scenarios not yet started are recorded as
  unverified, and the report says the run ended early. Blocked and
  unverified scenarios make the Check neutral. Only failures make it fail,
  and only a run with every scenario passed makes it succeed.
- On a later commit to the same pull request, the previous run's scenarios
  are replayed without a model, and only those whose recording no longer
  fits are re-run with it. A changed ticket, or the `full` input, plans
  afresh.
- Evidence (reports, steps, screenshots, the application's log) is kept as
  an artifact for 14 days. Browser traces are excluded because they record
  typed values.

## Assumptions

- Docker's container isolation, and `docker load` and `docker build` of
  untrusted input, hold on GitHub-hosted runners. A container escape would
  reach a runner that holds the model key during one step.
- People with push access to this repository are trusted with its
  workflows. They could add a workflow of their own; that is GitHub's model
  and is not something this design changes.
- The default branch is protected by whatever review the repository uses.
  Stages 2 and 3 are exactly as trustworthy as that branch.
- GitHub-hosted runners are single-use.

## Known limits

- Same-repository pull requests only. A pull request from a fork stops after
  stage 1 with a note.
- The container can reach the Docker bridge address of the runner. No
  service listens there in these workflows, but it is not blocked.
- The first run for a pull request has nothing to replay, and a retest does
  not plan for behaviour a new commit introduces unless `full` is set.
- Replay shows a failure repeats, not that the comparison was the right one.
- Tickets are read from files in Jira's format. Jira's live API is untested.
- The automatic `pull_request` trigger is not enabled. Enabling it changes
  one thing: stage 1's workflow file then comes from the pull request. That
  is why stage 1 has nothing to protect and stage 2 re-checks everything.
