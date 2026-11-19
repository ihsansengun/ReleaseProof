# Security backlog

Open items after the review of 19 November 2026
([SECURITY-REVIEW.md](SECURITY-REVIEW.md)). Automatic QA
(`RELEASEPROOF_AUTO_TRIGGER`) stays off until the items marked "before
automatic runs" are done.

| # | Item | Why | Before automatic runs | Status |
|---|---|---|---|---|
| 1 | Requirement-source authority enforced in code | A pull request can supply text that is accepted as a documented requirement | Yes | Implemented with tests, not yet merged or run with a live model: [design/REQUIREMENT-AUTHORITY.md](design/REQUIREMENT-AUTHORITY.md) |
| 2 | One blind prompt-injection run | The only injection run was against a pull request that announced it was hostile | Yes | After item 1; controlled budget |
| 3 | Pin third-party actions by commit | `actions/checkout@v4` and the others follow a tag their owners can move | Yes | Not started. Six actions in two workflows |
| 4 | Concurrency verified with real simultaneous runs | The per-pull-request group has run for one run at a time; several at once are covered by unit tests and a model of GitHub's rule | Yes | Not started. Needs two runs in flight; can be done with recorded or near-zero-budget runs |
| 5 | Replay reliability | In the adversarial run no failure was confirmed by the model-free repeat ("replay diverged"). A local run has since shown the cause on the time-off application: a recorded step names a control by an id the application assigns ("Approve request 14 …"), and that id is different on a repeat. Failures then rest on one execution | No, but it weakens every failure report | Cause confirmed; fix not started |
| 6 | Rotate `ANTHROPIC_API_KEY` | Browser processes held it in every run before pull request #10. No leak observed | Yes | Owner action |
| 7 | Hostile fixture's memory test and log-injection lines on a hosted runner | The fixture's probe stopped before reaching them; both are covered by local and unit tests only | No | Fix the fixture, re-run within another paid or near-zero-budget run |
| 8 | Set-up step depends on Ubuntu's package mirrors | One run failed there before testing anything | No | Cache the browser and its packages |
| 9 | Fork pull requests and the automatic pull-request path end to end | Skipped by rule; never exercised against a real fork or with automatic runs on | Yes, at the time automatic runs are considered | Not started |
| 11 | Jira issue description edits by people outside the owner list | Jira's own permissions decide who may edit an issue; only comments are checked against the owner list. Anyone who can edit the ticket can change what is tested | **Yes**, once live Jira is the ticket source for automatic runs | Open. Not solved. Candidate fix: read the issue's change history and accept only edits by listed owners. Reports carry a standing note meanwhile |
| 14 | Precedence between an owner's later comment and older ticket text is not enforced in code | Both are authoritative. The analyst is told to follow the later statement, so a model could silently test an outdated rule | **Yes** | Open. Mechanism proposed in [design/REQUIREMENT-AUTHORITY.md](design/REQUIREMENT-AUTHORITY.md), "Proposed: deterministic precedence"; not implemented |
| 13 | Live authorisation test with a second Jira account | Non-owner comments are tested with mocked identities only | No | Waiting for a second Jira user |
| 12 | Re-runs that replay an earlier plan do not recompute conflicts or approvals | Chosen only when no authoritative source changed, but pull-request documentation may have | No | Not started |
| 10 | Evidence artifact is readable by anyone who can read the repository | An application that prints a secret from its own configuration would publish it | No | By design; revisit for private applications |

Done on 19 November: per-pull-request QA concurrency, allow-listed child
environments, symlink refusal, trusted-side isolation checks (pull request
#10); sandbox closed off from the runner host (pull request #11, confirmed on
a hosted runner in QA run 44529386252).
