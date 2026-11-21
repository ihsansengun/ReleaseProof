# KAN-16: URL-only runs with trusted customer-written criteria

Acceptance criteria:

1. A run can be started with a target address and one or more criteria snapshots, and no pull request or ticket.
2. A criteria snapshot whose content matches its recorded hash and names an approver is authoritative and can set expected values.
3. A snapshot whose content does not match its hash is rejected before any model call.
4. Text that is not an approved snapshot can never set an expected value.
5. The result file names every snapshot used, with its hash.
6. A remote run records the version tested as "not established" unless the application reports one, and no scenario is blocked for that reason alone.
7. The result file and report contain no pull-request or ticket fields for a remote run, and say "target" where they said "pull request".
8. All existing tests still pass, and a run through the existing CI path produces the same result format as before.

Carried over from KAN-15, criterion 7, and **not yet verified**: a model-free
replay of recorded steps against an allow-listed application completes through
the worker and uploads a result.

## Progress

| Criterion | Status | Checked by |
| --- | --- | --- |
| 1 | checked with recorded decisions: `run-remote` runs an approved request against its target with no pull request or ticket. A run with a live model is not available yet | `packages/agent/test/remote-run.test.ts`, `packages/agent/test/remote-request.test.ts`, `packages/agent/test/remote-authority.test.ts` |
| 2 | checked: a snapshot with a valid approval for this run is the source of requirements, and sets expected values through the same checks as every other source | `packages/agent/test/remote-run.test.ts`, `packages/agent/test/remote-authority.test.ts` |
| 3 | checked for both gates, and the remote run takes no model driver at all | all three |
| 4 | checked: a quote not found in an approved snapshot, another source id, no source id, or text shown by the application sets no expected value | `packages/agent/test/remote-run.test.ts`, `packages/agent/test/remote-authority.test.ts` |
| 5 | part: the run's record names every snapshot with its hash. The result file is not built yet | `packages/agent/test/remote-run.test.ts` |
| 6 | not started | |
| 7 | part: the run's record has no pull-request or ticket field and says "target". The result file and report are not built yet | `packages/agent/test/remote-run.test.ts` |
| 8 | checked so far: the existing suite passes unchanged | `npm test` |
| KAN-15 criterion 7 | not started | |

## Integrity is not authority (decided 21 November 2026)

A matching hash shows a snapshot's text is unchanged. It does not show that
the named approver may approve requirements for the target: the request, hash
and approver's name all come from the same place. Criterion 2 is met only when
the control plane's signed approval for the snapshot verifies against a key
the request cannot influence. Until that check has passed, an admitted
snapshot is marked `integrity: "hash-matched"`, `approverVerified: false`. Only
the authority check below can change that.

## How authority is established (decided 21 November 2026)

The dashboard's control plane is the only source of authority. After it has
authenticated the user, checked their permission in the workspace and project,
and confirmed they approved the exact text, it signs an **approval**: one
statement binding the snapshot's hash to the workspace, project, run, target
and approver, with a short validity. Snapshots are immutable and versioned;
an edit is a new snapshot with a new hash and needs a new approval.

The engine holds only the control plane's **public** keys, given by its caller
from outside the request. It refuses, before any model call, an approval that
is missing, malformed, signed by an unknown key, forged, expired, or genuine
but for another run, workspace, project, target, text or approver. A ticket, a
pull request or a page cannot approve itself: nothing but a verifying
signature counts. The signing key never enters the engine or a run machine.

An approval also covers what the run is: it carries a digest of the request's
target address, allowed hosts, limits and exact set of criteria snapshots.
Whoever writes a request cannot add a host, change the path, raise a limit, or
leave out or add criteria, and keep the approval.

`check-remote-request` checks authority by default and needs `--approvals` and
`--authority-keys`. A flag left out or empty is refused, never read as "skip".
Checking integrity alone takes an explicit `--integrity-only`, and its output
says authority was not checked.

Not built yet: the control plane's side (issuing approvals), and handing an
authoritative snapshot to the planner as a source.

**Replay.** A run starts only through `authoriseForExecution`, the one
function that returns a `StartableRun`. The type alone can be cast, so the
code that starts a run must also ask `isStartable`, which only that function's
own result satisfies. The caller states, from outside the
request, which run, workspace and project it asked for; a genuine request and
approval for any other are refused. The run is then claimed in a ledger with a
single claim and starts once: a second start of the same run is refused,
whatever request or re-issued approvals it brings. The claim is made only
after every other check has passed, so a refused attempt claims nothing.
`check-remote-request` requires the caller's expectation (`--expect-run`,
`--expect-workspace`, `--expect-project`) and claims nothing, because it is a
check and not a start.

`run-remote` accepts only a `StartableRun` that passes `isStartable`. The ledger
directory must be created by the operator where a run cannot write. A run that is claimed and then crashes before starting stays
claimed: it needs a new run id. Until `run-remote` exists, no remote run can
start at all.

## Running from a request (`run-remote`)

`run-remote` takes a request, its approvals, the trusted keys, the caller's
expectation, a ledger directory and a **recording**, and writes
`remote-run.json` and one directory per scenario.

- It starts only from a `StartableRun` that passes `isStartable`. The run it
  is given is a frozen copy, so what was authorised is what runs.
- It takes no model driver. What a model would decide (how to read the
  criteria, what to test, which steps to take) comes from the recording. A
  recording is a proposal, like a model's answer: each requirement in it is
  checked against the approved snapshots by the same code that checks a live
  model, and an expected value that does not rest on approved text is removed
  before anything runs.
- The approved snapshots are the only sources, of kind `criteria-snapshot`.
- The run goes to the request's target, whatever a target manifest says. A
  target manifest is only read when named with `--target-manifest`.
- A request naming hosts besides its target's own is turned away before the
  run is claimed: a run can reach only its target's origin for now.
- The request's scenario limit and time limit are the ones applied. A scenario
  that did not run is recorded as not executed, never as passed.
- A target named `localhost` is refused, as before, unless the caller passes
  `--allow-local-target`, for a trial against an application on the same
  machine. The worker never passes it.

No run-level verdict is stated yet, and no result file in the dashboard's
format is written. Those come next.

## The run-level verdict (decided 21 November 2026)

The engine states one verdict for a remote run, and only the engine. First
match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`. A run that
ended early or left a requirement unverified is never `passed`. Early
termination and coverage stay visible separately, and scenario and requirement
results are kept in full. It arrives with the result format, not in this
change.
