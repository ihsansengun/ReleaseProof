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
| 2 | part: a snapshot with a valid approval for this run is the only source of requirements; a comparison must cite a requirement quoted from it, and its expected value must itself be stated in that quoted text. Not established: that the element read is the one the text is about. That is still the plan's choice, so `verdictsTrusted` is false | `packages/agent/test/remote-run.test.ts`, `packages/agent/test/remote-authority.test.ts` |
| 3 | checked for both gates, and the remote run takes no model driver at all | all three |
| 4 | checked for expected values: a comparison citing a quote not found in an approved snapshot, another source id, or no source id is removed, and so is one whose expected value the quoted text does not state. A value the executor itself entered is not evidence (see "Independent evidence") | `packages/agent/test/independent-evidence.test.ts`, `packages/agent/test/remote-run.test.ts`, `packages/agent/test/remote-authority.test.ts` |
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
  model, and a comparison that does not cite a requirement quoted from
  approved text is removed before anything runs.
- In a remote run the expected value must also be stated by the quoted text
  itself: a number written in it (in the unit expected), a text found in it
  word for word, or a calculation whose written numbers are all in it. A
  presence check must look for wording the text states. Anything else is
  removed or refused. See "Independent evidence" for what the executor's own
  input can and cannot show.
- What is still not established: that the element a comparison reads is the
  one the approved text is about. That remains the recording's choice. So the
  record carries `verdictsTrusted: false`, and a scenario's "passed" in a
  recorded run is evidence of what the application showed, not a verdict on
  the criteria, until that is decided otherwise.
- A recording is limited: 2,000,000 bytes, 60 steps for a scenario, and ids
  that are plain names, each used once. An id that is not a plain name is
  refused, and evidence is only ever written inside a scenario's own
  directory.
- The approved snapshots are the only sources, of kind `criteria-snapshot`.
- The run goes to the request's target, whatever a target manifest says. A
  target manifest is only read when named with `--target-manifest`.
- A request naming hosts besides its target's own is turned away before the
  run is claimed, and again when the run starts: a run is for its target's
  origin only for now.
- The page is kept on the target's origin. A request the page addresses to
  another origin is stopped, service workers are off, and a WebSocket the
  page opens to another host is closed. Every address the page commits to is
  watched: if it was on another origin at any moment (a redirect took it
  there), also if it came back before the step ended, the comparisons,
  observations, error notes and step summary of that step are dropped and
  the replay stops. A blank page counts as another origin once the
  application has been open, because another window can put one in the
  application's place and write into it. Such a scenario never passes: it is
  blocked, or failed if a comparison made on the application had already
  not matched. The browser trace, and a screenshot taken during that step,
  stay in the scenario's directory and can show the other page; the result
  does not refer to them.
- **Not stopped by the engine:** what a redirect fetches, and a WebSocket
  opened from a worker script. The browser follows a redirect before the
  engine's request filter sees it. So:
  - a recording using an open redirect on the target can make the browser
    send a GET to another host for each navigation it records;
  - a hostile or compromised target can go further: its pages can load
    scripts and send data (a redirected POST keeps its body) to other hosts
    through redirects of its own, any number of times, and open a WebSocket
    elsewhere from a worker. Such a target could show any value itself, so
    this adds nothing to what it can make a result say; it is traffic leaving
    the worker.

  Only the network the browser runs on can stop this. A worker must run with
  outbound access limited to the target, and the engine's own per-run
  restriction comes with the browser options, next.
- The request's scenario limit is the one applied. The time limit is checked
  before every scenario and before every step; a step already under way
  finishes first, so a run can pass its limit by one step's own waiting time
  (about 45 seconds at most for a navigation) plus closing the browser.
  A scenario that did not run, or was stopped by the limit, is never passed.
- The recording, the keys, the approvals, the ledger, the target manifest and
  the output directory are read or made before the run is claimed, so a
  mistake in any of them uses nothing up. A failure after that, such as the
  browser not starting or the disk filling, does use the run's one start.
- The command exits 0 when the run was carried out, whatever the scenarios
  found. Exit 0 is not a pass: there is no run-level verdict yet.
- A target named `localhost` is refused, as before, unless the caller passes
  `--allow-local-target`, for a trial against an application on the same
  machine. The worker never passes it, and the record says `localTarget` when
  it was used. Any other name with a `localhost` label, such as
  `shop.localhost`, and any name ending in `.localdomain`, is refused always.

Known and not changed here, because the pull-request path shares it: a quote
is matched to a source loosely (ignoring case, spacing and some punctuation,
from 8 characters), and a public name that resolves to a private address is
not detected by the request gate.

No run-level verdict is stated yet, and no result file in the dashboard's
format is written. Those come next.

## Independent evidence

A value the executor itself put into the application is not evidence about
the application. This holds for every run, with a model or from a recording,
for a pull request or a remote request: it is in the comparison code they
share (`packages/agent/src/execute/supplied.ts`).

The executor's own values are: what it typed into a field, chose in a list,
wrote into an address (a query value, or a path segment holding a digit), or
sent in a request (its address and every value in its body).

A comparison that **matches** such a value, or an observation of one, is
recorded only if:

- for a value entered on a page: the application accepted a change afterwards
  (a request other than a read, answered without an error), and then answered
  a read (a page, or data a page asked for) that contains the value while the
  address of that read does not;
- for a value in an address or a request: a later read contains it without
  carrying it. The answer to the request that carried it never counts, also
  not for a change: a saved value is verified by reading it back;
- the element read is not a field the executor filled, in the page it typed
  into. After saving and opening the page again it may be.

Otherwise nothing is recorded and the step says why. A **mismatch** is always
recorded: the application not showing a value is evidence whatever was typed.
When a comparison does match an entered value, its evidence says so
(`entered`: the step, how, and the read that confirmed it).

Also refused: an expected value calculated only from a reading of the same
place as the value compared, with nothing done in between.

So "edit, save, look again" works, and "type it and read it back" does not.

What this does not do:

- It does not decide which element is the right one to read. A value the
  executor saved somewhere the application keeps it can be read back from
  there. Which place a requirement is about is the plan's.
- A small number is easily "contained" in a later page for other reasons, so
  the confirmation is weak for values such as 1 or 2.
- A page that shows back what is typed, while an unrelated change was accepted
  and an unrelated read happens to contain the same value, would count.

## Security checklist

Open items that must hold before a remote run is trusted. None is closed by
browser confinement.

- [ ] **Worker-level outbound network restriction to the target.** The engine
      cannot stop what a redirect fetches or a worker WebSocket of a hostile
      target. Origin confinement in the browser does not replace network
      isolation.
- [ ] The element a comparison reads is tied to the approved text
      (`verdictsTrusted` stays false until then).
- [ ] A failure after the run is claimed uses its one start: decide whether
      that needs a recovery path.
- [ ] Quote matching is loose (case, spacing, some punctuation, from 8
      characters).
- [ ] A public name that resolves to a private address is not detected by the
      request gate.
- [ ] KAN-15 criterion 7 (a replay through the worker): not started, not
      verified.

## The run-level verdict (decided 21 November 2026)

The engine states one verdict for a remote run, and only the engine. First
match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`. A run that
ended early or left a requirement unverified is never `passed`. Early
termination and coverage stay visible separately, and scenario and requirement
results are kept in full. It arrives with the result format, not in this
change.
