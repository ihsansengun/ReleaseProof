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
| 1 | part: the request is defined and admitted; nothing runs from it yet | `packages/agent/test/remote-request.test.ts` |
| 2 | part: a snapshot's integrity is established (text matches hash). **Its authority is not**: the approver is only a claim until checked against the source's owners | same |
| 3 | checked for the gate itself | same |
| 4 | not started | |
| 5 | not started | |
| 6 | not started | |
| 7 | part: a request has no place for a pull request or ticket | same |
| 8 | checked so far: the existing suite passes unchanged | `npm test` |
| KAN-15 criterion 7 | not started | |

## Integrity is not authority (decided 21 November 2026)

A matching hash shows a snapshot's text is unchanged. It does not show that
the named approver may approve requirements for the target: the request, hash
and approver's name all come from the same place. Criterion 2 is met only when
the approver has been checked against the owners of the source, taken from a
list the request cannot influence. Until that check exists, an admitted
snapshot is marked `integrity: "hash-matched"`, `approverVerified: false`, and
nothing in a remote run may set an expected value.

## The run-level verdict (decided 21 November 2026)

The engine states one verdict for a remote run, and only the engine. First
match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`. A run that
ended early or left a requirement unverified is never `passed`. Early
termination and coverage stay visible separately, and scenario and requirement
results are kept in full. It arrives with the result format, not in this
change.
