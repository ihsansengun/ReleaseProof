# Design: binding format version 2

Status: **design only. Nothing here is implemented.** It is to be reviewed
independently for security before any of it is built. Trusted verdicts stay
disabled, and the check runner stays used by no run.

This note extends [TRUSTED-BINDING.md](TRUSTED-BINDING.md). It changes what a
binding holds; it does not change who is trusted, how a set is signed, or
the request format.

## Why a second version

Three things were learned from building and reviewing the runner
(`docs/check-runner.md`):

1. **What a sentence means cannot be read off its words.** Version 1 has no
   field for the comparison: every check is an equality, and a list of words
   refuses quotes that seem to say something else. Three review rounds showed
   that each widening of the list closes the cases named, leaves another
   class open, and refuses more ordinary criteria.
2. **How long a page takes to draw its value is not how long the application
   takes to show a write.** Version 1 has one time, `settling`, and the runner
   borrows it for both.
3. **A page may have something to do as it is left**, which the browser shows
   to nobody. The runner keeps it from happening and then gives no verdict,
   so an application with a statistics listener cannot be checked at all.

## Decisions made by the owner (23 November 2026)

These are fixed; the design below implements them.

- An **explicit, signed comparison operator**, stored with the expected
  value, its unit and the exact criteria revision.
- The **complete human-readable interpretation** is shown to the approver
  before signing.
- The operator and value **must be consistent with the approved requirement**.
  An AI may not invent or silently change their meaning.
- **Exact equality first.** Bounds and ranges only after dedicated validation
  and negative tests.
- **Unsupported, contradictory or ambiguous** interpretations stay
  Unverified, never automatically Failed or Passed.
- The **wording checks stay as an additional conservative safeguard**, not as
  the authority for what a requirement means.
- The approval experience **asks the customer to confirm an ambiguous
  interpretation before execution**, and does not guess.
- A **separately approved page-rendering time**, distinct from the settling
  time after a write. Running out of time alone never makes a failure; with
  no approved time and no reliably observable state, the outcome is
  Unverified.
- Any way to let leave-time script be ignored must be **explicitly approved,
  narrowly scoped, and fail closed** whenever ignoring activity could
  invalidate the check. It must not be a general way to ignore application
  activity.
- **Backward compatibility** is preserved.

## What changes in a binding

```
Binding (version 2): every field of version 1, and
  formatVersion      2
  comparison         what is asserted of the observation     (see Comparison)
  confirmations      what the approver was asked and confirmed (see Confirmations)
  drawing            within: how long a page may take to show a value after
                     it has loaded, in whole seconds, 1 to 60
  leaving            what a page may send when it is left     (see Leaving)
```

Nothing is optional and nothing has a default. A version 2 binding without
one of these fields is malformed.

### Comparison

```
Comparison
  operator           "equals"
```

- The operator is one of a closed list of names. **Only `equals` is in the
  list in this version.** The names `at-least`, `at-most` and `between` are
  reserved: a binding that carries one is well-formed, is signed like any
  other, and is **not carried out**. Its outcome is unverified, with the
  reason `comparison-unsupported`. A name that is neither is malformed. This
  is so that an approver's intent can be recorded before the engine can check
  it, without any engine ever treating it as an equality.
- The operator stands beside what it compares, all in one signed binding:
  `expected` (the value, by position in the quote), the observation's `unit`
  and `valueKind`, and `snapshotSha256` (the revision of the text).
- `equals` means what the runner does today: the number read, by the strict
  grammar of its unit, is the expected number in that unit's one spelling.
  Nothing else: no rounding, no tolerance, no conversion between units.
- **A reserved operator is not implemented by this design.** Each needs its
  own design note, with its own rules for what a contradiction is (a page
  showing 150 against "at most 100" for the whole approved time) and its own
  negative suite, and its own review.

### The interpretation

The approver must see, before signing, one sentence that says everything
the engine will assert. That sentence is **not stored and not written by
anyone**. It is rendered from the binding's fields by a fixed template, in
the control plane for the approver and again in the engine for the record.
For `equals`:

> After these steps, the page at `/account` must show **exactly 100**, as a
> plain number, in the element with test id `balance`. This is read from the
> approved text: "After one purchase the balance is 100." (criteria revision
> `3f2a…`). Anything else shown there for the whole approved time is a
> failure of this requirement.

- Because the sentence is a function of signed fields, signing the fields
  signs the sentence. No free text is added to a binding, and nothing can be
  shown to the approver that the engine does not also hold.
- The template has a version, fixed per binding format version. The exact
  templates are written out, with test vectors, in the stage that implements
  them, as the set hash was.
- The sentence states the **sign** and the **unit** in words ("minus 5", "5
  in whole currency units, written with two decimals"), so that what is
  compared is what was read.
- The steps are rendered the same way, each as one line, with literals that
  are not from the criteria text marked as such (as version 1 requires).

### Consistency with the requirement, and what an AI may do

The owner's rule is that the operator and the value must be consistent with
the approved requirement and that an AI may not invent or change them. What
enforces each part:

| Part | Enforced by |
| --- | --- |
| The value is the number written in the approved text | The engine: the value is taken by position from the quote, and the engine reads the number there again (version 1, unchanged) |
| The text is the approved revision | The engine: `snapshotSha256` against the text, and the criteria approval of that snapshot |
| The operator is what the sentence means | **The approver**, who is shown the interpretation and signs it. No program can decide this. The wording safeguard (below) catches some contradictions and never substitutes for the approver |
| Nobody changes it afterwards | The signature: the operator, value, unit and revision are in the binding's hash. Any change is another binding, with no approval |
| An AI's proposal is not an approval | The control plane: a binding may be drafted by a model, and is then a draft. Only a person with the approving role can approve it, on the screen described below. The engine never sees drafts |

A model that drafts a binding cannot make it mean something the approver did
not see, because what the approver sees is rendered from the same fields the
engine acts on. That is the whole of the protection, and it is why the
interpretation is rendered and not written.

### Confirmations

Some things about a quote are not contradictions and are not certain either:
the sentence has "by" or "if" in it; the heading above says "Limits"; the
quote is one line of a list whose introducing line is further up; the line
before does not end with a full stop. Version 1 refuses all of them. That is
safe and leaves few real criteria bindable.

Version 2 separates three cases:

- **Unsupported.** The operator is reserved, or the unit cannot spell the
  value. Unverified (`comparison-unsupported`, or refused as today).
- **Contradictory.** The wording safeguard finds a bound or a negation in
  the quote itself and the operator is `equals`. Refused, as today. No
  confirmation overrides it in this version: the approver's remedy is to
  change the criteria text, or to wait for the operator that says what the
  text says.
- **Ambiguous.** Every other hit of the safeguard: a change, rate or
  condition word; anything found in a heading, an introducing line or a table
  header above the quote; a quote that may begin or end in the middle of a
  sentence. Each is a **question the approver is asked**, in fixed words,
  with the text that raised it shown.

```
Confirmations      a list, possibly empty, of
  code               one of a closed list (below)
```

| Code | The approver confirmed |
| --- | --- |
| `not-a-change` | The text states the value that is shown, not an amount it changes by, a rate or a share |
| `not-conditional` | The value holds whenever the approved steps have been carried out; the text states no other condition |
| `context-is-not-a-bound` | What stands above the quote (shown) does not make this value a limit, a minimum or a maximum |
| `whole-sentence` | The quote is the whole statement; the lines around it (shown) do not change what it says |

Rules:

- The engine works out the safeguard's hits itself, from the criteria text
  and the binding, exactly as the runner does today. **A hit with no matching
  confirmation refuses the binding.** So the control plane cannot skip a
  question, and the engine never guesses.
- A confirmation with no matching hit also refuses the binding: what was
  confirmed must be what the engine would have asked. (Otherwise a binding
  could carry every code and the list would mean nothing.)
- Confirmations are part of the binding, so they are hashed and signed, and
  a record can say which questions an outcome rested on.
- A confirmation changes **only** whether the binding is carried out. It
  never changes what is compared, and it never turns an outcome into
  another.
- The codes are a closed list. A new kind of question is a new format
  version.

This is the part of the design most in need of review: it moves a class of
refusals to the approver's judgement. The alternative is the present
behaviour, which is to refuse.

### Drawing

`drawing.within` is the approver's statement of how long a page of this
application may take, after it has loaded, to show the value it is going to
show. It is not `settling.within`, which is how long the application may
take to show a write.

How the engine uses it, for every reading (a `see`, a final reading, the
held reading):

1. The page is opened and brought to rest as today.
2. The value is read, and read again, until **two readings a fixed moment
   apart agree**, or the drawing time has passed since the page was opened.
3. At the end of the drawing time the value is read once more. **The reading
   is the value then, and is clean only if it is the value that had been
   agreed.**

- If the drawing time passes and no two readings ever agreed, or the element
  is missing or not a number at its end, the reading is **not clean**
  (`not-drawn-in-time`). A reading that is not clean never counts towards
  `verified` or `failed`. **So running out of the drawing time can only ever
  end a check as unverified.**
- A `failed` still needs everything it needs today, on readings that are all
  clean: the same contradicting value on every final reading and at both ends
  of the held reading, with every precondition seen and nothing gone wrong.
- A page that shows a placeholder and then its value within the drawing time
  is read as its value. A page that takes longer than the approved time is
  unverified, not failed.
- The engine's own "moment apart" stays a constant of the engine. It decides
  only when a value counts as agreed, never an outcome by itself.
- The held reading is then held for `settling.within` after the last write
  (or `drawing.within` in a check with no write), not for the settling time
  counted from the page's opening as today.
- **There is no default and no fallback.** A version 1 binding has no
  drawing time; see "Backward compatibility" for what that means for it.

Cost: every reading takes at least the drawing time. With a drawing time of
two seconds, a check with three conditions and three final readings takes
about fourteen seconds longer than today.

### Leaving

Today: if any frame of a page the engine closes has a listener for
`pagehide`, `unload`, `visibilitychange` or `freeze`, the check ends
`leave-script-suppressed`. That stays the rule for every binding that does
not say otherwise.

What may be approved, and only this:

```
Leaving
  sends              a list, possibly empty, of { method, path }: the exact
                     requests to the target that a page of this application
                     may send when it is hidden or left
```

An empty list is the present behaviour. A non-empty list does **not** tell
the engine to ignore anything. It changes how the engine leaves a page:

1. With the page still open and its script still running, the engine makes
   the page **hidden** by the browser's own means, so that the page's
   leave-time listeners run where the engine can see what they do.
2. Every request to the target sent from then on must be one of `sends`,
   by exact method and path with no query, answered below 400. Such a
   request is not counted as a write of the journey.
3. Anything else then stops the check without a verdict: a request that is
   not listed, a listed one answered with an error, a request to another
   host, a page error, a navigation, or the page not coming to rest.
4. Only then is the page's script switched off and the page closed, as
   today. What a listener would do at the very moment of destruction, after
   having been run once, is still not done.

What makes this narrow, and where it fails closed:

- The approval is of **named requests**, not of "leave-time script". A
  listener that does anything else that can be seen ends the check.
- The approval screen shows what a page of the application was **observed**
  to send when hidden, from a dry run, and asks the approver to confirm that
  those requests carry statistics and change nothing the check reads. The
  engine cannot know what a request does on the server; that judgement is
  the approver's, and the interpretation says so.
- A listener for an event the engine cannot bring about where it can watch
  (`unload` has no such form) is not covered: the check ends
  `leave-script-suppressed` as today, whatever `sends` holds.
- A frame the engine cannot ask is not covered either, as today.
- **If the browser cannot be made to hide a page in a way the page's own
  script takes for real** (a listener may ask `document.visibilityState`),
  **this setting is not offered at all.** That has to be established by
  experiment in the stage that would implement it, before anything else of
  it is built. It is possible that the honest result of that stage is that
  `sends` must stay empty.

Not approved by this design, and not to be added without the owner: a
setting that lets a check go on although leave-time listeners were kept from
running.

## The wording safeguard in version 2

- It is the runner's present check, unchanged in what it looks for.
- Its hits no longer decide what a binding means. A bound or a negation in
  the quote refuses the binding (contradictory with `equals`); every other
  hit is a question that must have been confirmed.
- It may be narrowed later (it refuses "add", "by", "if", dates, whole
  sections under ordinary headings), but only together with the approval
  screen that asks the questions, and with its own review. Until then it
  stays as wide as it is.
- The doc of the runner keeps saying what it does not see.

## The approval experience (requirements, not a design of screens)

These bind the control plane and the dashboard (stage 5 of RPAI-33). None of
it exists.

1. **The interpretation is shown in full before signing**: the rendered
   sentence, the steps, the sign and unit in words, the drawing and settling
   times in words ("a page may take up to 2 seconds to show its value").
2. **The quote is shown in its place**: with the lines around it, the
   heading it stands under, and for a row of a table its header.
3. **Every question is asked singly**, in the fixed words of its code, with
   the text that raised it marked. No question is pre-answered, and there is
   no "confirm all".
4. **A contradiction cannot be confirmed away.** The screen says why the
   binding cannot be approved and what would change that.
5. **A draft made by a model is marked as a draft**, and approving it is the
   same act as approving one written by hand. Nothing a model wrote is shown
   as explanation beside the interpretation.
6. **Nothing is approved in bulk.** One binding, one interpretation, one
   signature act. Re-approval of unchanged bindings after a criteria change
   (already decided) shows each interpretation again.
7. **What is not covered is shown**: the criteria text with the bound
   sentences marked, as version 1 requires, and beside each unbound sentence
   why it cannot be bound today, if the engine knows.

## Backward compatibility

- **The signed statement is unchanged**: the same lines in the same
  sequence, the same first line. `bindingFormatVersion` may now be `2`. A
  set is of one format version; a statement names it.
- **The set hash** for version 2 has its own first member
  (`releaseproof-bindings-v2`) and its own field sequence, which covers the
  new fields. A version 1 set hashes exactly as today. A version 2 binding
  cannot be presented under a version 1 statement or the reverse: the hashes
  differ and the engine checks the version of every binding against its
  statement.
- **Version 1 bindings stay valid as signed sets** and can still be carried
  out by the runner as it is, which nothing uses. **They can never take part
  in a trusted verdict**: they carry no operator, no drawing time and no
  confirmations, and the gates before activation require all three. The
  activation stage admits version 2 only.
- **The request format, the criteria approval and the existing result
  format are not touched.** A run with no binding statement runs as today.
- An engine that knows only version 1 refuses a version 2 statement
  (`bindingFormatVersion` is a literal there), which is the right failure.

## What an outcome may rest on (additions to the fixed list of reasons)

| Reason | When |
| --- | --- |
| `comparison-unsupported` | The operator is a reserved name |
| `interpretation-unconfirmed` | A hit of the safeguard has no confirmation, or a confirmation has no hit (reported as `binding-refused` with this sentence) |
| `not-drawn-in-time` | A reading had no agreed value by the end of the drawing time |
| `leave-activity-unapproved` | A page that was hidden did something that `leaving.sends` does not name |

All four are unverified. None can become a verdict.

## Threats considered

| # | Threat | Answer |
| --- | --- | --- |
| 1 | A model drafts `equals 100` for "at least 100" and the approver signs without reading | The interpretation says "exactly 100" beside the quote; the safeguard refuses the plain cases; the rest is the approver's signature. Stated as a residual risk |
| 2 | The control plane shows the approver one thing and signs another | Out of scope here as in version 1: the control plane holds the key. The rendered interpretation removes one way to do it by accident |
| 3 | The control plane skips a question | The engine recomputes the hits and refuses a binding with a hit and no confirmation |
| 4 | Every code is attached to every binding, so nobody is really asked | A confirmation with no hit refuses the binding; the screen has no "confirm all" |
| 5 | A reserved operator is carried out as an equality by an older or careless engine | An engine that does not know version 2 refuses the statement; one that does must return `comparison-unsupported`; a test holds it |
| 6 | The drawing time is set very short to force failures | A reading without an agreed value is not clean, so a short time gives unverified, never failed |
| 7 | The drawing time is set very long to hide a value that comes and goes | The value must still be the agreed one at its end, and the same on every reading and at both ends of the held reading |
| 8 | `leaving.sends` lists a request that changes what the check reads | The engine cannot tell. The approver is shown the observed requests and confirms. Stated as a residual risk; the witness rules still apply to the journey |
| 9 | A page behaves differently when hidden by the engine than when really left | If the page can tell, the setting is not offered. What runs only at destruction is still suppressed |
| 10 | A version 1 binding is used for a trusted verdict | Activation admits version 2 only |
| 11 | Two bindings that differ only in a new field hash alike | The version 2 field sequence covers every field; vectors and a test, as for version 1 |

## Residual risks, stated plainly

1. Whether `equals` is what the sentence means is the approver's judgement.
   The engine guarantees the value, the revision and that the approver was
   shown the interpretation's fields; not that they read it.
2. A confirmation is a person's answer to a question. A wrong answer gives a
   check that compares the wrong thing, and the engine will report its
   outcome as trustworthy.
3. What a listed leave-time request does on the server is not known to the
   engine.
4. The wording safeguard still misses wordings; it is no longer what the
   meaning rests on, and it must not be described as if it were.
5. Everything in "Residual risks" of TRUSTED-BINDING.md and in "Gates before
   activation" of `docs/check-runner.md` stands. In particular the
   legibility gate is not touched by this design.

## Stages

Each is a small pull request with independent review. None changes what a
run reports.

1. This note, reviewed independently. No code.
2. Engine: the version 2 binding shape, its set hash with vectors, the
   statement accepting either version. Used by nothing.
3. Engine: the interpretation templates with vectors; `comparison` in the
   runner (`equals` as today, reserved names unverified); confirmations
   against the safeguard's hits.
4. Engine: the drawing time in every reading, with its negative suite (a
   placeholder within and beyond the time; a value that never agrees; a time
   too short; a failure that still needs every clean reading).
5. Engine: an experiment on hiding a page so that its own script takes it
   for real. Only if it succeeds: `leaving.sends`, with its negative suite.
   If it does not: `sends` is fixed to the empty list and this note is
   corrected.
6. Dashboard and control plane: the approval experience above (with stage 5
   of RPAI-33).

## The synthetic shop demonstration

By the owner's instruction: the shop's original business requirements are
**not rewritten to fit the parser**.

- The demonstration uses a **separate, separately approved fixture of
  exact-equality statements** about the shop, written for the purpose and
  labelled as such, beside the original criteria.
- Each original criterion is listed with what happens to it: bound through
  the fixture, or **Unverified**, with the reason the engine gives.
- The report states the coverage plainly: how many of the original criteria
  the demonstration says anything about, and that a verified fixture
  statement is not a verified original requirement unless the two say the
  same thing, which is a person's judgement recorded in the report.
- Trusted verdicts stay disabled; the run reports `verdictsTrusted: false`.

## Open questions for the owner

1. **Confirmations.** Is it right that an ambiguous hit can be confirmed by
   the approver, and that a contradiction in the quote itself cannot? The
   stricter alternative is that every hit refuses, as today.
2. **The upper bound of the drawing time** (60 seconds here), and whether it
   should be per binding (as here) or per project.
3. **`leaving.sends`**: whether to pursue stage 5 at all, given that its
   honest outcome may be that nothing can be offered.
4. **Who writes the fixture** for the synthetic shop, and who approves it.
