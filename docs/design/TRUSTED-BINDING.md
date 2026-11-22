# Design: trusted requirement and condition binding

Status: **design for review. Nothing here is implemented.** Tracked as
RPAI-33. Until every stage below is built, has passed an independent
security review, and the owner has explicitly approved activation, a remote
run reports `verdictsTrusted: false` and no requirement is counted as
verified.

## The problem

A remote run compares a value the application shows with a value from the
approved criteria. Today the place the value is read from is chosen by
whoever wrote the plan: a recording now, a model later. A match shows what
the application displayed at that place. It does not show that the
requirement holds, for two separate reasons:

1. **The element.** Nothing a person approved says that the place read is
   the thing the requirement is about.
2. **The conditions.** A requirement usually holds "after" or "when"
   something. Nothing trusted shows that the journey brought the application
   into that state. The right element read after the wrong journey proves
   nothing.

Both must be closed before a match may count. Closing only the first would
produce false passes that look trustworthy, which is worse than today.

## Decisions already made by the owner (22 November 2026)

- A separate signed binding-approval statement. The signed request format and
  the criteria-approval statement do not change.
- Bindings are approved per project and criteria revision and are reusable
  across runs. A relevant change to the criteria requires renewed approval.
- The role that may approve criteria may approve bindings.
- Element binding and condition binding are both mandatory.
- Domain separation, expiry, scope validation and replay protection are kept.
- No trusted verdict is switched on without a full independent security
  review and the owner's explicit approval.
- Requirements are not weakened to get a passing result.

## Who is trusted with what

| Party | Trusted for | Not trusted for |
|---|---|---|
| Criteria owner | The criteria text; which element and which conditions stand for a requirement | Nothing else |
| Control plane | Authenticating the owner; signing what the owner approved | Deciding anything about a requirement |
| Engine operator | The trusted keys file, the ledger directory, the machine | The content of approvals |
| Engine | Reading what the browser shows; checking signatures, scope and order | Judging whether a binding is a good one |
| Plan author (recording or model) | Proposing a journey | Any expected value, any place to read, any statement of trust |
| Application under test | Being the thing observed | Saying anything about itself that is taken on trust |

The application is taken to be the owner's own and not hostile. A hostile
application is out of scope for trust (it can display whatever it likes), but
it must still not be able to forge, alter or replay an approval.

## What a binding is

A binding belongs to one project and one revision of one criteria snapshot.
It is data, not prose, and every field has a fixed form.

```
Binding
  id                 plain name, unique in the project
  snapshotId         the criteria snapshot
  snapshotSha256     the revision: the hash of its exact text
  quote              a sentence of that text, exact substring (as today)
  observation        where and what to read          (see Observation)
  expected           the value, with where in `quote` it is written
  conditions         ordered list, at least one      (see Condition)
```

```
Observation
  path               a static path of the target: exact, no query, no pattern
  locator            { by: "testid", value } or { by: "role", role, name }
  valueKind          "number" | "amount"             (text is not in the first stage)
  unit               as the engine's units today
```

```
Condition, one of
  observed           an Observation and an expected value, the value written in `quote`
  engine-fact        one of a fixed list the engine itself establishes, for example
                     "the signed-in account was created by the engine for this
                     scenario and had no history when created"
```

Rules about the content of a binding, checked when it is approved and again
by the engine:

- `quote` is an exact substring of the snapshot's text.
- Every expected value, of the observation and of each `observed`
  condition, is written in `quote` and is taken from there by position. A
  value that is not in the approved sentence cannot be expected.
- The path is the binding's own. It is not a name looked up in the operator's
  `evidenceRoutes`, so nobody who edits that list can move a binding.
- A binding with no condition is refused. If a requirement truly has none,
  the owner says so with an `engine-fact` chosen for the purpose, on record.

**What the owner is answerable for.** The engine guarantees that the
conditions listed were observed. Whether those conditions are enough for the
sentence is a judgement, and it is the approver's. The approval screen must
show the sentence beside the conditions so that the judgement is made with
the text in view.

## The signed statement

Approval of bindings is durable: it is stored by the control plane and
reused for every run of that project on that criteria revision. What the
engine is handed is not that record. It is a **statement issued for one
run**, short-lived, in the same way criteria approvals are issued today.

That is how "reusable across runs" and "replay protection" are both kept:
the approval is reused, the signed statement is not. A long-lived statement
without a run in it could not be revoked and could be presented to any run
for ever, so that form is rejected.

```
releaseproof-binding-approval-v1        domain: first line of what is signed
approvalVersion
keyId
workspaceId
projectId
runId
targetOrigin
scopeSha256                             the run's scope, as in criteria approvals
snapshotId
snapshotSha256
bindingsSha256                          hash of the canonical form of every binding
                                        approved for this snapshot revision
approvedBy
approvedAt
issuedAt
expiresAt
```

- **Domain separation.** The first signed line differs from
  `releaseproof-criteria-approval-v1`, and the field count differs. A
  criteria approval can never verify as a binding approval or the reverse,
  with the same key or another.
- **Scope.** Workspace, project, run, target origin, the run's scope hash and
  the snapshot revision are all in what is signed. A statement for another
  project, origin, run or revision is refused.
- **The set, not a member.** One statement covers the whole set of bindings
  for a snapshot revision, by hash. Leaving one out, adding one or changing
  a field changes the hash. The bindings themselves travel beside the
  statement and are checked against it.
- **Expiry.** As criteria approvals: not dated in the future, not issued
  before the approval it states, valid for at most 24 hours.
- **Replay.** A run starts once (the existing ledger). The statement names
  the run, so it lives and dies with it.
- **Revocation.** The control plane stops issuing. Statements already issued
  end within 24 hours.
- **Criteria change.** The revision is the hash of the text. Any change to
  the text is a new revision with no bindings until someone approves them.
  The dashboard may offer to carry over a binding whose quoted sentence is
  unchanged, but a person approves it again. Software does not decide which
  changes are "relevant".

## When the engine counts a requirement

A plan step may ask for a bound observation by naming the binding's id. That
is all it may say. The place, the expected value and the conditions are
taken from the binding; anything the plan says about them is ignored.

A requirement is **verified** only if all of this holds, each established by
the engine and none by the plan or the page's own account of itself:

1. A binding statement verified for this run, and the binding is in the set
   it covers.
2. The binding's snapshot revision is one the run's criteria approvals
   cover.
3. Every condition was established in this scenario, in the binding's
   sequence, before the observation, in the same browser context.
4. At each reading the main frame's address, as the browser reports it, is
   on the target origin with exactly the binding's path.
5. The locator finds exactly one element, in the main document, and the
   engine finds it displayed.
6. The value read is of the bound kind and unit and equals the expected
   value.
7. The value is the same on a second reading after the page has settled.

A requirement is **failed** with the same standing if 1 to 5 hold and the
value differs. A trusted failure is as much a trusted verdict as a trusted
pass, and is switched on with it, not before.

Anything short of that is `unverified`, and the reason is one of a fixed
list (for example "condition not observed", "element found more than once",
"not on the bound path"). No free text.

The run's `verdictsTrusted` is true only if every requirement the run counts
is verified or failed by these rules.

## Threat model

| # | Who | Attempt | Outcome |
|---|---|---|---|
| 1 | Plan author | Point the comparison at a different element that shows the right value | The plan's own target is ignored for a bound observation. An unbound comparison stays "observed", never verified |
| 2 | Plan author | Skip the journey and read the element | Conditions not established: unverified |
| 3 | Plan author | Establish conditions out of sequence, or in another scenario | Unverified |
| 4 | Plan author | Use requirement A's binding for requirement B | The binding names its own sentence. It verifies A or nothing |
| 5 | Plan author | State an engine fact ("the account is new") | Engine facts are established by the engine only. The plan cannot assert one |
| 6 | Plan author | Choose the moment of reading | See residual risk 1 |
| 7 | Request author | Present bindings other than the approved set | Hash mismatch: refused |
| 8 | Request author | Present another project's, origin's or revision's statement | Scope mismatch: refused |
| 9 | Anyone | Replay a statement for another run, or after expiry | Run id and expiry are signed: refused |
| 10 | Anyone | Present a criteria approval as a binding approval | Domain line and layout differ: signature does not verify |
| 11 | Application | Show the bound element twice, hidden, or in a frame | Unverified |
| 12 | Application | Show a value in the bound element that is not the truth | See residual risk 2 |
| 13 | Application | Change the address without loading a page, then show other content | See residual risk 3 |
| 14 | Application | Read, alter or forge an approval | Approvals never enter the browser. The engine's process holds them |
| 15 | Model | Propose a binding that suits it | A proposal is nothing until a person approves it |
| 16 | Approver | Approve without reading | See residual risk 5 |
| 17 | Holder of a run's ingestion token | Send the dashboard a result that claims trust | See residual risk 4 |

## Residual risks, stated plainly

1. **Timing is the plan's.** Whoever writes the journey decides when a bound
   observation is asked for. Asked too early it produces a false failure.
   Where an application passes through the expected value on its way to
   another, it could produce a false pass. Conditions in sequence and the
   second reading narrow this; they do not close it.
2. **Displayed is not true.** A black-box check verifies what the
   application displays in the bound element. The stored value, or the same
   value elsewhere, may differ. Reports must say "displayed", not "is".
   What the engine reads is the document's text; styling can make a person
   see something else.
3. **The address is the application's word** in a single-page application.
   Requiring a full page load would refuse legitimate applications, so it is
   not required. A hostile application is out of scope.
4. **A result is as trustworthy as the worker that wrote it.** The dashboard
   cannot check a signature inside a result or observe again. Once trusted
   results are accepted, whoever holds a run's ingestion token can submit
   one. Trusted results must therefore be accepted only from workers that
   meet the hosted-execution gates (network restriction, isolation from the
   page under test), and a result must name its producer. **This is a gap
   in today's design and is not solved by binding.** Options are in "Open
   questions".
5. **Approval can be careless.** The approval screen is part of the security
   boundary. It must show the sentence, the element and the conditions
   together, and must not offer "approve all".
6. **Sufficiency is a judgement.** The engine cannot tell whether the
   approved conditions are enough for the sentence.
7. **Numbers only at first.** Text comparisons stay unverified in the first
   stage: equality of text has too many forms (case, spacing, language).

## What changes, and where

| Where | Change |
|---|---|
| Engine, `remote/authority` | A second statement type with its own domain line, parsed and verified beside criteria approvals. The existing statement is untouched |
| Engine, plan and execution | A step that asks for a bound observation by id; engine facts; the counting rules above |
| Engine, result | A new format version: per requirement, the binding id, the conditions established and the fixed reason when unverified. The current version stays readable and is still what an untrusted run writes |
| Dashboard database | Bindings and their approval per project and snapshot revision. The constraints that refuse a trusted result stay until activation, then are relaxed only for the new version and only where each verified requirement names a binding |
| Dashboard screens | Propose, review and approve bindings; show what a verified requirement rested on |
| Control plane | Issues binding statements per run. A local, labelled stand-in until it exists |

## Stages

Each is a small pull request with independent review. None changes what a
run reports until the last.

1. This note and its threat model, reviewed independently. No code.
2. Engine: the statement type, parsing, verification, scope and expiry
   checks, with refusal tests. Not yet used by a run.
3. Engine: bound observations, engine facts and the counting rules, computed
   and written to the working record only. `verdictsTrusted` stays false by
   a constant.
4. Dashboard and database: store, propose and approve bindings. Local
   signing stand-in, labelled development-only.
5. Result format version and dashboard rendering, still untrusted.
6. The negative suite: every row of the threat model as a test that must
   end unverified or refused. Also: wrong element, right element on the
   wrong path, duplicate test ids, hidden element, element in a frame,
   reformatted value, condition skipped, condition out of sequence, binding
   for another revision, expired statement, statement for another run,
   criteria approval presented as a binding approval.
7. Independent security review of the whole.
8. Activation: one engine change (the constant) and one database migration
   (the constraints), each needing the owner's explicit approval. First for
   the synthetic shop, from a recorded run.

Two locks, in two repositories, keep trust off until stage 8: the engine
constant and the database constraints. Neither alone is enough to show a
trusted verdict.

## Open questions for the owner

1. **Result authenticity (residual risk 4).** Accept "trusted results only
   from workers that meet the hosted gates", or also have the worker sign
   each result with a key the control plane gave it for that run? The second
   is stronger and is more work; it could follow activation for local,
   synthetic use but should precede any customer use.
2. **Per-run issuance.** This note reads "reusable across runs" as: the
   approval is reused, and a fresh signed statement is issued for each run.
   Confirm, or say that a long-lived statement is wanted in spite of the
   revocation and replay cost.
3. **Any change is a new revision.** This note treats every change to the
   criteria text as needing renewed approval, with a carry-over offered for
   unchanged sentences. Confirm that software should not judge relevance.
4. **Trusted failures** are switched on together with trusted passes.
   Confirm.
