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
| 1 | part: the request is defined, admitted and authorised; nothing runs from it yet | `packages/agent/test/remote-request.test.ts`, `packages/agent/test/remote-authority.test.ts` |
| 2 | part: a snapshot is authoritative only with a valid approval signed by the control plane for this run. It does not yet reach the planner as a source | `packages/agent/test/remote-authority.test.ts` |
| 3 | checked for both gates: integrity and authority are decided before any model call | both |
| 4 | part: a request, a snapshot's text, or unsigned evidence cannot grant authority. Not yet shown for text met during a run | `packages/agent/test/remote-authority.test.ts` |
| 5 | not started | |
| 6 | not started | |
| 7 | part: a request has no place for a pull request or ticket | `packages/agent/test/remote-request.test.ts` |
| 8 | checked so far: the existing suite passes unchanged | `npm test` |
| KAN-15 criterion 7 | not started | |

## Integrity is not authority (decided 21 November 2026)

A matching hash shows a snapshot's text is unchanged. It does not show that
the named approver may approve requirements for the target: the request, hash
and approver's name all come from the same place. Criterion 2 is met only when
the approver has been checked against the owners of the source, taken from a
list the request cannot influence. Until that check exists, an admitted
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

An approval also covers where the run may go and what it may spend: it carries
a digest of the request's target address, allowed hosts and limits. Whoever
writes a request cannot add a host, change the path or raise a limit and keep
the approval.

`check-remote-request` checks authority by default and needs `--approvals` and
`--authority-keys`. A flag left out or empty is refused, never read as "skip".
Checking integrity alone takes an explicit `--integrity-only`, and its output
says authority was not checked.

Not built yet: the control plane's side (issuing approvals), and handing an
authoritative snapshot to the planner as a source.

**Replay.** A run starts only through `authoriseForExecution`. The caller
states, from outside the request, which run, workspace and project it asked
for; a genuine request and approval for any other are refused. Each approval
is then claimed in a ledger and can start one run: presenting the same request
and approvals again is refused. A refused attempt claims nothing.
`check-remote-request` requires the caller's expectation (`--expect-run`,
`--expect-workspace`, `--expect-project`) and claims nothing, because it is a
check and not a start.

Still open, for the change that adds `run-remote`: that command must call
`authoriseForExecution` with a ledger kept where a run cannot write. Until it
exists, no remote run can start at all, so nothing can be replayed into one.

## The run-level verdict (decided 21 November 2026)

The engine states one verdict for a remote run, and only the engine. First
match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`. A run that
ended early or left a requirement unverified is never `passed`. Early
termination and coverage stay visible separately, and scenario and requirement
results are kept in full. It arrives with the result format, not in this
change.
