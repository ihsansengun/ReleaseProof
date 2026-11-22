# The result of a remote run (`result.json`)

`run-remote` writes two files into its output directory:

- `result.json`: what the run found. This is the file a control plane reads.
- `remote-run.json`: the working behind it (the checked analysis and plan,
  every scenario's full result). Nothing needs it to read the result.

The engine is the only author of `result.json`, and the only place a
run-level verdict is stated. A reader shows what the file says. It does not
work out a verdict, a requirement status or a step outcome from anything else
in it, and it does not treat a captured file as proof of anything.

## Format

The file follows the result contract's **format version 1**: `formatVersion`,
`runId` and `verdict` are where that version puts them. Everything else is
additional and versioned on its own by `producer.resultSchema` (now `1`).
Adding a field needs no new version; changing what a field means does.

| Field | Meaning |
| --- | --- |
| `formatVersion` | `1`. |
| `runId`, `workspaceId`, `projectId` | The run, as the approved request named it. |
| `verdict` | The engine's verdict on the run: `passed`, `failed`, `errored`, `blocked` or `unverified`. |
| `verdictsTrusted` | Whether `passed` and `verified` in this file are statements about the approved requirements. **`false` for every run for now.** |
| `verdictBasis` | `observed`: what the comparisons alone give by the same rule. `reason`. `notTrustedBecause`: set when `verdict` differs from `observed`. |
| `executionStatus` | `completed`, `ended early` or `nothing executed`. How far the run got. A separate fact from the verdict. |
| `endedEarly.reason` | Present when the run stopped before doing everything planned. |
| `producer` | `{ name, resultSchema, kind: "remote-run", executionMode }`. |
| `target`, `snapshots` | Where the run went, and the approved criteria snapshots it used, each with its hash and approver. |
| `coverage` | Requirements by status, `observedOnly`, and scenarios planned, executed and not executed. |
| `requirements[]` | `{ id, status, observedStatus, text, reason, expected, observed, source, stepIds }`. `text` is the approved text as quoted from the snapshot, never the plan's own wording of it. `expected` and `observed` give a compared value only when it is a plain number or amount, and otherwise say `not shown`. |
| `steps[]` | `{ id, scenarioId, action, target, outcome, requirementIds, note, atMs?, durationMs?, screenshot? }`. `outcome` is `ok`, `mismatch` or `error`. `atMs` is counted from the start of the run's first scenario. |
| `profiles[]` | The browser the run used and the page size the run set. Empty when nothing was executed. |
| `telemetry` | For each kind of evidence, `collected` or `not collected`. |
| `diagnostics.console[]` | `{ stepId, level, source?, count }`: errors the page wrote to its console (`error`) and exceptions nothing caught (`uncaught`). What an error said is not kept. `source` is `{ path, line?, column? }`, given only when the browser places the error in a file of the application under test; `count` is how often the same error from the same place happened in the step. Ordinary lines and warnings are not kept. |
| `diagnostics.network[]` | `{ stepId, method, path, status, kind }`: requests to the application answered with 400 or above, and requests that got no answer (`status` 0). |
| `diagnostics.analytics` | An empty list; not collected yet. |
| `evidenceLimits.leftOut` | How many pictures, console entries and network entries the size limits left out. |
| `evidence[]` | `{ id, label, mediaType, path, scenarioId }`: files the run wrote, by a path inside the output directory. `id` is in the form the result contract asks of an evidence id, and is the same for the same file of the same run. The file itself is not in `result.json`. |
| `extensions` | For fields a later engine adds before they are part of this schema. |

## Whose words are in it

A plan and its steps are not the engine's own in a remote run, and what a
page or a request answers is the target's. None of that is repeated here as
if the engine said it:

- the title is "Run against" and the target; the plan's summary of the
  feature is not used;
- a requirement's `text` is the approved quote; its `reason`, the verdict's
  `reason` and a step's `note` are written by the engine from the comparisons
  made, not copied from what a scenario or a step printed;
- a step's `action` is one of the steps an executor can take, or "unknown
  step";
- a step's `target` gives the path asked for, cleaned, without its query,
  fragment, parameters or host; or an element by the kind of locator that
  found it and, for a known role, the role. The words a locator looks for
  are text of the page and are not given;
- a step's `note` says "match" or "mismatch", with the two values only when
  each is a plain number or amount.

What does remain of other hands, and is marked as such by where it stands:

- a step's `target` holds up to 80 characters of the recording's own locator
  words or path. They say which step it was. They are not a statement by the
  engine;
- `expected` and `observed`, and the note of a comparison step, hold the
  values compared, up to 120 characters each. An observed value is what the
  application showed in the element read;
- ids of requirements, scenarios and comparisons are the recording's, checked
  to be plain names.

The fuller account (what each step printed, why each scenario ended) is in
`remote-run.json`, which is not meant to leave the machine as it is. The
browser trace written beside each scenario is not part of the result either:
it holds everything the browser saw, which is more than the result vouches
for.

## Observed and verified

Two different facts are kept apart:

- **Observed**: what a comparison that was made showed. "This element showed
  160" is an observation.
- **Verified**: that an approved requirement holds. That needs the expected
  value and the element read to be the ones the approved text means.

While `verdictsTrusted` is `false`:

- `verdict` is never `passed`. Where every planned scenario ran and every
  comparison matched, `verdict` is `unverified` and `verdictBasis.observed` is
  `passed`.
- No requirement has the status `verified`. Where its comparisons all
  matched, `status` is `unverified`, `observedStatus` is `verified`, and the
  reason begins "Observed, not verified."
- A mismatch (`failed`) and a blocked run are reported as they are. So would
  an application error (`errored`) be; a remote run does not yet produce that
  verdict, which the pull-request path arrives at by running a scenario
  twice.

A reader must not show a result with `verdictsTrusted: false` as "Passed" or
"Ready for release", whatever else the file holds. Showing `verdict` as it is
already satisfies this.

## The run-level verdict

First match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`.

`passed` needs all of: the very scenarios planned ran, each once, and made
every comparison planned; none is blocked in the plan and none was dropped
to stay within the limit; the run did not end early; no conflict about the
approved requirements is open and no earlier rule was taken as replaced
without its owner saying so; there is at least one approved requirement;
every approved requirement, and every example its text states, was compared
and matched; and `verdictsTrusted` is exactly `true`.
Anything short of that is `unverified`. Unknown, incomplete or unsupported
evidence never becomes a pass.

## What the browser showed and said

A remote run collects, for every scenario:

- **a picture after each step**, where one could be kept, of the window as a
  person would see it, and the time the step began and took;
- **console errors** and uncaught exceptions;
- **failed requests** to the application.

**This is evidence of what happened in the browser, and nothing more.** No
verdict, requirement status or count is derived from it, here or by a reader:
a page that loaded, a picture that looks right and a quiet console do not
establish that a requirement holds, and a noisy console does not fail one.
A test asserts that adding console errors and failed requests changes neither
verdict, requirements, coverage nor execution status.

`telemetry.console` and `telemetry.network` are `collected` when every
scenario that ran listened. An empty list beside `collected` means the run
listened and heard no error. That is a fact about the console, not about the
application being right.

### No free text leaves the machine

A console message, an exception's words, the words of a locator and a value
read from a page are written by the application under test, in no known
form. An earlier version of this work cleaned such text by rules. Nine
independent reviews each found text that the rules of the review before had
let through: a credential after a sign the rules did not know, a secret put
together again by the cleaning itself, a value glued to its name by a line
break. Each fix also removed more of what an ordinary message says. Free
text cannot be made safe by rules of that kind, so it is **not kept in any
form, and there is no fallback that keeps it**. Richer diagnostics are a
separate feature, to be designed for security first.

What is kept instead has a form that is checked, by the collector and again
when the result is built. A value that does not fit is left out or said not
to be shown; nothing guesses.

| Kept | Form | Never kept |
|---|---|---|
| A console error or uncaught exception | Its kind, its step, a count, and where the browser places it if that is a file of the application: a cleaned path, a line, a column | What it said; a trace; anything from another origin |
| A failed request | Step, method from a known list, cleaned path, status, the browser's kind of request | Query, fragment, host, headers, bodies, the browser's reason |
| A step | An action from a known list; a cleaned path, or the kind of locator and a known role | A locator's words; what was typed, sent or answered; what the step printed |
| A compared value | Itself, if it is a plain number or amount of at most 24 characters and 12 digits | Any value with words in it: `not shown` |
| A picture after a step | PNG or JPEG named `step-N`, secret fields covered | See below |

**A path is closed by default.** A query, a fragment and `;parameters` are
cut off. Each segment is decoded and kept only if it is plain printable
characters and reads as an ordinary name, a short number, or a file name
whose parts do; anything else becomes `[redacted]`. A mix of letters and
digits longer than six characters is replaced. A segment that names a
credential or a link meant for one person (`token`, `password`, `session`,
`otp`, `pin`, `reset`, `verify` and the like) is kept only as that plain
word, and **every segment after it is replaced**. A path that holds a secret
the executor was given, read as a whole and decoded up to three times, with
or without the empty and hidden segments a reader would skip, is replaced
whole; so is a path with an address inside it. At most 20 segments and 200
characters are kept. Cleaning a cleaned path changes nothing; a test makes
120,000 paths from the pieces that broke earlier versions and holds each to
that, to plain printable output, and to holding no known secret.

Limits:

| | Limit |
|---|---|
| One picture | 400 kB; a larger one is redrawn as JPEG, and left out if still too large |
| All pictures of a scenario | 3 MB |
| Console entries, and network entries, per scenario | 200, and 40 from any one step |

What a limit left out is counted in `evidenceLimits.leftOut`, and so is a
picture that could not be taken. Nothing a page says can stop the run: an
entry that cannot be taken in is counted and left out.

### Pictures

- A picture is of the window as a person would see it. Password, card and
  one-time-code fields (by type, or by what `autocomplete` says) in the page
  and in its frames, and every field the executor typed a secret into, are
  covered with a flat colour. The covering is drawn onto the picture in a
  page of the engine's own, apart from the application's. Nothing is laid
  over the application's page and nothing in it is changed. A test runs a
  page that counts every change to its own document, and it counts none.
- A field the executor typed a secret into is held by its element, not by
  the way it was found, so it stays covered when its label changes.
- **Every field the page reports a place for is covered, or no picture is
  kept.** A place that is not four finite numbers counts as no answer. More
  than 2,000 such fields, more than 40 frames, or any stage taking over four
  seconds, and no picture is kept. Several stages can each take that long,
  so a stalling page can hold a step for some twenty seconds.
- No picture is kept of a page that is not the application under test, as
  far as the step's own check shows: the check is made just before the
  picture is taken, not at the same instant.

**Residual risk: page-controlled field geometry.** Where a field is, is
asked of the page itself, in the page's own script world. A page can see
that it was asked, and a page that answers with a false but well-formed
place leaves its own secret field uncovered in a picture that is kept.
Covering protects against an ordinary application showing a password field.
**It is not safe against a hostile page** and must not be described as such.
Also not covered: anything a page shows as text; a secret in a field of
another kind (a password switched to plain text by a "show" button, a text
area); a field inside a closed component.

### What stays on the machine

`filesThatMayLeave(result)` lists the only files of a run's directory that
may be uploaded, stored elsewhere or shown: `result.json` and the `step-N`
pictures it names. Anything that carries a run's output off the machine must
take its list from there and nowhere else.

- **A remote run records no browser trace and takes no picture at a
  comparison.** Both would hold what the page showed with nothing covered,
  so they are not written at all. A test checks that a run's directory has
  no `trace.zip` and no `check-….png`.
- Each scenario's own record and report (`scenarios/<id>/result.json`,
  `report.md`) hold what steps printed and what pages said, uncleaned. They
  are the run's working record, are not in the list, and stay on the
  machine.
- Hosted execution stays blocked until the retention of that working record
  and access to it are controlled (KAN-16).

A request the run itself stopped (to any other origin) is not listed as a
failure of the application.

Real customer data and real credentials stay out of these runs for now.

The pull-request path collects none of this and is unchanged: it records its
trace and its comparison pictures as before, and uses its own `redact`.

## What is not in it yet

Marked `not collected` in `telemetry`, and absent rather than empty-as-clean:
a screen recording, analytics events and Core Web Vitals. Browser and device
profiles other than the one used are not listed. The picture files are named
in `evidence` by their path in the output; carrying them to a control plane
is a separate step. Each is an added field when it comes, not a new format.

## The pull-request path

Unchanged. Its run report and each scenario's `result.json` keep their
fields; a test pins the scenario result's field names.
