# Design: trusted checks (requirement, element and condition binding)

Status: **design for review, second draft. Nothing here is implemented.**
Tracked as RPAI-33. Until every stage below is built, has passed an
independent security review, and the owner has explicitly approved
activation, a remote run reports `verdictsTrusted: false` and no requirement
is counted as verified.

The first draft was reviewed independently and found not sound: five ways it
would have allowed a false trusted verdict or overstated a safeguard. They
are listed at the end with what changed. The main change is in the next
section.

## The problem

A remote run compares a value the application shows with a value from the
approved criteria. Today the place the value is read from, and the journey
that leads there, are chosen by whoever wrote the plan: a recording now, a
model later. A match shows what the application displayed at that place. It
does not show that the requirement holds:

1. **The element.** Nothing a person approved says that the place read is
   the thing the requirement is about.
2. **The conditions.** A requirement holds "after" or "when" something.
   Nothing trusted shows that the journey produced that state.

## The central decision of this draft

The first draft let the plan name a binding and let the engine check that
some conditions had been seen earlier. That is not enough. A plan could read
a condition as one account and the value as another, or type the expected
number into the bound field and read it back.

**In this draft the plan has no part in a trusted check.** A binding is a
complete, approved check: where to start, what to do, what must be seen on
the way, and what to read at the end. The engine carries out every approved
check itself, each in a fresh browser, doing only the approved steps. A
recording or a model may *propose* a check. What it does in its own run
stays "observed" and never counts.

This is the honest shape of the thing: a trusted verdict comes from a check
a person approved, step by step. Autonomous exploration and trusted
verification are separate, as the owner decided.

## Decisions made by the owner (22 November 2026)

- A separate signed binding-approval statement. The signed request format
  and the criteria-approval statement do not change.
- Bindings are stored per project and approved criteria revision and are
  reused across runs. A fresh, short-lived, run-bound signed statement is
  issued for each run; approval and revocation are checked when it is
  issued.
- Any change to the criteria text is a new revision that needs renewed
  approval. One-click re-approval of unchanged bindings is fine. Trust is
  never carried forward silently.
- The role that may approve criteria may approve bindings.
- Element binding and condition binding are both mandatory.
- Trusted Passed and trusted Failed are enabled together. A trusted Failed
  rests on an authenticated, approved observation that contradicts the
  requirement with its preconditions satisfied. A missing observation, an
  incomplete journey, an unmet prerequisite or an execution error is never
  a trusted Failed.
- Worker-result authenticity is a gate before any customer use: a per-run
  authenticated result envelope, verified by the server. A signature is not
  proof that a result is correct or that a worker was not compromised.
- First trusted comparisons are numbers and amounts only.
- Domain separation, expiry, scope validation and replay protection are
  kept. No activation without a full independent security review and the
  owner's explicit approval. Requirements are not weakened to get a pass.

## Who is trusted with what

| Party | Trusted for | Not trusted for |
|---|---|---|
| Criteria owner | The criteria text; each approved check: its steps, conditions, place and expected value | Nothing else |
| Control plane | Authenticating the owner; signing what the owner approved; refusing to issue after revocation | Deciding anything about a requirement. **If it is compromised, everything is: there is no defence against a forged approval but removing its key** |
| Engine operator | The machine, the ledger directory, **and the trusted keys file. Whoever controls that file controls which approvals are believed** | Being overruled by a request |
| Engine | Carrying out approved steps and reading what the browser shows; checking signatures, scope and sequence | Judging whether a check is a good one |
| Plan author (recording or model) | Proposing checks; exploring | Any part of a trusted check |
| Application under test | Being the thing observed. **Where a check uses the application's own test-data interface to make an account, that the account is new is the application's word** | Saying anything else about itself that is taken on trust |

The application is taken to be the owner's own and not hostile. A hostile
application can display whatever it likes and is out of scope for trust, but
it must not be able to forge, alter or replay an approval.

## What a binding is

A binding belongs to one project and one revision of one criteria snapshot.
Every field has a fixed form. There is no free text but the quote.

```
Binding
  formatVersion
  id                 plain name
  snapshotId
  snapshotSha256     the revision: the hash of the snapshot's exact text
  quote              text of the snapshot, by position:
    start, end       offsets into the snapshot's text as approved, in UTF-16
                     code units, on line boundaries; at most 600 units
  setup              how the check starts                      (see Setup)
  steps              ordered list, at least one                (see Step)
  observation        the place to read at the end              (see Reading)
  expected           the value compared with the observation   (see Expected)
```

```
Setup, one of
  fresh-browser      a new browser context with nothing stored. Always applied;
                     named so that a check with no other setup says so
  fixture            a call to the application's own test-data interface:
                     method, path and body, all written here and so all
                     signed. The engine adds a key made from the run id and
                     the binding's hash, so no two runs share an account
```

```
Step, one of
  open               { path }
  fill               { path, locator, value }     value: a literal, or a named
                                                  field of the fixture's answer
  act                { path, locator, expects }   a click or submit by the engine.
                                                  expects: "write accepted" | "no write"
  see                { reading, expected }        a condition: a value that must
                                                  be shown before going on
```

```
Reading
  path               a static path of the target: exact, no query, no pattern
  locator            { by: "testid", value } or { by: "role", role, name }
  valueKind          "number" | "amount"
  unit

Expected
  start, end         offsets into the quote, in UTF-16 code units
  value              the number written there, as a decimal string
```

Rules about the content, checked when a binding is approved and again by the
engine. A binding that breaks one is refused, never repaired.

- **The quote** is the snapshot's text between the offsets, on whole lines.
  The approval screen shows it with the lines around it.
- **An expected value** is exactly one whole number as the engine's own
  reader of quoted numbers finds it at those offsets. The position is
  authoritative: the engine reads the number there again and refuses the
  binding if it is not `value`. A span inside a longer number or inside an
  identifier is refused.
- **Equality only.** A quote that contains a bound or a negation ("at
  least", "up to", "not", and the rest of the engine's existing lists) is
  refused for binding until those kinds of comparison exist. Equality would
  read "at least 100" showing 150 as a failure.
- **At least one `act` that expects a write, or one `see`**, besides the
  final observation. There is no null condition. If the owner believes a
  requirement has no precondition, it cannot be bound in this stage.
- **A locator may not contain the expected value**, and may not be a
  heading or a label: the same rules the engine applies to comparisons
  today.
- **Text** is refused unless already in Unicode NFC. The engine never
  normalises.

**What the owner is answerable for.** The engine guarantees that the
approved steps were carried out and the approved conditions seen. Whether
those steps and conditions are enough for the sentence is a judgement, and
it is the approver's.

## The signed statement

Approval is durable and stored by the control plane. What the engine is
handed is a **statement issued for one run**. The approval is reused; the
signed statement is not. Before issuing, the control plane checks that the
approval stands: not revoked, not older than the maximum age (see "Approval
and deployment"), and for the revision the run carries.

One statement per criteria snapshot in the run:

```
releaseproof-binding-approval-v1        domain: first line of what is signed
bindingApprovalVersion                  its own version, not the criteria approval's
keyId
workspaceId
projectId
runId
targetOrigin
scopeSha256                             the run's scope, as in criteria approvals
snapshotId
snapshotSha256
bindingFormatVersion
bindingCount
bindingsSha256
approvedBy
approvedAt
issuedAt
expiresAt
```

- **How it is signed.** As the criteria approval: the fields, one per line,
  in this sequence, signed with Ed25519. Every field is non-empty and
  matches `^[^\r\n]+$`, so no field can run into the next and two different
  statements cannot produce the same bytes.
- **Domain separation** rests on the fixed first line. A criteria approval
  cannot verify as a binding approval or the reverse, with the same key or
  another.
- **`bindingsSha256`** is defined exactly, as `scopeSha256` is: SHA-256 of
  `JSON.stringify` of an array whose first member is the string
  `releaseproof-bindings-v1` and whose second is the bindings sorted by id
  in code-unit order, each written as nested arrays in a fixed field
  sequence that covers every field the engine reads. Numbers are decimal
  strings; offsets are integers. Ids are unique in the set.
- **How it is carried.** In its own list, beside the criteria approvals and
  not among them: the existing code refuses a run if anything in the
  approvals list is not a criteria approval, and that stays so. A binding
  statement that is present and wrong refuses the run before the start
  ledger is claimed. A run with none runs as today, untrusted.
- **Scope, expiry, replay.** Workspace, project, run, origin, the run's
  scope hash and the snapshot revision are signed. Expiry as criteria
  approvals: not future-dated, not issued before the approval it states, at
  most 24 hours. A run starts once (the existing ledger), and the statement
  names the run.
- **Revocation.** The control plane stops issuing. Statements already
  issued end within 24 hours.
- **Keys.** The same keys may sign both kinds of statement. Separate keys
  would only limit what one stolen key can do.

## How the engine carries out a check

For each binding in each verified set, once per run, the engine itself:

1. Opens a new browser context with nothing stored, locale and timezone
   pinned and recorded.
2. Applies the setup. For a fixture it makes the call written in the
   binding, with its own key, and keeps the answer in the engine.
3. Carries out the steps in sequence, and nothing else. No step comes from a
   plan, and a plan cannot run between them.
4. Makes the final reading, twice.

Rules for every step and reading. Each is established by the engine from
outside the page. Where a check needs a fact about the page (its address,
whether an element is displayed), the engine gets it from the browser, not
by asking script that the page can replace.

- **Address.** Before a step or reading on `path`, the engine navigates
  there itself with a plain request. The answer is 2xx with no redirect.
  The main frame's address has exactly that path, byte for byte, with no
  query and no fragment. An application that routes by fragment is not
  supported in this stage.
- **One element.** The locator matches exactly one element, counting hidden
  ones, for both kinds of locator, in the main document.
- **Displayed.** The element has a box of non-zero size, is visible and not
  fully transparent with all its ancestors, is in the viewport after
  scrolling to it, and is the element found at the centre of its own box.
- **A reading** (a `see` or the observation) is made on a page the engine
  has just opened, with nothing done in it since: the rule the engine
  applies to untrusted plans today, unchanged. A value is never read from a
  page the check has typed into.
- **A number** is read by one strict grammar: ASCII digits, an optional
  leading minus, groups of exactly three if grouped, one spelling per unit.
  The currency sign is not compared, and the report says so.
- **A write.** After an `act`, the application accepted exactly the writes
  the step expects: one accepted write for "write accepted", none for "no
  write". Between the first step and the final reading there is no other
  accepted write.
- **The second reading** of the observation is made after a fresh
  navigation, at least a fixed interval after the first, under all the
  same rules.

## What a check's outcome is

Per binding, exactly one of:

- **verified.** Setup done; every step done under the rules; every `see`
  equal to its expected value; both final readings clean and equal to the
  expected value.
- **failed.** Setup done; every step done under the rules; every `see`
  equal to its expected value; both final readings clean, equal to each
  other, and different from the expected value. This is the only way to a
  trusted Failed: an approved observation that contradicts the requirement
  with every approved precondition satisfied.
- **unverified**, with one reason from a fixed list. Everything else: the
  setup failed; a step could not be done; an element was missing, doubled
  or not displayed; the address was not the bound one; a write was not as
  expected; a `see` did not match (a precondition is unmet, which is not a
  failure of the requirement); a reading was not a number; the two final
  readings differed; the time ran out; any error.

## What a run's verdict is

The denominator is **the signed sets**, never anything a plan lists.

- `passed`: at least one binding, and every binding of every set verified.
- `failed`: at least one binding failed.
- `unverified`: otherwise, including an empty set.

Standing is kept per binding. One unverified binding does not erase a
trusted failure of another.

What `passed` means, and what the report must say, is "all N approved checks
verified". It does not mean "all criteria hold": the engine cannot list the
requirements in a text, and a sentence nobody bound is not checked. The
dashboard shows the criteria with the bound sentences marked, so that what
is not covered can be seen.

A plan's own comparisons, from a recording or a model, are reported as
observations beside this. They never raise or lower the verdict.

In the result, a requirement is identified by its binding's hash, and its
text is the binding's quote. The result carries each binding's hash and the
set hash, so that what a verified requirement rested on is shown from that
exact binding and not from whatever now has the same name.

## Result authenticity

The dashboard cannot observe again, and cannot tell from a result how it
was made. Today the only thing between a result and the database is a
single-use token per run, and the first result wins. Once trusted results
are accepted, a token holder could submit a forged one and pre-empt the
real one.

**A per-run authenticated result envelope**, verified by the server:

- When a run is dispatched, the control plane makes a key pair for that
  run, records the public half with the run together with the snapshot
  revisions and binding set hashes it issued statements for, and gives the
  private half to the worker with the run.
- The worker signs, under the domain line `releaseproof-result-envelope-v1`:
  run, workspace and project ids; each snapshot id and hash; each
  `bindingsSha256`; the SHA-256 of the result's exact bytes; and for each
  piece of evidence its reference and SHA-256.
- The server accepts trusted fields only if the signature verifies with the
  run's key, the ids are the token's run, the snapshot and binding hashes
  are the ones recorded at dispatch, the result bytes hash to the signed
  value, and each stored piece of evidence hashes to its signed value.
  Otherwise the result is stored as untrusted, or refused.

**What this proves and does not.** It proves the result came from the
holder of that run's key, for that run and those approved sets, and was not
altered. It does not prove the worker was not compromised, and it does not
prove the result is correct. A worker that the page under test has taken
over signs whatever it is made to. Worker isolation and network
restriction remain separate gates.

This draft places the envelope **before activation**, not after: the
database is the only lock against a token holder, so it should not be
opened without it.

## The locks, stated accurately

- **The engine constant** (`verdictsTrusted` written false, in the run and
  again where the result is built) stops an honest engine from claiming
  trust. It does nothing against someone who holds an ingestion token.
- **The database constraint** that refuses a trusted result is the only
  lock against a token holder. It cannot check a signature or look up the
  approved bindings; a rule that "each verified requirement names a
  binding" would only test the shape of what the result says about itself.
  So the constraint is not what gets relaxed. Trust is accepted only by the
  ingestion function, after it has verified the envelope, for a project
  the owner has switched on, for a remote run that is not a prepared one.

**A gap that exists today, found by this review.** The constraint refuses a
result that says `verdictsTrusted: false` and `passed`, and requires a result
that names the engine as its producer to state trust. A result that leaves
`verdictsTrusted` out and does not name the engine as its producer is stored
as `passed` with verified requirements, and only the screen qualifies it
("Passed, trust not stated"). That form exists for results prepared in
advance. Whoever holds a remote run's token chooses what the result says
its producer is, so for a remote run it should be refused whatever it says.
This is to be fixed in the dashboard separately, before anything here.

## Approval and deployment

An approval describes the application as it was when approved. A later
release may reuse a test id for something else, and the check would then
verify the wrong thing with full standing.

- A durable approval has a maximum age, after which it must be approved
  again.
- Where the application reports its version, it is recorded with the
  approval and with each run, and a difference is shown.
- This narrows the risk. It does not close it.

## Threat model

| # | Who | Attempt | Outcome |
|---|---|---|---|
| 1 | Plan author | Point a comparison at an element that shows the right value | A plan's comparison is an observation. It is in no trusted check |
| 2 | Plan author | Skip the journey, or do it as another account | The plan does not perform trusted checks. The engine performs every approved step in a fresh browser |
| 3 | Plan author | Type the expected value into the bound field and read it back | Readings are made on a page just opened by the engine, with nothing done in it |
| 4 | Plan author | Leave a failing requirement out of the plan | The denominator is the signed set |
| 5 | Plan author | Look first, and ask for the check only when it will pass | The plan cannot ask. Every check runs once |
| 6 | Request author | Present bindings other than the approved set, or fewer | Hash and count are signed: refused |
| 7 | Request author | Present another project's, origin's, run's or revision's statement | Scope mismatch: refused |
| 8 | Anyone | Replay a statement after expiry or for another run | Refused |
| 9 | Anyone | Present one kind of approval as the other, or put one in the other's list | Does not verify; a wrong entry refuses the run |
| 10 | Anyone | Two bindings with one name, in one set or across snapshots | Ids are unique across the run's sets, or the run is refused |
| 11 | Application | Show the bound element twice, hidden, transparent, covered, off screen or in a frame | Unverified |
| 12 | Application | Answer at the bound path with a redirect or an error page | Unverified |
| 13 | Application | Show a number in another spelling ("1,24", "24,99") | The strict grammar refuses it: unverified |
| 14 | Application | Show a stale value, then the right one | Two readings on fresh pages, an interval apart; unequal readings are unverified. See residual risk 1 |
| 15 | Application | Show in the bound element a value that is not the truth | Residual risk 2 |
| 16 | Application | Reuse a test id for another value in a later release | Residual risk 3 |
| 17 | Application | Report through its test-data interface that an old account is new | Residual risk 4 |
| 18 | Application | Read, alter or forge an approval or a run key | They never enter the browser |
| 19 | Model | Propose a check that suits it | A proposal is nothing until a person approves it |
| 20 | Approver | Approve without reading, or approve too few conditions | Residual risks 5 and 6 |
| 21 | Token holder | Submit a forged trusted result, or one before the real one | Refused without a valid envelope. A compromised worker: residual risk 7 |
| 22 | Operator | Replace the trusted keys file | Out of reach of this design: the operator is trusted with it. The server checks the envelope with a key it issued itself, so a result made this way does not become trusted at the dashboard |
| 23 | Control plane, compromised | Sign anything | Total. Residual risk 8 |

## Residual risks, stated plainly

1. **Timing.** Two readings an interval apart do not catch every delay
   between a write and its display. A value that is late by more than the
   interval is read as a contradiction. The interval is a setting, and a
   trusted failure should be read as "displayed otherwise, twice".
2. **Displayed is not true.** A black-box check verifies what the
   application displays in the bound element. The stored value may differ.
   Reports say "displayed", not "is".
3. **An approval ages.** See "Approval and deployment".
4. **A fresh account is the application's word** where a fixture is used.
   The run-bound key makes a new one each run if the interface honours it.
5. **Approval can be careless.** The approval screen is part of the
   security boundary: it shows the sentence in context, every step and
   condition, and offers no "approve all" for new bindings.
6. **Sufficiency and coverage are judgements.** Whether the approved steps
   are enough for the sentence, and whether every sentence that matters has
   a binding, the engine cannot tell.
7. **A compromised worker** signs a false result with a valid key.
8. **A compromised control plane** can approve anything.
9. **Narrow first stage.** Numbers and amounts, equality, static paths, no
   fragment routing. Much real criteria text cannot be bound yet and stays
   unverified. That is intended.
10. **Cost of approval.** A check is approved step by step. This is real
    work for the owner, and is what the trust rests on.

## What changes, and where

| Where | Change |
|---|---|
| Engine, `remote/authority` | A second statement type, own domain line and version, own list. The existing statement and list are untouched |
| Engine, new | The check runner: setup, steps, readings and outcomes as above. It shares the browser tools and shares no state with a plan's scenarios |
| Engine, result | A new format version: per binding, its hash, outcome and fixed reason; the set hashes; the envelope. The current version is still what an untrusted run writes |
| Dashboard database | Bindings and approvals per project and snapshot revision; per-run keys and issued set hashes; envelope verification inside the ingestion function |
| Dashboard screens | Propose, review and approve bindings; show what a verified requirement rested on, by hash; show the criteria with bound sentences marked |
| Control plane | Issues binding statements and run keys. Until it exists, a local stand-in: its keys carry a reserved id that the engine accepts only for a target on the same machine, and the server refuses trust for a result against such a target outside a development database |

## Stages

Each is a small pull request with independent review. None changes what a
run reports until the last.

1. This note and its threat model, reviewed independently. No code.
2. Dashboard: refuse, for a remote run, a result that leaves
   `verdictsTrusted` out, whatever producer it names (the gap above), with
   a database test.
3. Engine: the statement type, the exact hash, parsing and verification,
   with refusal tests. Not used by a run.
4. Engine: the check runner and its outcomes, written to the working record
   only, with the negative suite in the same pull requests, not after.
   `verdictsTrusted` stays false at both places, and a test holds it there.
5. Dashboard and database: store, propose and approve bindings. Local
   signing stand-in, restricted as above.
6. Result format version; the ingestion function accepts it and still
   refuses trust; dashboard rendering, untrusted.
7. The result envelope: run keys, worker signing, server verification.
8. Independent security review of the whole, including the exact change
   that activation would make.
9. Activation, needing the owner's explicit approval: the engine constant,
   and the per-project switch in the ingestion function. First for the
   synthetic shop on a development database.

A real control plane is not in these stages. Activation beyond a
development database needs it, and every hosted-execution gate.

## The negative suite

Every one must end refused or unverified, and none may end verified or
failed.

- **Run level:** an empty set; a plan that covers none, some or other
  requirements; a plan's own comparison that matches.
- **Statement:** each kind of approval presented as the other and placed in
  the other's list; another run, project, origin, revision or scope hash;
  expired; future-dated; valid for too long; a set reordered, with one
  binding more or fewer, with a wrong count, or with text not in NFC; an id
  used twice, in one set and across snapshots.
- **Binding content:** offsets off a line boundary; an expected span inside
  a longer number or an identifier; a value that is not the number at the
  offsets; a quote with a bound or a negation; no `act` and no `see`; a
  locator that contains the expected value.
- **Address:** a query, a fragment, a trailing slash, another letter case;
  a redirect onto the bound path; an error answer at the bound path.
- **Element:** missing; twice, one hidden; zero size; transparent; covered;
  off screen; in a frame; page script that falsifies its own measurements.
- **Reading:** "1,24", "24,99", "2499" for "24.99", a Unicode minus,
  "100.0"; a value typed by the check itself; a value that changes between
  the two readings.
- **Journey:** a step that cannot be done; a write where none is expected
  and the reverse; a second write; a `see` that does not match (must be
  unverified, never failed); a fixture call that fails; the time limit.
- **Database:** a trusted result in the old format; a trusted result with
  a valid token and no envelope, a wrong key, a changed byte, a changed
  picture, or other set hashes; a result that leaves trust out; a second
  result for the run.

And the positive cases: a check that verifies, and a check that fails with
every precondition satisfied.

## What the first review found, and what changed

| Finding | Change |
|---|---|
| A plan could leave failing requirements out and the run would read as passed | The denominator is the signed set; verdict rules rewritten |
| "The account is new" was called an engine fact, but it is the application's word, with keys a replay reuses | Fixtures are named as the application's word, written in the binding, keyed by run |
| Seeing a condition did not show that the journey produced it | The engine performs the whole approved journey; the plan performs none of it |
| A bound reading was weaker than today's untrusted reading | Readings only on a page just opened by the engine, nothing done in it |
| "Two locks" overstated the database constraint | Stated accurately; the envelope comes before activation; today's gap named |
| Under-specified statement, positions, numbers, addresses, "displayed", timing, identity; approval ageing; trust table; suite gaps | Each specified above |

## Open questions for the owner

1. **A binding is now a whole approved check, not a pointer to an
   element.** That is more to approve, and it is what makes the verdict
   trustworthy. A lighter form was found unsound. Confirm this direction.
2. **The envelope before activation**, including for the synthetic shop.
   The owner set it as a gate before customer use; this draft is stricter.
   Confirm, or allow activation on a development database without it.
3. **Maximum age of an approval**, and the interval between the two
   readings: values to be proposed with the implementation.
4. **Wording of a passed run:** "All N approved checks verified", not
   "Passed" alone and not "Ready for release". Confirm.
