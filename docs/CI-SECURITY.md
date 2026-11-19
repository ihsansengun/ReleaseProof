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

## Four stages

| | 1. Request | 2. Build | 3. QA | 4. Report |
|---|---|---|---|---|
| Workflow | `releaseproof-request.yml` | `releaseproof-qa-reusable.yml`, job `build` | same file, job `qa` | same file, job `report` |
| Trigger | `workflow_dispatch` (pull request number) | `workflow_run`, when a request completes | follows `build` | follows `qa` |
| Code it runs | none: it writes a small request | ReleaseProof from the default branch; pull-request code inside `docker build` only | ReleaseProof from the default branch | ReleaseProof from the default branch |
| Token | `contents: read` | `contents`, `actions`, `pull-requests`: read | the same | `checks: write`, `pull-requests: write`, `contents: read` |
| Secrets | none | none | `ANTHROPIC_API_KEY` and the Jira credentials, in one step | none |
| Sees pull-request code | no | yes, as the context of the image build | only as a container image it runs | no |

`releaseproof-qa.yml` is the `workflow_run` entry point; it calls the
reusable workflow, which an application in another repository can call too
([ONBOARDING.md](ONBOARDING.md)). There is no `pull_request_target`
anywhere, and no stage that touches pull-request files holds a secret or a
write permission.

Until 19 November 2026 the image was built in stage 1. With the
pull-request event GitHub takes stage 1's workflow file from the pull
request, so the commit label on that image was only as good as the pull
request's own workflow. The build now happens in stage 2, in code a pull
request cannot change.

**An application in another repository.** A manual request may name another
public repository. The same four stages run here, with these differences:
the build job fetches that repository's pull request, the protected
material comes from that repository's default branch, the run shares a
concurrency group with nothing, and the report job posts nothing (its token
cannot write there, and no other credential is given to it). A request
started by a pull-request event that names another repository is refused
before anything is fetched.

**What leaves the runner.** By default only three files written for public
reading are uploaded: a redacted summary and the redacted diagnostics (JSON
and Markdown). Screenshots, step records, the application's log, the audit
trail and browser traces stay on the runner and are discarded with it. The
report job receives only the fields it renders, redacted. An artifact of a
public repository can be downloaded by any signed-in user, so the artifact
is not treated as a private store. The repository variable
`RELEASEPROOF_FULL_EVIDENCE=on` uploads the full evidence (still without
browser traces); it is meant for repositories where access is controlled,
and a request cannot set it.

### Stage 1: request

Writes the pull request number and any requested limits to an artifact.
Nothing is checked out and nothing is built. Everything it produces is
treated as untrusted by the later stages.

### Stage 2: build

Trusted code, no secret. It establishes the provenance of what is tested:

1. It asks GitHub which commit the pull request is at. For a request started
   by a pull-request event, that commit must also be the commit of the event.
2. It fetches exactly that commit, without credentials, into a directory
   from which nothing is executed on the runner.
3. The build code checks again that the fetched files are at that commit,
   works out which application the pull request changes (the nearest
   directory with a `releaseproof.yml`), and runs `docker build`: with
   `ci/sandbox/Dockerfile.node` and the manifest's install, build and run
   commands as build arguments, or with the application's own Dockerfile.
   The image's commit label is set by this code, after anything a Dockerfile
   says.
4. It measures the image file (SHA-256) and passes the digest to the QA job
   as a job output, outside the artifact that carries the image.

It uploads the image, the manifest, the documents the manifest lists, and
`meta.json`.

### Stage 3: QA

`workflow_run` workflows always run the default branch's file and code. A
pull request cannot alter this stage, the agent, or the report renderer.

Before doing anything with the build job's output it checks:

- `meta.json` matches a strict schema (numeric pull request, 40-hex commit, an
  application path with no `..`, no leading `/`, no shell characters).
- The build was started the expected way: a manual build must have run from
  the default branch; a pull-request build must be for the commit it names.
- GitHub's API agrees that the pull request's head is that commit and that
  the head branch is in this repository.
- The image file's SHA-256 equals the digest the build job reported as a job
  output. A missing or malformed digest counts as a mismatch.
- The image carries a label with that commit.
- The application path is one the pull request changes.

It then loads the image and starts it with:

- an internal Docker network (no route out);
- a read-only root filesystem, with a 256 MB tmpfs at `/tmp`;
- all capabilities dropped and `no-new-privileges`;
- a non-root user;
- limits of 1 GB memory, 1.5 CPUs and 256 processes;
- only the variables the manifest lists, plus the commit.

**The isolation is checked on every run, from the trusted side only.**
Nothing from the application image is run or believed for this. The check
reads the container engine's record of the container (read-only root, no
capabilities, no privilege escalation, the isolated network and nothing else,
no mounts, limits, user, variable names), reads the kernel's record of the
application's main process on the host (user id, effective capabilities,
`NoNewPrivs`), tries to reach the internet and the cloud metadata addresses
with the engine's own Node placed in the container's network namespace, and
asks the engine to write a file to the container's root. "The internet"
includes the machine running the sandbox: an internal network removes the
route out, but on some engine versions a container can still reach the host's
own address on the bridge. A firewall rule drops new connections from the
sandbox bridge to the host (replies to the engine's own connections still
pass), and the check opens a listener on the host and confirms it cannot be
reached from the container's network namespace. If any part fails
or cannot be carried out, nothing is tested and the run reports an error.
The result is in every report.

The agent talks to the application only over HTTP to the container's
address. The browser refuses every other origin. The manifest's own base URL
is ignored. Documents are read only from the handed-over context directory:
a listed document must be a regular file whose real path is inside that
directory, so neither `..` nor a symbolic link leads out of it, and a
hand-off that contains any symbolic link is refused outright.

**Credentials.** The model key is given to one step. The engine reads it
once, hands it to the API client, and removes it (and the GitHub token, once
the pull request has been read) from its own environment. Every process the
engine starts (the browser, the container client, the probes) gets an
explicit allow-list of variables (`hostenv.ts`): path, home, locale,
temporary directory and the container client's settings. Nothing else is
passed on, so no child process holds a credential to leak. The container's
environment is only what the explicit `--env` arguments say. Fixture
passwords are replaced by placeholders before any text reaches the model or
a stored file; that redaction is a second measure, not the first.

**Concurrency.** QA runs are grouped per pull request at the job level, by a
key computed in a first job that holds no secret (`ci/qa-concurrency.mjs`).
For a build started by a pull-request event the number is GitHub's record of
the event; for a manual build it is the maintainer's input. A newer build of
the same pull request replaces an older run; runs for different pull
requests never share a group; and a run that the gate skips never joins one.
There is no workflow-level group, because that is joined by every completed
build before any gate.

**Where requirements may come from.** Trust is assigned in code from where a
text was read, before any model runs ([design](design/REQUIREMENT-AUTHORITY.md)).
Authoritative: the Jira issue fetched over the authenticated API, comments
by listed requirement owners, ticket files and listed documents as this
stage's own working copy of the default branch has them, and documentation
changes a listed owner approved with an explicit command. Everything the
pull request controls (its description, its changes to documents, its
manifest's document list, its copy of the owner list) can be quoted as a
claim and can never set an expected value. Unapproved changes to requirement
documents are always listed in the report, and any conflict keeps the Check
from being green.

One limit of this: a Jira issue's summary and description are trusted on
the strength of Jira's own edit permissions, which may include people who
are not listed requirement owners. Comments are checked against the owner
list; the description is not. That is an open gap.

**Audit trail.** Every run writes `audit.json` and `audit.md` next to its
report, and they are part of the evidence artifact. For each expected value
that was compared they give the chain: source (origin, trust, hash), any
approved amendment (approver, comment, commit, change hash), the requirement
with its verified quote, the assertion with its expected value, and the
evidence (observed value, verdict, model-free repeat, step record and
screenshot). They are built by code from the run's records.

### Stage 4: report

Downloads one file, `ci-result.json`, validates it against a schema, and
renders the Check run and the comment itself. Every string that originated
in a ticket, a page or a model is escaped, has mentions and links
neutralised, and is cut to a bounded length. The run URL is only linked if
it has the expected form. Nothing in the file is executed or followed. A
result for a commit that is no longer the head does not replace the comment.

## How this answers the specific risks

| Risk | What stops it |
|---|---|
| Pull-request code reads the model key or a write token | It only ever runs inside the image build of stage 2 (a job with no secrets) or in the stage-3 container (a separate, explicit environment, probed each run) |
| Pull request replaces the agent, the workflow or the report code | Stages 2 to 4 run from the default branch through `workflow_run` |
| A malicious build poisons the QA job through its artifacts | Artifacts are parsed as data against schemas and cross-checked with GitHub's API; the image is run, never unpacked or executed on the host |
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
- A manual run can ask for tighter limits (cost, minutes, scenarios) through
  the build workflow's inputs. The QA stage validates the request and only
  ever lowers its limits.
- Every report states its execution mode. A run with no live model
  ("recorded") always gets a neutral Check, whatever its scenarios did, and
  is never the basis for a later re-run.
- When a limit is reached, scenarios not yet started are recorded as
  unverified, and the report says the run ended early.
- A manual run can also ask for a different model for scenario execution.
  The request is honoured only if the model is on the allow-list in
  `ci/run.ts`; analysis and planning always use the configured model.

### Result semantics

Every report makes two separate statements.

**Execution results** are facts about what ran: scenarios passed, failed,
blocked and unverified, and for each documented requirement exactly one of
verified, failed, blocked (only reachable through a scenario waiting on a
question), unverified (planned, but the comparison was never made) or not
planned.

**Release readiness** is the judgement the Check carries:

| Readiness | Meaning | Check |
|---|---|---|
| Not ready | At least one comparison failed | failure |
| Incomplete | Nothing failed, but something material is untested: a documented requirement not compared, a scenario blocked, unverified or dropped by the scenario limit, or a run that ended early | neutral |
| Ready | Nothing failed, every documented requirement was compared and matched, nothing was left open | success |

"Everything that ran passed" is therefore never enough for a green Check.
The comment lists each requirement that was not verified, with the reason.
A recorded run is neutral whatever its readiness.

### Requests the trusted stage makes to the application

The engine's own HTTP requests (fixture creation, the version check, the
executor's `api_request` tool, the start-up health check) go only to the
application's address. Paths from the manifest are refused if they resolve
to another origin, and redirects are reported instead of followed, so
neither a hostile manifest nor a hostile application can point those
requests at another host. The browser was already restricted to the
application's origin.

The last lines of the application's log are printed in the QA job with an
`app| ` prefix and control characters removed, so the log can be read
without downloading the artifact and cannot issue commands to the runner.
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
  Stages 2 to 4 are exactly as trustworthy as that branch.
- GitHub-hosted runners are single-use.

## Known limits

- Same-repository pull requests only. A pull request from a fork stops after
  the build with a note.
- The container can reach the Docker bridge address of the runner. No
  service listens there in these workflows, but it is not blocked.
- The first run for a pull request has nothing to replay, and a retest does
  not plan for behaviour a new commit introduces unless `full` is set.
- Replay shows a failure repeats, not that the comparison was the right one.
- Tickets are read from files in Jira's format. Jira's live API is untested.
- With the `pull_request` event GitHub takes stage 1's workflow file from
  the pull request. Two consequences:
  - Stage 1 can be changed by the pull request. That is why it has nothing
    to protect, builds nothing, and the later stages take from it only a
    pull request number and limits that can only tighten.
  - Leaving the trigger out of `main` does not keep automatic runs off: a
    pull request can add the trigger to its own copy and start stage 1, and
    the later stages on `main` then run for it. This happened when the pull request
    that adds the trigger was opened. The switch is therefore in the trusted workflow:
    requests started by a pull-request event are handled only when the
    repository variable `RELEASEPROOF_AUTO_TRIGGER` is `on`. A pull request
    cannot set a repository variable.
