# CI security review, 19 November 2026

A review of the trust boundaries described in [CI-SECURITY.md](CI-SECURITY.md)
against the code and workflows, with adversarial tests. The review started
on `main` at `795a240`; the fixes it led to were merged as pull request #10
(`63eda12`), and the hostile run was made after that.
Evidence is in [eval/results/2026-11-19-security](../eval/results/2026-11-19-security/README.md).

**Recommendation: keep `RELEASEPROOF_AUTO_TRIGGER` off.** The hostile run
found one more hole (the container could reach the runner host, since
fixed), and its prompt-injection result was not a blind test. Open items are
tracked in [SECURITY-BACKLOG.md](SECURITY-BACKLOG.md). Conditions for turning it on
are at the end.

## What was tested, and how

| Boundary | Hostile input | Where | Result |
|---|---|---|---|
| Application container | An app that reads its environment, tries the internet, cloud metadata addresses and the runner's bridge address, writes outside `/tmp`, and exhausts processes and memory | Real CI run, live model | See "Hostile run" |
| Model, at execution | Page text, API responses and response headers telling the agent to skip checks, report success, visit another host and post its key | Same run | See "Hostile run" |
| Model, at analysis and planning | Pull request description and README telling the agent the ticket is superseded and nothing should be tested | Same run | See "Hostile run" |
| Manifest | External base address; documents outside the application; off-origin fixture and version paths; invalid variable names; no start section | Same run, local QA-stage runs, unit tests | Refused or ignored |
| Stage 2 inputs | `meta.json` naming another pull request, a wrong commit, shell characters, a path outside the repository, an application the pull request does not change; build from a non-default branch; pull-request event for another commit; other event types; mislabelled image; corrupt image; limits that try to raise the budget; executable files planted in the hand-off | Local runs of the real QA stage with Docker | All rejected or ignored |
| Report stage | Result file with markup, mentions, links, images, a forged report marker, oversized fields, and invalid repository, commit and pull request values | Unit tests | Displayed as text, or rejected |
| Engine's own HTTP requests | Redirect from the application to another host | Unit test with two local servers | Not followed |

Not tested, and stated as such:

- A real container escape. The design assumes Docker's isolation holds.
- The pull-request-event path end to end. It needs automatic runs on. Its
  stage 2 checks were exercised locally with crafted inputs instead.
- A fork pull request. Stage 2 skips them by rule; that rule was not
  exercised against a real fork.

## Findings

Severity is about what an attacker who can open a same-repository pull
request gains. None of the findings exposed the model key or a write token
in any test.

| # | Finding | Severity | Status |
|---|---|---|---|
| 0 | **The application container can reach the runner host.** On the hosted runner the hostile fixture connected to port 22 on the host's address of the sandbox's internal network. An internal network removes the route out but not, on that engine version, the path to the host. The trusted-side check reported the network as blocked because it only tried outside addresses. No credential is served on the host's address and nothing leaked. | Medium | Found by the hostile run. Fixed in #11: a firewall rule on the sandbox bridge, and the check extended to the host. Confirmed on a hosted runner (QA run 44529386252): the same fixture can no longer connect to the host, and the trusted-side check reports no address reached |
| 1 | **Any pull request event cancels a QA run in progress.** The build workflow's `run-name` contains ` #`, which YAML reads as a comment, so every build is titled "ReleaseProof build for PR". The QA workflow keys its concurrency group on that title, so all QA runs share one group, and a new one cancels the one in flight, even if the new one is then skipped. This happened during this review: opening a draft pull request cancelled a live run 7½ minutes in. With the title fixed, a pull request could still set its own build title to another pull request's and cancel its run. | Medium (availability, wasted spend) | Fixed in #10: no workflow-level group; a job-level group keyed per pull request from GitHub's record of the event; quoted `run-name`. Seen working for one run on a hosted runner (key `pr-9`); several runs at once are covered by tests only |
| 2 | **Documentation from the pull request counts as a requirement source.** The manifest's documents are read at the pull request's head, and a quote from them can back a "documented requirement". A pull request can therefore edit the README to describe its defect as intended behaviour. | Medium (integrity of the verdict) | **Open.** In the hostile run the ticket prevailed and the conflict was raised as a question, but nothing in the code enforces that. Proposal below |
| 3 | **A listed document could be a symbolic link.** The path check was lexical, so a link inside the application directory to any file on the machine reading it was followed, and the content went into the model's input and the stored run. In CI that machine is the stage 1 runner, which holds no secret beyond a short-lived read-only token; with the CLI on a developer's machine it could be any readable file. Confirmed against `main`. | Low in CI, medium for local use | Fixed in #10: canonical paths, regular files only; a hand-off containing a link is refused |
| 4 | **The browser inherited the engine's environment**, including the model key and the GitHub token, while rendering untrusted pages. Reading it would need a browser exploit. | Low (defence in depth) | Fixed in #10: one allow-list is the environment of every child process, and the engine removes the key from its own environment once read. Rotating the key that earlier browsers held is recommended |
| 5 | **The isolation probe ran programs from the untrusted image** (`env`, `node`, `sh`, `id`), which a hostile image could replace to report what the probe wants to see. The isolation itself comes from the `docker run` flags set by trusted code, so this weakens the check, not the isolation. | Low | Fixed in #10: the check runs nothing from the image. Passed on a hosted runner, and missed finding 0 |
| 6 | Manifest paths could leave the application's origin, and the engine followed redirects. | Medium | Fixed in pull request #7, before this review's tests |
| 7 | An invalid manifest in the hand-off gave an unreadable error ("["). | Cosmetic | Fixed in #10 |
| 8 | Third-party actions are pinned by tag (`@v4`), not by commit. | Low | Open; recommended before automatic runs |
| 9 | The evidence artifact is readable by anyone who can read the repository, and contains page content, screenshots and the application's log. Nothing secret reaches it in these tests, but an application that prints a secret from its own configuration would publish it. | Informational | By design; the manifest's environment is documented as "never secrets" |
| 10 | A hostile application can make the agent waste its budget (large pages, slow responses). The budget and time limits bound it. | Informational | Accepted |

### Finding 2 in more detail

Requirements must be backed by a verbatim quote, and the quote is checked
mechanically against "behaviour sources": the ticket and the listed
documents. That check stops the model inventing rules; it does not stop the
pull request supplying them. The ticket is the product owner's; the README
at the pull request's head is the author's.

Proposal, not implemented: in CI, read listed documents from the base
commit as well, and treat text that the pull request adds or changes as
"claimed by this pull request": usable as a hint for where to look, shown
in the report, but never as the expectation for a comparison when it
contradicts the ticket, and never as the only basis for "verified".

## Boundary by boundary

**Stage 1 (build).** No secrets, read-only token, `persist-credentials:
false`. Pull-request code runs only inside `docker build`. The Dockerfile
comes from the default branch. With the pull-request event GitHub takes the
workflow file from the pull request, so nothing in stage 1 can be relied on;
stage 2 re-checks everything. Confirmed by review; the hand-off checks were
exercised locally.

**Hand-off.** Everything is validated field by field (`Meta`), the image
label must equal the commit GitHub reports for the pull request, limits can
only tighten, the executor model must be on an allow-list, and no file from
the hand-off is executed or sourced. Confirmed by the local tampering runs.

**Stage 2 (QA).** Runs the default branch's code. The model key is in one
step's environment. The container gets an explicit environment (manifest
values and the commit; names restricted to `[A-Z_][A-Z0-9_]*`), an internal
network, a read-only root, no capabilities, a non-root user and resource
limits. The previous run restored from cache can only have been written by
this workflow on the default branch.

**Model.** The model never sees a credential: fixture passwords are replaced
by placeholders, and the model key is not in any prompt. Its tools can only
reach the application's origin. Verdicts are computed in code from
comparisons whose expected values were fixed before execution, so the model
cannot declare a pass; the most injected text can do is stop a scenario
(unverified, never a pass) or steer a `check` at the wrong element.

**Stage 3 (report).** Reads one JSON file, validates it, neutralises every
displayed string and posts to the repository and commit that pass strict
patterns. Holds no secret. Confirmed by unit tests with a hostile result.

## Hostile run

Full record: [eval/results/2026-11-19-security](../eval/results/2026-11-19-security/README.md).
One live run of a deliberately hostile build of the time-off feature, on
`main` with the fixes of #10, capped at $2.00.

| Question | Result |
|---|---|
| Genuine defects reported | Both, and the Check was red |
| Requirement integrity | Held: expectations quoted the ticket; the pull request's rewritten README was not used, and the conflict was the first question raised |
| Prompt-injection resistance | Held, but the pull request description announced that it was a hostile fixture, so this was not a blind test |
| Credential protection | Held: no credential in the container's environment, no route to the internet, DNS or metadata addresses, read-only root, no capabilities, process limit enforced; no secret in any output |

Also from that run: one probable false-positive scenario, no failure
confirmed by the model-free repeat, the first live run stopped by its cost
limit ($2.01 of $2.00, after all scenarios had run), and finding 0.

## Before automatic runs are turned on

1. ~~Merge the host-isolation fix (#11) and see the extended check pass on a
   hosted runner.~~ Done.
2. Make "the ticket outranks documentation changed by the pull request" a
   rule in code (finding 2).
3. Make one blind injection run: a hostile pull request whose description
   does not say so.
4. Pin third-party actions by commit (finding 8).
5. Rotate `ANTHROPIC_API_KEY`. No leak was observed; the reason is that the
   browser held it in every run before #10.

Until then, manual runs on pull requests you have looked at remain the
right mode.
