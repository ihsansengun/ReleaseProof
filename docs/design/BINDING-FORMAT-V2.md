# Design: binding format version 2

Status: **design only. Nothing here is implemented.** It is reviewed
independently for security before any of it is built (the first review's
findings are in the last section). Trusted verdicts stay disabled, and the
check runner stays used by no run.

This note extends [TRUSTED-BINDING.md](TRUSTED-BINDING.md). It changes what a
binding holds and, with that, the first member and field sequence of the set
hash. It does not change who is trusted, the lines of the signed statement,
or the request format.

## Why a second version

Two things were learned from building and reviewing the runner
(`docs/check-runner.md`):

1. **What a sentence means cannot be read off its words.** Version 1 has no
   field for the comparison: every check is an equality, and a list of words
   refuses quotes that seem to say something else. Three review rounds showed
   that each widening of the list closes the cases named, leaves another
   class open, and refuses more ordinary criteria.
2. **How long a page takes to draw its value is not how long the application
   takes to show a write.** Version 1 has one time, `settling`, and the runner
   borrows it for both.

A third matter, what a page does as it is left, was to be part of this
version and is **not**: see "Leaving".

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

And, on the first draft of this note (23 November 2026):

- **Clarification, not override.** The customer may clarify wording that is
  genuinely harmless. An actual contradiction in meaning cannot be
  overridden: a requirement that states a bound or a negation is never
  treated as an equality because someone confirmed a warning. If the
  intended meaning changes, that takes a **new approved revision of the
  criteria**. The engine validates every permitted clarification
  independently; a general approval checkbox is not enough.
- **The page-rendering time** may be up to 60 seconds, set and explicitly
  approved per binding, with a separate limit for the run as a whole. Running
  out of it is Unverified, unless a separately supported and approved
  requirement about a deadline can be verified (none is supported here).
- **Leave-time setting: deferred.** The investigation stays documented. No
  unreliable mechanism is introduced; where reliable verification is not
  possible the outcome is Unverified.
- **The synthetic shop** may have a separate exact-equality demonstration
  fixture. Its complete requirement and expected outcome are shown to the
  owner for approval before it is used as an authoritative example. The
  original business requirements are not modified to suit the engine.
- **The pre-run Review & Confirm Requirements workflow is preserved.** The
  AI identifies material uncertainty before execution and groups the
  clarification questions for the customer.
- The priority is one complete approved requirement demonstrated correctly,
  not more kinds of verification.

## What changes in a binding

```
Binding (version 2): every field of version 1, and
  formatVersion          2
  comparison             what is asserted of the observation   (see Comparison)
  affirmed               the approver's own statement of the comparison (see Affirmation)
  confirmations          what the approver was asked and confirmed (see Confirmations)
  safeguardVersion       which list of wordings the questions came from
  drawing                within: how long a page may take to show a value
                         after it has loaded, in whole seconds, 1 to 60
  templateVersion        which wording of the interpretation was rendered
  interpretationSha256   the hash of the exact text shown to the approver
```

Nothing is optional and nothing has a default. A version 2 binding without
one of these fields is malformed.

### Comparison

```
Comparison
  operator           "equals"
```

- **In version 2 the operator is `equals`. Any other name is malformed.**
  There are no reserved names. A further operator is a new format version,
  with its own interpretation template, its own rules for what a
  contradiction is, its own negative suite and its own review. Nothing that
  is not `equals` can be signed before its meaning exists.
- An approver's wish for a bound ("this should be at least 100") is recorded
  by the control plane outside any signed binding. It reaches no engine.
- The operator stands beside what it compares, all in one signed binding:
  `expected` (the value, by position in the quote), the observation's `unit`
  and `valueKind`, and `snapshotSha256` (the revision of the text).
- `equals` means what the runner does today: the number read, by the strict
  grammar of its unit, is the expected number in that unit's one spelling.
  No rounding, no tolerance, no conversion between units. For an amount the
  currency sign or code shown is **not** compared. Every `see` is the same
  kind of equality; a `see` that does not match is a condition not met,
  never a failure.

### The interpretation

The approver must see, before signing, everything the engine will do and
assert. That text is **not written by anyone**. It is rendered from the
binding's fields by a fixed template. For `equals` it reads, in outline:

> **Requirement.** "After one purchase the balance is 100." (criteria
> revision `3f2a…`, shown in full on request)
>
> **What is checked.** After the steps below, the page at `/account` must
> show **exactly 100**, a plain number, in the element with test id
> `balance`. The value is taken from the requirement here: "…the balance is
> **[100]**." Any other number shown there on every reading is a failure of
> this requirement. The currency shown, if any, is not checked.
>
> **Steps.** (one line each, with every value; a value that is not from the
> requirement is marked "not from the criteria text")
>
> **Setup.** (the fixture's method, path and body in full, or "a new browser
> with nothing stored")
>
> **What is not counted or is tolerated.** (every `background` request and
> every `tolerated` answer, or "nothing")
>
> **How the browser is set.** (language, time zone)
>
> **Times.** "A page may take up to 2 seconds after loading to show its
> value. A number still shown then is taken as the page's value: a page that
> shows a number first and corrects it later than that can be reported as
> failed. The application may take up to 5 seconds to show a write. The
> value is read 3 times."
>
> **What you confirmed.** (each confirmation, with the text that raised it)

Rules:

- **The rendering covers every field of the version 2 hash sequence.** A
  test takes each field in turn, changes it, and requires the rendered text
  to change. Nothing is cut short or abbreviated, the revision hash aside,
  which is available in full. This is what stops a model that drafts a
  binding from changing how a check is judged through a field nobody looks
  at (a write listed as `background`, an error listed as `tolerated`).
  The one field it cannot cover is its own hash.
- **What is rendered is one plain text**: UTF-8, line feeds, no markup. The
  screen displays that text. It holds, besides the fields: the fixed words
  of the affirmation; the fixed words of every question that was asked, each
  with the text that raised it; and what the approver is shown around the
  quote (the block it stands in, the heading above, the header and earlier
  rows of its table, the adjoining lines of its sentence). The engine has
  the criteria text and renders all of it.
- **The hash of that text is in the binding** (`interpretationSha256`), so
  it is signed. The engine renders the text again and **refuses the binding
  if the hash differs**. So the control plane and the engine cannot render
  differently without it being seen. The control plane's renderer must pass
  the engine's test vectors.
- **`templateVersion` is signed too.** The wording of the template will be
  corrected over time. A binding made under another template version than
  the engine's is refused with a fixed reason of its own, so that "made
  under an older wording, renew it" can be told from "rendered wrongly".
  **A change of the template ends every existing approval**, as a change of
  the criteria text does; that is stated to whoever changes it. The
  template's exact text, with vectors, is written out in the stage that
  implements it.
- **Numbers are rendered from the signed decimal string**, never through any
  formatting that depends on a language setting. The **sign** and the
  **unit** are stated in words ("minus 5"; "5 in whole currency units,
  written with two decimals").
- **The place the value was taken from is marked in the quote**, for the
  final value and for every `see` value taken from the quote, so that "3" in
  "After 3 purchases the balance is 100" is not approved as the balance.
- **The quote and what stands around it are shown as separate blocks**,
  never run into the sentence, so that text inside a quote cannot pass for
  the end of it. Any character outside printable ASCII in a locator, a typed
  value or a line of context is also shown in escaped form. **A line of
  context that holds characters that are not seen refuses the binding**, as
  the quote does.

### Affirmation

The wording safeguard asks questions only where its list finds something,
and the list misses wordings. So that the approver is asked about the
comparison **every time**, and not only when a word happens to be listed:

```
affirmed           "equals-not-bound-not-change"
```

One fixed value, which the control plane may store only as the result of
the approver's own act on a question that is asked on every binding, never
filled in from a draft: *"The requirement says the value is exactly N. It
does not say at least N, at most N, about N, or that something changes by
N, or that it is N only under a condition that the steps do not make true.
If this is wrong, a page that shows another permitted value will be
reported as failed."* A binding without it is malformed.

**The engine cannot tell whether anyone was asked.** The field records that
the control plane says so, as the signature records that the control plane
says someone approved. What gives it content is that its words are part of
the rendered text whose hash is signed. It lets nothing through: every rule
below applies whether or not it is there.

### Confirmations

Some things about a quote are neither contradictions nor certain. Version 1
refuses all of them, which is safe and leaves few real criteria bindable.
Version 2 separates three cases. The engine works all of them out itself,
from the criteria text and the binding.

**Unsupported.** The unit cannot spell the value. Refused, as today.

**Contradictory: refused, and nothing overrides it.** No confirmation, no
affirmation and no setting makes a requirement that states a bound, a
negation, a change or a possibility into an equality. If what was meant is
an equality, the remedy is a **new approved revision of the criteria text**
that says so; the binding is then for that revision. Otherwise it waits for
a format version whose operator says what the text says.

**Ambiguous: a question the approver is asked**, singly, in fixed words,
with the text that raised it shown and the consequence of a wrong answer
stated.

Which is which, by the kind of wording and where it stands:

| What the safeguard finds | In the quote | In a line that introduces the quote's list, or in any row above it in its table | In the heading above |
| --- | --- | --- | --- |
| A bound, a comparison, a range, an approximation, a symbol | **refused** | **refused** | **refused** |
| A negation, or a sign written as a word | **refused** | **refused** | **refused** |
| A verb of change or a share ("increases", "adds", "doubles", "reduced", a percentage) | **refused** | **refused** | question `heading-not-about-value` |
| A hedge ("may", "might", "could", "usually", "typically", "sometimes", "optionally", "default") | **refused** | **refused** | question `heading-not-about-value` |
| "by", "plus", "another", "extra", "additional" directly before a number taken from the quote (the expected value, or a `see` value; only space or a currency sign between), or "plus" directly after it | **refused** | n/a | n/a |
| Otherwise a bare "by", "per", "each", "every", "plus", "times", "another", "extra", "additional" | question `not-a-rate` | question `not-a-rate` | question `not-a-rate` |
| "otherwise" (its condition is in another sentence) | **refused** | **refused** | question `heading-not-about-value` |
| "if" | question `condition-established` | question `condition-established` | question `condition-established` |

- **A bound or a negation in the heading refuses**, although the engine
  cannot tell "Maximum balances" from "Limits and balances". Under the
  first, a line "Gold: 100" states a bound, and the owner's decision is that
  no confirmation makes a bound into an equality. Until the owner says
  otherwise this cell is the strict one: nothing under such a heading can be
  bound, and the remedy is a new revision of the criteria with another
  heading. (Open question 1 names the cells that could be loosened.) A verb
  of change or a hedge in a heading stays a question: the owner's rule names
  bounds and negations, and a heading such as "Default settings" is seldom
  about the value. Those two cells are also for the owner to confirm.
- **A refusal anywhere wins.** Otherwise every question at every place is
  asked: a word in the quote and another in the heading are two questions.
- The rows name kinds, with examples. **The stage that implements this
  writes out which row every alternative of the safeguard's lists belongs
  to** ("half", "twice", "gains", "loses", "grows", "drops" and "raises"
  among the verbs of change), **with a test that none is left out.**
- **A hit has one place.** It is the leftmost, longest match of its kind
  that overlaps no other; its place is the span of the snapshot's text that
  the match was rewritten from. The safeguard matches on a copy of the text
  in one case, without marks of emphasis and with space collapsed; the
  mapping back is part of the definition and is tested, as it is for the
  reader of quoted numbers.

And for where the quote begins and ends:

- If the quote may begin or end in the middle of a sentence, the engine
  applies the "in the quote" column to **the adjoining lines up to where
  the sentence ends**. Going outwards from the quote, that is up to and
  including the first line that ends a sentence with punctuation, and up to
  but not including an empty line, a heading, a line that begins an item, or
  the start or end of the text (the runner's own tests). Anything there that
  the table refuses, refuses; so do unseen characters and letters outside
  the English alphabet, as in the quote; so do more adjoining lines than the
  quote itself may hold, since the approver must be shown all of them.
  Otherwise the approver is asked `whole-statement`, with those lines
  shown.

The questions, in the fixed words the approver sees:

| Code | Question |
| --- | --- |
| `not-a-rate` | "The marked word does not make N an amount per something or added to something: N is the value that is shown. If this is wrong, a correct page can be reported as failed." |
| `condition-established` | "The steps of this check (shown) make the marked condition true. If they do not, a correct page can be reported as failed." |
| `heading-not-about-value` | "The marked heading does not make N a change or something that holds only sometimes. If it does, a correct page can be reported as failed." |
| `whole-statement` | "The marked lines are the whole statement about N; the lines shown around them do not change what it says. If they do, a correct page can be reported as failed." |

```
Confirmations      a list, sorted by start, end, code; no duplicates
  code               one of the four above
  start, end         where the text that raised the question stands, as
                     offsets into the snapshot's text
```

Rules:

- **The signed list must equal the engine's own list of questions exactly**:
  the same codes at the same places, no more and no fewer. A question with
  no confirmation refuses the binding, so the control plane cannot skip one.
  A confirmation with no question refuses it too, so a binding cannot carry
  every code as a blanket. Confirming one "by" does not confirm another.
- **`safeguardVersion` is signed.** The list of wordings will change. A
  binding made under another version of the list than the engine's is
  refused with a fixed reason: its approver was not asked what this engine
  would ask. Changing the list is therefore a deliberate, versioned act
  that makes existing approvals need renewal.
- The runner's safeguard reports fewer kinds today than this table has, and
  one undivided answer for what stands above a quote. Version 2 needs its hits singly, each with its kind and its
  place; **which words it knows does not change** in this design.
- A confirmation changes **only** whether the binding is carried out. It
  never changes what is compared, and never turns an outcome into another.
- The codes and the table are part of the format version.

**This is clarification, not a checkbox.** Each permitted clarification is
one named question about one marked place in the text, and the engine
checks, independently and from the text, that exactly those questions arose
at exactly those places. The affirmation above is asked as well, on every
binding; it is not what lets a binding with a warning through, and it
overrides nothing.

A wrong answer to a question gives a check that compares the wrong thing.
That is a person's judgement recorded and signed, which is where the owner's
decisions put it; it is listed under the residual risks.

### Drawing

`drawing.within` is the approver's statement of how long a page of this
application may take, **after its load event**, to show the value it is
going to show. It is not `settling.within`, which is how long the
application may take to show a write.

For every reading (a `see`, a final reading, the held reading):

1. The page is opened and brought to rest as today. **If it is not at rest
   by the end of the drawing time, the reading is not clean.**
2. From then to the end of the drawing time the value is sampled, one
   sample after another. **A sample is a full reading under all the rules**
   (one element, displayed, legible, a number by the strict grammar), which
   takes a moment itself. A sample that finds the element missing, not
   displayed or not a number is recorded as such and the sampling goes on;
   a sample that stops for any other reason ends the check with that
   reason.
3. **The last sample begins no earlier than the end of the drawing time,
   counted from the load event. The reading is the number of that sample.
   It is clean only if that sample, and every sample begun within the
   engine's fixed moment before it, of which there is at least one, are that
   same number.** Earlier samples that differ are allowed and recorded.
   Something that is not a number never counts as the same.

What follows, and what does not:

- A reading that is not clean (`not-drawn-in-time`) never counts towards
  `verified` or `failed`. A `see` after a write treats it as it treats a
  value that has not arrived: tried again until the settling time has
  passed. A try that has begun is finished, and at least one is made, so
  with a settling time shorter than the drawing time there is exactly one.
- A page that shows a placeholder and then its value within the drawing
  time is read as its value.
- **A number that is still shown at the end of the drawing time is taken as
  the page's value, whatever the page does later.** A placeholder that is a
  number and stays for longer than the approved time is read as the value on
  every page, and such a check can end `failed`; if the placeholder happens
  to be the expected number, `verified`. The drawing time does not remove
  this limit of the runner; it gives it its own approved number, and the
  approval screen says so in those words. So the true statement is:
  **running out of the drawing time without a stable number can only end a
  check as unverified; a stable number at its end is evidence, as the
  approver said it would be.**
- **The held reading stays.** It is one page, kept open from its opening
  until the later of (its load, plus the drawing time, plus the settling
  time) and (the last write, plus the settling time). It is sampled
  throughout, and its end is read as a reading is: stable over the engine's
  moment. A sample in the hold that is another number, or not a number,
  gives no verdict. A verdict needs the same number at its first clean reading and at
  its end. This is longer than today's hold, never shorter.
- A `failed` needs everything it needs today, on readings that are all
  clean.
- The engine's interval and moment are constants of the engine. They decide
  only when a value counts as stable, never an outcome by themselves.
- **There is no default and no fallback.** A version 1 binding has no
  drawing time; see "Backward compatibility".

Bounds and cost. The drawing time is 1 to 60 seconds, set and approved per
binding. Every reading takes at least that long, so a check with three
conditions and three final readings and a drawing time of two seconds takes
about fourteen seconds longer than today, plus the longer hold; with sixty
seconds, most of ten minutes. **The run has its own limit, separate from
any binding's times.** The engine's time limit for a check includes the
drawing time of every reading, and a binding whose worst case exceeds what
the run allows is refused when it is approved, not left to run out of time.
That is per binding: a set whose checks together exceed the run's limit
ends its later checks as `time-ran-out`, which is unverified.
The approval screen warns when a drafted drawing time is the minimum.

A requirement that itself states a deadline ("the balance is shown within 2
seconds") is not what the drawing time is for. That is another kind of
comparison, which version 2 does not have: such a requirement cannot be
bound, and stays Unverified.

## Leaving: not part of version 2

Today: if any frame of a page the engine closes has a listener for
`pagehide`, `unload`, `visibilitychange` or `freeze`, the engine keeps it
from running and the check ends `leave-script-suppressed`. **That stays the
rule, for version 2 as for version 1.** Version 2 has no field about it.

The first draft of this note proposed approving exact named requests that a
page may send when hidden, observed by hiding the page while it is still
open. The independent review tried it, and the result is recorded here so
that it is not tried again without cause:

- **No way was found to make a page really hidden** (a real window manager
  and a browser profile kept between runs were not tried) in the engine's
  browser
  (headless, the newer headless, and with a window): bringing another page
  to the front, activating another tab, switching focus emulation off,
  setting the page's lifecycle state to frozen, minimising or moving the
  window, idle and screen overrides. `document.visibilityState` stayed
  `visible` and no listener ran. An event made by script runs the listeners,
  but the page can tell.
- **Really leaving a page runs `pagehide` first, while the page is still
  visible, then `visibilitychange`** (measured). So hiding, even if it
  worked, would not run a `pagehide` listener, which statistics scripts
  commonly register as well; nor, it is expected though it was not measured,
  a `freeze` listener.
- What a page sends as it is really left is seen neither by the browser
  library nor by the browser's own debugging interface. **It is seen by a
  forwarding proxy that the engine owns** (measured for a page that is
  closed, against a plain `http` target only). That is another mechanism (watch
  the real leaving, not an imitation of it). It would have to end the
  encrypted connection for an `https` target, and does not know which page
  sent what.

By the owner's decision the setting is **deferred**: it does not hold up
the main work, and no unreliable mechanism is introduced.

Consequences:

- Applications with a leave-time listener stay uncheckable under version 2:
  they end Unverified.
  That is a cost, stated here and in `docs/check-runner.md`.
- If the owner wants this pursued, it is **a separate design for a later
  format version**, starting from the proxy, and it needs at least: requests
  limited to POST, to a path that no step, fixture or `background` entry of
  the binding uses; few entries, each sent at most once per leaving; the
  observed list produced and recorded by the engine and never by a model; a
  plain statement that what a listener writes to the browser's storage is
  not seen; and its own security review. Whether a listed request changes
  what a check reads would still rest on the approver's word, which may not
  be narrow enough for the owner's rule. That is the question to answer
  first.
- **Not approved, and not to be added without the owner:** any setting that
  lets a check go on although leave-time listeners were kept from running.

## The wording safeguard in version 2

- It is the runner's present check. Which words it knows is unchanged here;
  it reports its hits singly, with kind and place.
- Its hits no longer decide what a binding means. Per the table above a hit
  refuses, or is a question that must have been confirmed at that place.
- It has a version, which is signed.
- It may be narrowed later (it refuses "add" and dates, and refuses
  or raises a question for every ordinary heading with a listed word in it), but only as
  a new safeguard version, with its own review. Until then it stays as wide
  as it is.
- The runner's doc keeps saying what it does not see.

## The approval experience (requirements, not a design of screens)

These bind the control plane and the dashboard (stage 5 of RPAI-33). None of
it exists.

**It is part of the pre-run Review & Confirm Requirements workflow**, which
this design preserves: before anything is executed, the AI identifies what
is materially uncertain about the requirements and puts the clarification
questions to the customer in groups. For bindings that means:

- The AI may **raise** uncertainty and may **group** questions (by
  requirement, by kind) so that they can be reviewed together. Grouping is
  how they are presented; each question is still answered by itself.
- The engine's own questions (the table above) are always among them. The
  AI can add questions and can hold a binding back; it can never remove,
  merge or pre-answer one of the engine's.
- **A question the AI raises is marked as the AI's.** It is shown apart
  from the engine's questions and never beside the interpretation; it is not
  part of the rendered text or of the signed binding; and its answer is
  never a confirmation. It can lead only to a binding being held back or to
  a new revision of the criteria, never to an approval.
- Nothing is executed for a binding until its questions are answered. An
  unanswered question leaves the requirement Unverified.

1. **The interpretation is shown in full before signing**, as rendered: the
   requirement, what is checked, every step, the setup, what is not counted
   or tolerated, how the browser is set, the times in words, the
   confirmations. It is the text whose hash is signed, and nothing else is
   shown in its place.
2. **The quote is shown in its place**: the whole block of lines it stands
   in, the nearest heading, for a row of a table its header, and a note if
   the same line occurs elsewhere in the text. Shown as blocks, never
   inline.
3. **The affirmation is asked on every binding**, and **every question is
   asked singly**, in its fixed words, with the text that raised it marked
   and the consequence stated. Nothing is pre-answered, from a draft or
   otherwise, and there is no "confirm all".
4. **A contradiction cannot be confirmed away.** The screen says why the
   binding cannot be approved and what would change that.
5. **A draft made by a model is marked as a draft.** Approving it is the
   same act as approving one written by hand. Nothing a model wrote is shown
   as explanation beside the interpretation.
6. **Nothing is approved in bulk** but what the next item allows. One
   binding, one interpretation, one act of signing.
7. **Re-approval** after a change of the criteria text, of the safeguard
   version or of the template version shows what differs from the binding
   approved before. Bindings that are genuinely unchanged (the rendered text
   differs in nothing but the revision) may be approved again together, by
   one explicit act, with an itemised review and every check of snapshot,
   template and safeguard version made for each. Where a binding differs in
   anything else, every question is asked again for it.
8. **What is not covered is shown**: the criteria text with the bound
   sentences marked, and beside each sentence that is not bound, why not, if
   the engine knows.
9. **A record is kept, and must be**: per approval, who and when; each
   question with the hash of the exact text shown and its answer; the
   template and safeguard versions; whether the draft came from a model;
   and, for a re-approval, that it was one. A
   result carries, per outcome, the operator, the confirmations and the
   times it rested on, and a verdict that rests on confirmations is marked
   as such wherever it is shown.
10. Who may approve is as in version 1: the role that may approve criteria.
    A person may draft a binding and approve it, as two distinct recorded
    acts; an enterprise may require another person by policy. **An AI agent
    cannot approve**, whatever role it acts under.

## Backward compatibility

- **The signed statement is unchanged**: the same lines in the same
  sequence, the same first line. `bindingFormatVersion` may now be `2`. A
  set is of one format version; a statement names it.
- **The hashes.** Version 2 has its own first members
  (`releaseproof-bindings-v2` for a set, `releaseproof-binding-v2` for one
  binding) and its own field sequence, which covers every new field.
  Confirmations are hashed in their one sequence. A version 1 set hashes
  exactly as today. A version 2 binding cannot be presented under a version
  1 statement or the reverse: the hashes differ, and the engine checks the
  version of every binding against its statement.
- **Vectors**, written with the implementation: two bindings that differ
  only in one confirmation, only in the drawing time, only in the
  safeguard version, only in the template version, only in the
  interpretation hash; the same content as version 1 and as version 2; a set
  in two input sequences; and the refusals (a duplicate or unsorted
  confirmation, an unknown code, any operator but `equals`, a missing
  affirmation, each version under the other's statement).
- **Version 1 can never take part in a trusted verdict.** Enforced in three
  places, each of which holds by itself:
  - *Engine:* from the stage that carries version 2 out (stage 4), a version
    1 binding is not carried out at all: nothing is sent to the application,
    its outcome is unverified with a fixed reason, and it counts among the
    bindings of the run. A run with a version 1 binding therefore cannot be
    `passed`. Until that stage the runner carries version 1 out as today,
    for its own tests, and nothing uses it.
  - *Server:* the constraint that will one day allow `verdictsTrusted: true`
    allows it only if every stored set of the run is version 2.
  - *Control plane:* no version 1 statement is issued for a project with
    trust enabled, and a version 2 binding is never derived from a version 1
    approval: every new field is approved afresh.
- **The request format and the criteria approval are not touched.** A run
  with no binding statement runs as today.
- **The result format** gains the new reasons below only with the result
  format version that stage 6 of RPAI-33 introduces. Until then nothing
  writes them.
- An engine that knows only version 1 refuses a version 2 statement
  (`bindingFormatVersion` is a literal there), which is the right failure.

## Reasons

Two are added to the fixed list, both unverified, neither able to become a
verdict:

| Reason | When |
| --- | --- |
| `not-drawn-in-time` | A reading had no stable number at the end of the drawing time |
| `binding-version-untrusted` | The binding is of format version 1 |

A binding that is refused (a missing or surplus confirmation, another
safeguard or template version, an interpretation hash that does not match,
a contradiction) ends `binding-refused` with a fixed sentence, as refusals
do today.

The table of outcomes in `docs/check-runner.md` is brought into line in the
stage that changes the runner, not before.

## Threats considered

| # | Threat | Answer |
| --- | --- | --- |
| 1 | A model drafts `equals 100` for "at least 100" and the approver signs without reading | The safeguard refuses the plain cases; the affirmation is asked every time in words that name the alternative and the consequence; the rest is the approver's signature. Residual risk 1 |
| 2 | A model drafts a field nobody looks at (`background`, `tolerated`, a fixture body) to change how the check is judged | The rendering covers every hashed field, and a test holds that |
| 3 | The control plane renders one text and the engine another | The hash of the rendered text is signed; the engine renders again and refuses on a difference |
| 4 | The control plane shows the approver one thing and signs another on purpose | Out of scope here as in version 1: the control plane holds the key |
| 5 | The control plane skips a question, or attaches every code | The signed confirmations must equal the engine's questions exactly, by code and place |
| 6 | The list of wordings changes and old confirmations cover words nobody was asked about | `safeguardVersion` is signed; another version refuses |
| 7 | An operator other than `equals` is signed before its meaning exists, or carried out as an equality | Any other name is malformed in version 2 |
| 8 | A drawing time set short, so that a placeholder is read as the value | Not prevented: a stable number at the end of the approved time is taken as the value. Stated to the approver in words; minimum of one second; a warning on a drafted minimum. Residual risk 3 |
| 9 | A drawing time set long, so that a value that comes and goes is missed | The reading is the value at the end, stable over the engine's moment; every reading and both ends of the held reading must agree |
| 10 | A long drawing time used to run every check out of time | The check's limit includes it, the run has its own limit, and a binding that cannot finish within it is refused at approval |
| 11 | A version 1 binding is used for a trusted verdict | Three places, above |
| 12 | Two bindings that differ only in a new field hash alike | The field sequence covers every field; vectors and a test |
| 13 | Text shown to the approver passes for something else (a quote that imitates the end of the sentence; look-alike letters in a locator; unseen characters in the lines around a quote) | Blocks, not inline; escaped form beside anything outside printable ASCII; lines of context with unseen characters refuse the binding as the quote does |
| 14 | The wrong number of the sentence is taken as the value | Its place is marked in the quote |

## Residual risks, stated plainly

1. Whether `equals` is what the sentence means is the approver's judgement.
   The engine guarantees the value, the revision, and that the text whose
   hash is signed says "exactly"; not that it was read.
2. A confirmation is a person's answer to a question. A wrong answer gives a
   check that compares the wrong thing, and the engine reports its outcome
   as trustworthy. A verdict that rests on confirmations is marked as such.
3. A number that a page shows for longer than the approved drawing time,
   and then replaces, is taken as its value.
4. Criteria text may have been written by people other than the approver,
   or drafted by a model. A drafter chooses which sentence to quote and
   where to stop. The approver is shown the block and its heading; what a
   paragraph further up says is theirs to know.
5. The wording safeguard still misses wordings. It is not what the meaning
   rests on, and must not be described as if it were.
6. Applications with leave-time listeners cannot be checked.
7. Everything in "Residual risks" of TRUSTED-BINDING.md and in "Gates before
   activation" of `docs/check-runner.md` stands. In particular the
   legibility gate is not touched by this design. The second gate there
   (a separate drawing time) is met by this design only once it is built
   and reviewed, and its wording is corrected then.

## Stages

Each is a small pull request with independent review. None changes what a
run reports. The shape and its hash are fixed only after the things they
must cover are written.

1. This note, reviewed independently. No code.
2. Engine: the version 2 binding as a type and its field sequence; the
   interpretation template for `equals`, with vectors and the test that
   every field changes the text; the safeguard reporting its hits singly,
   with kind, place and a version, and the assignment of every alternative
   of its lists to a row of the table. Used by nothing.
3. Engine: the version 2 hashes with vectors, and the statement accepting
   either version. A version 2 binding parses and hashes and **is not
   carried out**. Negative suite: any operator but `equals`; a missing
   affirmation; a question without a confirmation and the reverse; wrong
   offsets; a duplicate; an unknown code; another safeguard or template
   version; an interpretation hash that does not match; and each cell of
   the table that refuses.
4. Engine: version 2 carried out, with the drawing time in every reading
   and the held reading as defined here; the runner's whole suite moved to
   version 2 bindings; version 1 no longer carried out. Negative suite for
   the drawing time: a placeholder within and beyond the time; a value that
   never settles; a value that agrees, changes and changes back; something
   that is not a number; a page not at rest by the end; the limit; a failure
   that still needs every clean reading.
5. Dashboard and control plane: the approval experience above (with stage 5
   of RPAI-33), whose renderer passes the engine's vectors.

**Format version 2 is not final until stage 4 has been reviewed.** No
version 2 approval is stored before that, so that no field is fixed before
the rule it serves exists.

## The synthetic shop demonstration

By the owner's instruction: the shop's original business requirements are
**not rewritten to fit the parser**, and what the engine cannot support
stays Unverified.

- **Before the fixture is used as an authoritative example, its complete
  requirement text and the expected outcome of each statement are shown to
  the owner for approval.**
- The demonstration uses a **fixture of exact-equality statements** about
  the shop. It is **its own criteria snapshot**, named as a demonstration
  fixture in its id and wherever it is shown, and approved separately. It is
  written from the shop's requirements, not from what the shop happens to
  show.
- **Every original criterion that is not itself bound is listed Unverified**,
  with the engine's reason. A fixture statement may be noted beside an
  original criterion as "related, in the judgement of (a named person) on (a
  date)". It never gives the original criterion another status and never
  counts towards it.
- The headline of the report reads, in these terms: "**Fixture: n of N
  statements verified. Original criteria: 0 of M verified.**" The second
  number stays nought for as long as no original criterion is bound.
- Trusted verdicts stay disabled; the run reports `verdictsTrusted: false`,
  and the demonstration says what it would take for that to change.

## The owner's answers to the open questions (23 November 2026)

The first version of this note ended with four questions. The answers:

1. **The cells of the table: conservative for the first version.** A heading
   or other context that may contradict an equality must not silently become
   an equality check, so the table stands as written, with a bound or a
   negation in a heading refusing. Refusals that prove unnecessarily broad
   are revisited separately, as a new safeguard version with its own review.
2. **Drafting and approving.** An authorised user may draft a binding and
   approve it, through two distinct acts that are each recorded. An
   enterprise may, by policy, require that the approver is another person
   than the drafter. **An AI agent cannot approve.**
3. **Re-approval.** Bindings that are genuinely unchanged may be approved
   again together, by one explicit act, with an itemised review (each
   binding listed with its interpretation) and with every check of snapshot,
   template and safeguard version made for each. "Genuinely unchanged" is as
   defined above: the rendered text differs in nothing but the revision.
   This is the one exception to "nothing is approved in bulk".
4. **How long a confirmation stands.** A confirmation holds for the exact
   criteria revision, binding and environment it was given for, until one of
   them changes materially, it is revoked, or a policy's time limit ends it.
   A scheduled run that changes nothing does not need approval again.

Still to be settled, with the stage that implements each: what "environment"
names exactly (the target's origin at least); the policy's time limit; and
how the two-person rule is expressed.

## What the first review found, and what changed

An independent security review of the first draft (23 November 2026) found
it fit to implement with changes. Its blockers and what was done:

| Finding | Change |
| --- | --- |
| Reserved operators could be signed before their meaning existed | Any operator but `equals` is malformed; a new operator is a new format version |
| The approver was not shown every field the engine acts on | The rendering covers every hashed field, with a test; the setup, what is not counted or tolerated, the browser's setting and the confirmations are named |
| Contradictions in the text were classed as ambiguous and could be confirmed away | The table: by kind of wording and by place, with the adjoining lines of a sentence checked by the engine |
| The held reading was in effect removed, and two claims about the drawing time were false | The held reading is defined and is longer than today's; the limit (a stable number at the end of the time is taken as the value) is stated in the rule, the threats, the risks and the approver's text |

And of its other findings: the hash of the rendered text is signed; a
confirmation names its place and the safeguard has a signed version; the
drawing rule is one rule (the value at the end, stable over the engine's
moment); where version 1 is kept out of trust is named in three places; the
hashes' first members, sequences and vectors are listed; the affirmation is
asked on every binding; the audit record is required; the synthetic shop's
original criteria stay Unverified whatever the fixture shows; leaving is
taken out of version 2 with the experiment's result recorded.
