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
| `requirements[]` | `{ id, status, observedStatus, text, reason, expected, observed, source, stepIds }`. `text` is the approved text as quoted from the snapshot, never the plan's own wording of it. |
| `steps[]` | `{ id, scenarioId, action, target, outcome, requirementIds, note, atMs?, durationMs?, screenshot? }`. `outcome` is `ok`, `mismatch` or `error`. `atMs` is counted from the start of the run's first scenario. |
| `profiles[]` | The browser the run used and the page size the run set. Empty when nothing was executed. |
| `telemetry` | For each kind of evidence, `collected` or `not collected`. |
| `diagnostics.console[]` | `{ stepId, level, text }`: errors the page wrote to its console (`error`) and exceptions nothing caught (`uncaught`). Ordinary lines and warnings are not kept. |
| `diagnostics.network[]` | `{ stepId, method, path, status, kind, failure? }`: requests to the application answered with 400 or above, and requests that got no answer (`status` 0). |
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
- a step's `target` gives the path asked for without its query, fragment,
  parameters or host, or an element by how it was located.

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

It leaves the machine, so it is kept small and kept clean:

| | Limit |
| --- | --- |
| One picture | 400,000 bytes. A larger PNG is taken again as a JPEG; if still larger it is left out |
| All pictures of one scenario | 3,000,000 bytes |
| Console entries, and network entries, per scenario | 200 each, and 40 from any one step |
| Any one text | 300 characters, of the first 4,000 a page wrote; the rest is not looked at |

- Text is cleaned word by word, not by patterns run over a whole line
  (`packages/agent/src/execute/clean.ts`; why, and what comes next, is in
  `docs/evidence-redaction-plan.md`).
  The secrets the executor was given go first; then the text is cut to 4,000
  characters, and a word the cut went through is dropped. It is read once
  into words and the signs between them. Removed: an address down to its
  cleaned path, wherever in a word it starts; e-mail addresses; **everything
  after the point a credential's value begins**, that is after a name that
  is a credential's (`password`, `access_token`, `clientSecret`, `pwd`,
  `x-auth`, `Cookie`, `Authorization` and the like) and a sign or a verb
  (`=`, `:`, `=>`, `->`, `:=`, `is`, an opening bracket), or after `Bearer`,
  `Basic`, `Digest`, `Negotiate` or `Token`. Where a value begins can be
  told; where it ends cannot, so no attempt is made and the rest of the text
  goes. Also removed: a long word of
  letters and digits mixed, a very long word, a long run of digits. What is
  already redacted, and the engine's own placeholder for a secret, are set
  aside first and stand as they are, and the rest of their word is judged as
  any other. The time this takes grows with the length of the text and no
  faster.
- An address, in a network entry or inside a console text, is given as its
  path: no query, fragment, parameters or host. A path is closed by default:
  a segment is kept only if it reads as an ordinary name or a short number
  (`/api/v2/international-shipping-rates`, `/orders/12345`). Anything else is
  replaced: an e-mail address, a token, an id written in groups, `name=value`
  under a credential's name. A file keeps the ordinary parts of its name and
  its ending (`app-[redacted].js`).
- A picture cannot be cleaned after it is taken. Password, card and
  one-time-code fields (by type, or by what `autocomplete` says) in the page
  and in its frames, and every field the executor typed a secret into, are
  covered with a flat colour. The covering is drawn onto the picture in a
  page of the engine's own, apart from the application's. **Nothing is laid
  over the application's page and nothing in it is changed**, so taking
  pictures cannot alter what a later step reads. A test runs a page that
  counts every change to its own document, and it counts none.
- **Every field found is covered, or no picture is kept.** There is no count
  beyond which fields are left showing. A page with more than 2,000 such
  fields or more than 40 frames, or on which any one stage of finding or
  covering them takes over four seconds, gets no picture. There are several
  such stages, so a step on a page that stalls each of them can be held for
  some twenty seconds before it is given up. The page the covering is drawn
  in is discarded after a failure and closed with the run.
- No picture is kept of a page that is not the application under test.
- What a limit left out is counted in `evidenceLimits.leftOut`.
- The result cleans every text and path once more as it is built, by the same
  rules, and checks each entry's form (kinds, lengths, whole numbers, known
  steps). An entry that does not fit is left out and counted. Cleaning what
  is clean changes nothing.

**What this does not catch.** The rules know shapes, not meanings. These can
still appear:

- in text: a secret with no name beside it ("the code is 493817"); a card
  number written in groups, a telephone number, a postal address, a person's
  name; a short value encoded another way; the password of an account the
  target's manifest declares;
- in text, also: a secret in a sentence with no name the rules know ("the pw
  was …"); a credential's name with its value straight after it and no sign
  or verb between ("password hunter3"); a name in one item of a list and its
  value in the next; a short secret of mixed characters cut into pieces by
  `&`, `|` or a comma, each piece too short to look like one; what a page
  writes from a template or a function's source;
- in a picture: anything the page shows as text; a field of another kind
  that holds a secret (a password shown in a plain text field, a text area);
  a field inside a closed component, which the engine cannot see into; a
  field that jumps about in the instant between being looked for and the
  picture being taken (it is looked for before and after and both places are
  covered, but one that moves several times in that instant can show).

And it errs toward removing: a message such as "password: must be at least 8
characters", "token is missing" or "tokens: 3 remaining" loses everything
after the name, and so does whatever followed a credential in the same line;
in a path, an id written in
groups, a name of seven words or more, and a segment with brackets, a colon
or a comma are replaced. That is the safe side to be wrong on.

That is why real customer data and real credentials stay out of these runs
for now.

A request the run itself stopped (to any other origin) is not listed as a
failure of the application. The picture the shared comparison code takes at a
comparison (`check-….png`, of the whole page, nothing covered) and the
browser trace stay in the run's directory and are not part of the result.

The pull-request path does not collect any of this: it is off unless a run
asks.

## What is not in it yet

Marked `not collected` in `telemetry`, and absent rather than empty-as-clean:
a screen recording, analytics events and Core Web Vitals. Browser and device
profiles other than the one used are not listed. The picture files are named
in `evidence` by their path in the output; carrying them to a control plane
is a separate step. Each is an added field when it comes, not a new format.

## The pull-request path

Unchanged. Its run report and each scenario's `result.json` keep their
fields; a test pins the scenario result's field names.
