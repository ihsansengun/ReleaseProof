# Design: trusted checks (requirement, element and condition binding)

Status: **design for review, fourth draft. Nothing here is implemented.**
Tracked as RPAI-33. Until every stage below is built, has passed an
independent security review, and the owner has explicitly approved
activation, a remote run reports `verdictsTrusted: false` and no requirement
is counted as verified.

The first two drafts were reviewed independently and found not sound; the
third was found sound, with corrections that are made here. What each
review found, and what changed, is listed at the end. The main change is in
the next section.

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
- A trusted Failed also needs an approved, bounded settling time and
  repeated observations that show the same contradiction. Where a write
  cannot be attributed, the starting state is not established, an error
  occurs or the settling conditions are not met, the outcome is Unverified.
  The time and the number of readings are explicit and suited to the
  application, not a fixed delay in the code.
- A binding is a complete approved check that the engine carries out
  independently, with its preconditions and observations.
- A per-run authenticated worker-result envelope, verified by the server,
  is in place before trusted verdicts are activated. A signature is not
  proof that a result is correct or that a worker was not compromised.
- Coverage is reported accurately: "all N approved checks verified" only
  when every check has a trustworthy outcome, with Passed, Failed and
  Unverified told apart.
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
  locale, timezone   what the browser is set to, as the approver saw the application
  background         method-and-path pairs of the target that the application
                     sends by itself and that are not counted as writes
  tolerated          method, path and status of answers of 400 or above that
                     the approver accepts as normal for this application
  settling           within: the time the application may take to show a
                     write, in seconds, at most 120 (a provisional bound);
                     readings: how many final readings are made, at least 3
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
                     signed. The body must hold the engine's key placeholder,
                     which the engine fills with a key made from the run id
                     and the binding's hash, so that no two runs share an
                     account. A body without it is refused
```

```
Step, one of
  open               { path }
  fill               { path, locator, value }     value: a literal, or a named
                                                  field of the fixture's answer
  act                { path, locator, expects }   a click or submit by the engine.
                                                  expects: { method, path } of the
                                                  one write it causes, or "no write"
  see                { reading, expected }        a condition: a value that must
                                                  be shown before going on.
                                                  expected: from the quote, or a
                                                  literal marked as not from it
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
  reader of quoted numbers finds it at those offsets (that reader works on
  a rewritten copy of the text, so the mapping of offsets between the two is
  part of the definition and is tested). The position is
  authoritative: the engine reads the number there again and refuses the
  binding if it is not `value`. A span inside a longer number or inside an
  identifier is refused.
- **Equality only.** A quote that contains a bound or a negation ("at
  least", "up to", "not", and the rest of the engine's existing lists) is
  refused for binding until those kinds of comparison exist. Equality would
  read "at least 100" showing 150 as a failure.
- **At least one `see`** besides the final observation. There is no null
  condition. If the owner believes a requirement has no precondition, it
  cannot be bound in this stage.
- **The first `see` of a check with a fixture is of the starting state**
  the fixture is meant to give (for example a balance of nothing). If the
  application hands back an account that was used before, the check stops
  there. No `act` that expects a write comes before it but those it
  witnesses itself, such as signing in.
- **Every later `act` that expects a write has a witness**: one reading,
  not the observation's, that is seen before the `act` with one expected
  value and after it with another. A change the engine sees for itself is
  evidence that the write did something; an answer from the application
  that it accepted a request is not. Whether the witness is the right
  thing to look at is the approver's judgement (residual risk 6).
- **A `see` may expect a literal** that is not in the quote: a starting
  state is rarely written in the sentence. The literal is in the binding
  and so signed, and the approval screen marks it "not from the criteria
  text". The final observation's expected value always comes from the
  quote.
- **No credentials in a binding.** A `fill` with a literal into a field
  that holds a secret by its kind makes the check unverified (the kind of a
  field is known only when the check runs). A value taken from a fixture's
  answer is named by an own field of that answer, must be a string or a
  number of bounded length, and is treated as a secret by the engine: it is
  never written to a result and its field is covered in pictures.
- **In a check with a write, the observation's own reading is seen before
  the first write that the starting-state `see` does not witness, with an
  expected value that is not the final one.** (An element that shows no
  number before the journey, such as an empty state, therefore cannot be
  bound in this stage.) A value
  that was already there before the journey says nothing about the
  journey: without this, a purchase that awards nothing would verify
  against a balance that was right all along.
- **An `act` may not expect a write that is also listed as background.**
- **A locator may not contain the expected value**, test ids included. That
  is stricter than the engine's rule for comparisons today. Whether the
  element found is a heading or a label can only be told when the check
  runs; such a reading is unverified.
- **The lists of bounds and negations are English.** A quote in another
  language is refused for binding in this stage.
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
  sequence that covers every field the engine reads, with a tag for each
  kind of setup and step. Numbers are decimal strings; offsets are
  integers. Ids are unique across all the sets of a run. The exact
  sequence is written out, with test vectors, before the stage that
  implements it.
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
- **Who may approve.** The control plane records an approval of bindings
  only from someone who holds the role that may approve criteria in that
  project, checked when the approval is recorded.
- **Revocation.** The control plane stops issuing. Statements already
  issued end within 24 hours.
- **Keys.** The same keys may sign both kinds of statement. Separate keys
  would only limit what one stolen key can do.

## How the engine carries out a check

The checks of a run are carried out before any step of a plan, one at a
time, in the sequence of their ids. A plan's exploration shares the
application's stored state with them, and must not get there first. For
each binding in each verified set, once per run, the engine itself:

1. Opens a new browser context with nothing stored, set to the binding's
   locale and timezone.
2. Applies the setup. For a fixture it makes the call written in the
   binding, with its own key, from outside the browser context so that
   nothing the call sets is carried into it, and keeps the answer in the
   engine.
3. Carries out the steps in sequence, and nothing else. No step comes from a
   plan, and a plan cannot run between them.
4. Makes the final readings.

Rules for every step and reading. Each is established by the engine from
outside the page. Where a check needs a fact about the page (its address,
whether an element is displayed), the engine gets it from the browser, not
by asking script that the page can replace.

- **Address.** An `open` and every reading begin with the engine
  navigating to the path itself with a plain request. The answer is 2xx
  with no redirect, and the main frame's address then has exactly that
  path, byte for byte, with no query and no fragment. A `fill` and an `act`
  do not navigate: the address must still be their `path` from the `open`
  before. After an `act` that expects a write the page may go anywhere on
  the target's origin, and the next step must be an `open` or a reading.
  After an `act` that expects none, a `fill` or an `act` may follow if the
  address has not changed. An application that
  routes by fragment is not supported in this stage.
  (Decided by the owner on 23 November 2026, and built so: a page may change
  its address through the history interface to the very address it is bound
  to, which frameworks do as they start; that is not a change of address.
  Nothing broader is permitted. One document is loaded, the engine's. After
  an `act` that expects a write the page may go anywhere, but the write must
  be one the browser names as the opened document's at its bound address,
  and a form that is sent is taken only from a page with no frame and no
  other page beside it, then or since the act began (which also refuses a
  form that leads to a page with a frame in it); after a `fill`, and after an `act` that expects
  none, the page must still be the one that was opened. This narrows who
  can have sent a write; it does not prove it: a frame or page of the same
  origin calling the opened page's own functions is not told apart, and a
  fixture's value is known to the script of the page it is typed into. The
  rules as carried out, and their limits, are in `docs/check-runner.md`.)
- **Settled.** A reading is taken only once the page has no request in
  flight, and again after scrolling to the element. A page that never
  comes to rest (one that keeps a request open) is unverified, with that
  reason.
- **One element.** The locator matches exactly one element, counting hidden
  ones, for both kinds of locator, in the main document.
- **Displayed.** The element has a box of non-zero size, is visible and not
  fully transparent with all its ancestors, is in the viewport after
  scrolling to it, and it or something inside it is what is found at the
  centre of its box.
- **A reading** (a `see` or the observation) is made on a page the engine
  has just opened, with nothing done in it since. These are the conditions
  the engine demands of an untrusted plan's readings today, but established
  from the browser and not, as some are today, by asking script in the
  page. A value is never read from a page the check has typed into.
- **A number** is read by one strict grammar: ASCII digits, an optional
  leading minus, groups of exactly three if grouped, one spelling per unit.
  A reading in any other spelling is unverified, not a mismatch.
  The currency sign is not compared, and the report says so.
- **A write.** After an `act` that expects one, the application answered
  exactly one request of the named method and path, with a status below
  400. After an `act` that expects none, it answered none. Requests listed
  as `background` are not counted, and neither is the engine's own fixture
  call. A plain read is a GET or a HEAD and nothing else. Any other request
  to the target, at any point of the check, makes the check unverified.
  A status below 400 shows only that the application answered; that is why
  each such `act` must be witnessed by a `see`. Effects caused through a
  plain read or a socket are not seen at all (residual risk 11).
- **Nothing went wrong.** Anywhere in the check: no answer from the target
  of 400 or above, no failed request to the target, no uncaught error in
  the page. Not counted: requests to other hosts, which the engine itself
  blocks; requests cancelled by a navigation the check made; and answers
  listed in the binding as `tolerated`. A background request that is
  answered with an error counts like any other. Otherwise the check is
  unverified, whatever it read.
- **A `see` after a write** may be read again, on a fresh page each time,
  until it matches or the binding's settling time has passed. If it never
  matches, the check is unverified.
- **The final readings.** The observation is read as many times as the
  binding's `settling` says, each time on a page freshly opened by the
  engine under all the same rules: the first at once, the last not before
  the approved time has passed since the last write of the check, signing
  in included (in a check with no write, since its first step), the others
  spread between. The time is the approver's statement of how long this
  application may take to show a write. It is part of the binding, bounded,
  and not a delay fixed in the code.

## What a check's outcome is

Per binding, exactly one of:

- **verified.** Setup done; every step done under the rules; every write
  witnessed; every `see` equal to its expected value; nothing went wrong
  anywhere in the check; every final reading clean; and from some reading
  on, through the last, the value read is the expected one, at least twice.
- **failed.** Setup done; every step done under the rules; every write
  witnessed by its `see`; every `see` equal to its expected value; nothing
  went wrong anywhere in the check; every final reading clean, on a settled
  page; and every one of them, from the first to the last, after the whole
  approved settling time, shows the same value, which is not the expected
  one. This is the only way to a trusted Failed: an approved observation,
  repeated over the approved time, that contradicts the requirement with
  every approved precondition satisfied and witnessed.
- **unverified**, with one reason from a fixed list. Everything else: the
  setup failed; a step could not be done; an element was missing, doubled
  or not displayed; the address was not the bound one; a write was not as
  expected; a `see` did not match (a precondition is unmet, which is not a
  failure of the requirement); a write was not witnessed; a reading was
  not a number; the final readings did not all agree, or the value came
  and went; an answer of 400 or above, a failed request or a page
  error anywhere; an uncounted write; the time ran out; any error. A
  mismatch seen in such a check is reported as "contradiction seen,
  preconditions not established", and is not a failure.

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

- **The key.** The worker makes a key pair for the run and registers the
  public half when it claims the run: once per run, the first registration
  stands, and it comes before any result. Registration is authenticated by
  a credential of the worker's own, separate from the run's token. **No
  such credential exists today**: a worker's only credential is the run's
  token. Until it does, an envelope shows that a result was not altered,
  not where it came from. The private half never leaves the worker. (If
  the key were handed out with the run, as the ingestion token is, whoever
  held the token would hold the key, and the envelope would add little.)
- **What the server stores at dispatch**, in the same transaction as
  issuing the statements: each snapshot id and hash, each `bindingsSha256`
  and count, and the target origin. The run's public key is stored when
  the worker claims the run.
- **What is signed**, under the domain line
  `releaseproof-result-envelope-v1`: run, workspace and project ids; each
  snapshot id and hash; each `bindingsSha256`; the SHA-256 of the result
  exactly as the engine wrote it, byte for byte; and for each piece of
  evidence its reference and the SHA-256 of its bytes. The engine signs,
  not a script after it. Evidence travels beside the result, not inside
  it, so adding pictures does not change what was signed. The result is
  submitted as text and hashed before it is parsed.
- **What the server checks**: the signature, with the run's registered
  key; that the ids are the token's run; that the snapshot and set hashes
  are those stored at dispatch; that the submitted text hashes to the
  signed value; that each stored piece of evidence hashes to its signed
  value.
- **Refusal.** A result that claims trust and fails any check is refused
  and nothing is stored. It is never stored "as untrusted": the dashboard
  does not rewrite a result or decide its standing. A refusal does not use
  up the run's token. For a run that was dispatched with binding
  statements, a result without a valid envelope is refused even if it
  claims no trust, so that a token holder cannot put an untrusted result in
  first.
- **Where it is verified.** The database as set up cannot verify an Ed25519
  signature. Verification is done by a named server component, which is
  then the only path able to record that an envelope was verified. Which
  component is decided and reviewed in the envelope's own stage.

**What this proves and does not.** It proves the result came from the
worker that claimed the run, for that run and those approved sets, and that
neither it nor its evidence was altered afterwards. It does not prove the worker was not compromised, and it does not
prove the result is correct. A worker that the page under test has taken
over signs whatever it is made to. Worker isolation and network
restriction remain separate gates.

This draft places the envelope **before activation**, not after: the
database is the only lock against a token holder, so it should not be
opened without it.

## The locks, stated accurately

- **In the engine**, `verdictsTrusted` is written false at one place today
  (where a run's record is made); the place where the result is built reads
  it from the record. Until activation it is to be held false at both, by a
  constant and a test. This stops an honest engine from claiming trust. It
  does nothing against someone who holds an ingestion token.
- **In the database**, a constraint on the table of results refuses every
  row that says `verdictsTrusted: true`, however the row gets there. It is
  the only lock against a token holder. It cannot check a signature or
  look up the approved bindings, so a rule such as "each verified
  requirement names a binding" would only test what a result says about
  itself.
- **At activation** that constraint is replaced, by a migration the owner
  approves, with one that allows `verdictsTrusted: true` only for the new
  format version and only on a row that carries the record of a verified
  envelope, in columns that only the verifying component can set. The
  screen reads trust from those columns as well as from the result, so a
  result's own word is never enough.

**A gap that exists today, found by this review.** The constraint refuses a
result that says `verdictsTrusted: false` and `passed`, and requires a result
that names the engine as its producer to state trust. A result that leaves
`verdictsTrusted` out and does not name the engine as its producer is stored
as `passed` with verified requirements, and only the screen qualifies it
("Passed, trust not stated"). That form exists for results prepared in
advance. Whoever holds a remote run's token chooses what the result says
its producer is, so for a remote run it should be refused whatever it says.
This is to be fixed in the dashboard separately, before anything here, in
the ingestion function, which knows what kind of run a result is for; the
table of results does not.

## A new revision of the criteria

Any change to the text is a new revision: a new hash, and no bindings.
Nothing is issued for it until bindings are approved for it.

- Re-approval of an old binding in one step is offered only where the
  quoted lines are byte for byte the same in the new text.
- The screen shows the lines around the quote in the old and the new text
  side by side: the same sentence under another heading may mean something
  else.
- What results is a new binding, with new offsets and a new hash, approved
  by a person at a recorded time. Nothing is carried forward without that.

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
| 14 | Application | Show a stale value, then the right one | Several readings on fresh pages across the approved settling time. A value that arrives and stays is verified; one that never arrives in that time is a failure; anything else is unverified. See residual risk 1 |
| 15 | Application | Show in the bound element a value that is not the truth | Residual risk 2 |
| 16 | Application | Reuse a test id for another value in a later release | Residual risk 3 |
| 17 | Application | Report through its test-data interface that an old account is new | Residual risk 4 |
| 18 | Application | Read, alter or forge an approval or a run key | They never enter the browser |
| 19 | Model | Propose a check that suits it | A proposal is nothing until a person approves it |
| 20 | Approver | Approve without reading, or approve too few conditions | Residual risks 5 and 6 |
| 21 | Token holder who is not the worker | Submit a forged trusted result, or an untrusted one before the real one | Refused without an envelope signed with the key the worker registered. This holds once workers have a credential of their own; with the token alone a holder could register a key first. Someone who has the worker has its key: residual risk 7 |
| 22 | Operator | Replace the trusted keys file and present a set of their own | The engine would believe it. The server would not: such a set has other hashes than those stored at dispatch, so the result is refused. An operator who also runs the worker: residual risk 7 |
| 23 | Control plane, compromised | Sign anything | Total. Residual risk 8 |
| 24 | Plan author | Change the application's stored state before a check reads it | Checks run before any step of a plan. A plan in another run at the same time: residual risk 12 |
| 25 | Application | Answer "accepted" to a request that did nothing; show a default value when its own data request failed | Each write is witnessed by a `see`; any error answer makes the check unverified |
| 26 | Application | Send a request of its own while a step sends none | Only the named method and path count; anything else that is not a plain read and not listed as background makes the check unverified |

## Residual risks, stated plainly

1. **Timing.** A failure needs the same contradicting value on every
   reading across the approved settling time. An application that takes
   longer than its owner said it may would still be read as contradicting.
   That is a statement about the approved time as much as about the
   application, and the report gives the time with the failure.
2. **Displayed is not true.** A black-box check verifies what the
   application displays in the bound element. The stored value may differ.
   Reports say "displayed", not "is". An application that answers its own
   data request with success and an error inside, and shows a default
   value throughout, is reported as displaying that value.
3. **An approval ages.** See "Approval and deployment".
4. **A fresh account is the application's word** where a fixture is used.
   The run-bound key makes a new one each run if the interface honours it.
   If it does not, a used account could give a false verdict in either
   direction; the mandatory first `see` of the starting state is what
   catches it, and only as far as that state shows the difference.
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
    work for the owner, and is what the trust rests on. Each check also
    takes its whole approved settling time, even when it verifies, so many
    checks with long times can outlast a run's time limit and end
    unverified.
11. **Unseen effects.** A change the application makes through a plain read
    or a socket is not counted as a write.
12. **Shared stored state.** Checks are separate in the browser, not in the
    application's data. Another run, or another person, using the same
    deployment at the same time can change what a check reads. Fixtures
    keyed by run reduce this to what is truly shared.
13. **Usable only where the application is quiet or its background is
    listed.** An application that sends requests of its own needs them
    listed in `background`, by the approver, or every check is unverified.

## What changes, and where

| Where | Change |
|---|---|
| Engine, `remote/authority` | A second statement type, own domain line and version, own list. The existing statement and list are untouched |
| Engine, new | The check runner: setup, steps, readings and outcomes as above. It shares the browser tools and shares no state with a plan's scenarios |
| Engine, result | A new format version: per binding, its hash, outcome and fixed reason; the set hashes; the envelope. The current version is still what an untrusted run writes |
| Dashboard database | Bindings and approvals per project and snapshot revision; per-run keys and issued set hashes; verified-envelope columns that only the verifying component can set |
| Dashboard screens | Propose, review and approve bindings; show what a verified requirement rested on, by hash; show the criteria with bound sentences marked |
| Control plane | Issues binding statements and records run keys. Until it exists, a local stand-in. By convention its key ids begin with a reserved prefix; the engine believes a key with that prefix only in a run started with the switch that allows a target on the same machine. The server refuses trust for a run whose stored environment is such a target unless a development setting is on, which no migration creates. The server judges this from what it stored about the run, never from what the result says about its own target |

## Stages

Each is a small pull request with independent review. None changes what a
run reports until the last.

1. This note and its threat model, reviewed independently. No code.
2. Dashboard: refuse, for a remote run, a result that leaves
   `verdictsTrusted` out, whatever producer it names (the gap above), with
   a database test.
3. Engine: the exact field sequence of the set hash, written out with test
   vectors; the statement type, parsing and verification, with refusal
   tests. Not used by a run.
4. Engine: the check runner and its outcomes, written to the working record
   only, with the negative suite in the same pull requests, not after.
   `verdictsTrusted` stays false at both places, and a test holds it there.
5. Dashboard and database: store, propose and approve bindings. Local
   signing stand-in, restricted as above.
6. Result format version; the ingestion function accepts it and still
   refuses trust; dashboard rendering, untrusted.
7. The result envelope: a worker credential separate from the run's token;
   registration of the run key with it; worker signing; server
   verification by a named component.
8. Independent security review of the whole, including the exact change
   that activation would make.
9. Activation, needing the owner's explicit approval: the engine constant;
   the migration that replaces the constraint as described under "The
   locks"; and a switch per project. First for the synthetic shop on a
   development database.

A real control plane is not in these stages. Activation beyond a
development database needs it, and every hosted-execution gate.

## The negative suite

Every one must end refused or unverified, and none may end verified or
failed.

- **Run level:** an empty set; a plan that covers none, some or other
  requirements; a plan's own comparison that matches.
- **Statement:** each kind of approval presented as the other and placed in
  the other's list; another run, project, origin, revision or scope hash;
  expired; future-dated; valid for too long; a set with one
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
  readings without settling on the expected one.
- **Journey:** a step that cannot be done; a write where none is expected
  and the reverse; a second write; a `see` that does not match (must be
  unverified, never failed); a fixture call that fails; the time limit.
- **Database:** a trusted result in the old format; a trusted result with
  a valid token and no envelope, a wrong key, a changed byte, a changed
  picture, or other set hashes; a result that leaves trust out; a second
  result for the run.

- **A value that was already there:** an observation whose value was the
  expected one before the write.
- **Witnessing and errors:** an `act` answered 200 with a body that says it
  failed; a page whose own data request fails and shows a default; a
  request of the application's own during a step that sends none; a write
  with no before-and-after witness; a value that arrives and leaves again;
  a value that differs on one reading of several; a page that never comes
  to rest; a starting state that is not the expected one.
- **Fixtures:** a body without the key placeholder; an application that
  ignores the key, run twice; an answer whose named field is missing, not a
  plain value, or inherited; a value from the answer visible in a picture.
- **Shared state:** a plan's scenario that changes stored state in the same
  run.
- **Envelope:** an untrusted result submitted first with a valid token; the
  same result written out again with other spacing; a claim of trust on a
  row without the verified-envelope columns.
- **Re-approval:** the same lines under a changed heading; lines changed by
  one character.

A set presented in another sequence is the same set: the hash sorts by id.

And the positive cases: a check that verifies; a check whose value arrives
late but within the approved time and stays (verified); a check that fails
with every precondition satisfied and the same contradicting value on every
reading across the approved time; a `fill` then an `act` on one path; a
page with a request to another host, and one with a tolerated answer.

## What the reviews found, and what changed

First review:

| Finding | Change |
|---|---|
| A plan could leave failing requirements out and the run would read as passed | The denominator is the signed set; verdict rules rewritten |
| "The account is new" was called an engine fact, but it is the application's word, with keys a replay reuses | Fixtures are named as the application's word, written in the binding, keyed by run |
| Seeing a condition did not show that the journey produced it | The engine performs the whole approved journey; the plan performs none of it |
| A bound reading was weaker than today's untrusted reading | Readings only on a page just opened by the engine, nothing done in it |
| "Two locks" overstated the database constraint | Stated accurately; the envelope comes before activation; today's gap named |
| Under-specified statement, positions, numbers, addresses, "displayed", timing, identity; approval ageing; trust table; suite gaps | Each specified above |

Second review:

| Finding | Change |
|---|---|
| A trusted Failed could come from a request that was answered but did nothing, a default value after a failed data request, a reused account, or a request of the application's own counted as the step's | Writes are named and witnessed; any error answer anywhere makes the check unverified; fixtures must take the key and begin with a `see`; readings on a settled page |
| "The constraint is not what gets relaxed" was wrong, and "stored as untrusted" would have shown a forged result as trusted | The constraint is replaced at activation by one tied to a verified envelope; a failed claim of trust is refused, never stored |
| A reload between filling a form and sending it; real applications send requests of their own; a `see` could expect only numbers in the quote; fixture values in pictures; the run key travelling with the token; checks sharing stored state with a plan; no rule for re-approval | Each specified above |

Third review (sound; corrections made):

| Finding | Change |
|---|---|
| The starting-state `see` could not come first where it needs signing in | It is the first `see`; acts it witnesses may come before it |
| "No failed request" was tripped by the engine's own blocking of other hosts, and by ordinary missing files | Limited to the target; engine-blocked and navigation-cancelled requests not counted; a signed list of tolerated answers |
| "Witnessed" claimed more than the engine can know | A witness is a reading seen before and after the write with different values |
| The worker has no credential of its own to register a key with | Said plainly; made part of the envelope's stage |
| Stale lines about where the envelope is verified and who makes the key | Corrected |

## Open questions

The next version of the binding format (an explicit comparison and a
separate drawing time) is designed in
[BINDING-FORMAT-V2.md](BINDING-FORMAT-V2.md). It is a design only. What a
page may send when it is left is not designed there: it was investigated,
the result is recorded in that note, and the setting is deferred.

The owner has answered the questions of the earlier drafts; the answers are
in the list of decisions above. Still to be settled, with the stage that
implements each:

1. The maximum age of a durable approval.
2. The upper bound on the settling time and on the number of readings, and
   what the approval screen suggests as a starting value.
3. Which server component verifies envelopes, and the form of a worker's
   own credential.
