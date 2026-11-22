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
| `diagnostics.console[]` | `{ stepId, level, endpoint, count }`: errors the page wrote to its console (`error`) and exceptions nothing caught (`uncaught`). What an error said and where it came from are not kept. `count` is how often such an error happened in the step. Ordinary lines and warnings are not kept. |
| `diagnostics.network[]` | `{ stepId, status, kind, failure, endpoint, count }`: requests to the application answered with 400 or above (`failure` is `error answer`), and requests that got no answer (`status` 0, `failure` is `no answer`). `kind` is the browser's kind of request (`fetch`, `image`, `script` and so on). No address or part of one is kept. |
| `endpoint` (in both, and in a step's `target`) | The id of a route on the operator's trusted list, when the path asked for is exactly that route's path; otherwise the words `Endpoint not recorded`. |
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
- a step's `target` names an endpoint by an id from the operator's trusted
  list, or says `Endpoint not recorded`; or gives an element by the kind of
  locator that found it and, for a known role, the role. No path is given,
  and the words a locator looks for are text of the page and are not given;
- a step's `note` says "match" or "mismatch", with the two values only when
  each is a plain number or amount.

What does remain of other hands, and is marked as such by where it stands:

- `expected` and `observed` hold a compared value only when it is a plain
  number or amount. An observed value is what the application showed in the
  element read;
- a requirement's `text` is a quote the recording chose, and is shown only
  because the very same characters stand in an approved snapshot, in the
  same case and with the same spaces, and it is no longer than 600
  characters;
- which entries there are, and their numbers, follow from what the page
  did, and a page that set out to could choose them. No field holds text of
  the page's, but the numbers add up: each entry has a status (0, or 400 to
  599), a kind of request from a list of 13, an endpoint from the list, a
  count up to 100 and the step it belongs to, and there are up to 12 entries
  of each sort a step and 60 a scenario. That is room for some hundreds of
  bytes a scenario, enough to spell out a short secret in statuses and
  counts. A review did so with a 40-character key before the limits were
  lowered to these. It is a reason, with the pictures, not to run this
  against a page that may be working against the run;
- ids of requirements and of the steps and comparisons tied to them are the
  recording's, checked to be plain names when the recording is read;
- ids of requirements, scenarios and comparisons are the recording's, checked
  to be plain names.

The fuller account (what each step printed, why each scenario ended) is in
`remote-run.json` and each scenario's own record, which are not cleaned and
stay on the machine. A remote run records no browser trace.

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

### No free text and no address leaves the machine

A console message, an exception's words, the words of a locator, a value
read from a page and the address of a request are written or chosen by the
application under test, in no known form. Earlier versions of this work
cleaned them by rules: first free text, and then, when free text was no
longer kept, paths alone. Thirteen independent reviews each found something
that the rules of the review before had let through: a credential after a
sign the rules did not know, a secret put together again by the cleaning
itself, a value after a credential's name written in a way the list of names
did not hold, a known secret cut short at a `#`. Text and addresses of that
kind cannot be made safe by rules about what a secret looks like. So they
are **not kept in any form, and there is no fallback that keeps them**: no
raw address, host, query, fragment, path segment or message.

What is kept has a form that is checked, by the collector and again when the
result is built. A value that does not fit is left out or said not to be
recorded; nothing guesses.

| Kept | Form | Never kept |
|---|---|---|
| A console error or uncaught exception | Its kind, its step, a count, and an endpoint name (see below) | What it said; where it came from; its trace |
| A failed request | Its step, the status (0, or 400 to 599), the browser's kind of request from a fixed list, whether it was answered, a count, and an endpoint name | The address or any part of it; the method; headers, bodies; the browser's reason |
| A step | An action from a known list; an endpoint name, or the kind of locator and a known role | A path; a locator's words; what was typed, sent or answered; what the step printed |
| A compared value | Itself, if it is a plain number or amount of at most 24 characters and 12 digits | Any value with words in it: `not shown` |
| A picture after a step | PNG or JPEG named `step-N`, secret fields covered | See below |

**An endpoint is named only from a trusted list.** The operator of a run may
list routes of the application in the target manifest, as `evidenceRoutes`:
each an `id` (a short name in small letters, digits and `-`) and a `path`
(a static path of plain names: no query, no pattern, nothing to fill in). A
request or a console error's file is named by a route's `id` only when it
is a web address on the application's own origin whose path, as the browser
gives it, is exactly that route's `path`. (A browser tidies an address
before it asks: `/api/x/../points` is asked for as `/api/points`, and is
named so.) A recorded step is named only when the path it gives is, as
written and before any `?` or `#`, character for character a route's
`path`; nothing is resolved or tidied first. A page can choose which listed
file its own error is placed in (it can name its scripts), which is a
choice among the ids on the list and nothing more. In every other case, and when there is
no list, the entry says `Endpoint not recorded`. Nothing of the address is
used for anything else. An uncaught error never names an endpoint: where it
came from would have to be read from its trace, which is the page's own
text.

The list is not the page's and not the recording's: it is read from the
target manifest the operator names, and nothing a recording or a page does
reaches it. It is used for naming and nothing else: it opens no address,
changes no requirement and no verdict. An entry whose id or path is not in
the form above is left out (a manifest whose list is not a list of such
pairs at all is refused whole), at most 50 are read, and the result is built
with the same check, so only an id on the list can stand where an endpoint
is named.

Limits:

| | Limit |
|---|---|
| One picture | 400 kB; a larger one is redrawn as JPEG, and left out if still too large |
| All pictures of a scenario | 3 MB |
| Console entries, and network entries, per scenario | 60, and 12 from any one step |
| A count | 100, which then means 100 or more |

Errors of one kind and requests of one status, kind and endpoint in a step
are one entry with a count. What a limit left out is counted in
`evidenceLimits.leftOut`, and so is a picture that could not be taken.
Nothing a page says or asks for can stop the run: an entry that cannot be
taken in is counted and left out.

### Pictures

- A picture is of the window as a person would see it. Password, card and
  one-time-code fields (by type, or by what `autocomplete` says) in the page
  and in its frames, and every field the executor typed a secret into, are
  covered with a flat colour. The covering is drawn onto the picture in a
  page of the engine's own, apart from the application's. Nothing is laid
  over the application's page and nothing in it is changed. A test runs a
  page that counts every change to its own document, and it counts none.
- A field the executor typed a secret into is held by its element, not by
  the way it was found, so it stays covered when its label changes. It is
  let go only when the browser itself has reported that the page loaded a
  new document since; that is the browser's word, not the page's. In the
  same document, any failure to ask the element where it is means no
  picture, whatever caused it.
- A form field or editable text found holding the very value the executor
  typed is covered too, in the page and in its frames: an application may
  answer a form with what was sent, a browser may put a value back when it
  goes back, and a page may draw its form anew. What each field holds is
  read out and compared in the engine; **the secret is never handed to a
  page or a frame to look for.** Up to 5,000 fields and 4,000 characters of
  each are read; beyond that, or after more than 50 different secrets, no
  picture is kept.
- That second check finds a value only where a page lets it be read and
  only as it was typed. It does not find a secret shown as plain text, one
  the page has changed (cut, spaced out, encoded, in capitals), one in a
  closed component, or one behind a field the page has made to answer
  falsely. A page that set out to could also carry a field into a new
  document and change what it holds. These are the same limit as above:
  covering is not safe against a hostile page, and anything a page shows as
  text is in the picture.
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
Also not covered in a picture: anything a page shows as text; a secret in a
field of another kind (a password switched to plain text by a "show" button,
a text area); a field inside a closed component.

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
