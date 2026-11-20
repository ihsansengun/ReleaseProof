# Independent Kanboard evaluation: preparation record

Kanboard is an open-source project management application written by people
unconnected to this project. This is the first evaluation of ReleaseProof on
software it was not shaped around. Nothing here has been run with a model.

## Sealed answer key

The builds below were prepared on 20 November 2026 by a separate agent that
was given no ReleaseProof evaluation history and was told to report back
nothing about which builds are defective, what the defects are or where.

    SHA-256  538d61a5736f1bf424dca7c7b9706d3f2a8486d42a51e0cdbe4dacc8c832dab0
    size     14219 bytes
    file     ANSWER-KEY.md (not in any repository)

The key was handed to the repository owner unopened by the session operating
ReleaseProof. It is to be published here after the evaluation, unchanged;
anyone can then check it against the hash above, which was committed before
any paid run.

## Builds

Fork: `ihsansengun/kanboard-releaseproof-eval`. Each case has a base branch
and two builds, one defective and one fixed. Which is which is in the key.
Within a case the two pull requests have the same title, body and commit
message, and each build is one commit on its base.

| Case | Ticket | Base branch and commit | Build | Head commit | Pull request |
|---|---|---|---|---|---|
| H, a genuine historical regression | KBE-1 | `eval/h-base` `8ab7694bf6320a4f2f00a1a42b1ce01f794c4295` | `eval/h-a` | `812596f3973ea8dd9c318b1aa0b8ada02cdd52b5` | #3 |
| | | | `eval/h-b` | `5d1a63d32e85f0823e84aacb01571edb19b45f86` | #4 |
| S, an independently seeded defect | KBE-2 | `eval/s-base` `4b3ab6c5fcbb7a9e4552fe5b656597d450b750c8` | `eval/s-a` | `d909fa813f0e10b8dc6eb1427595f3a77bb9abaa` | #5 |
| | | | `eval/s-b` | `0b00f946fd1987248ca85fe2c51363b5e4018019` | #6 |

Requirement tickets: `eval/tickets/KBE-1.json` and `eval/tickets/KBE-2.json`,
prepared on branch `eval/tickets` (`295994f8d44fd9d9ea08a667ba551e4d38a9ae96`)
as fork pull request #7. A run reads tickets only from the fork's default
branch.

### Requirement source, pinned

The repository owner reviewed the acceptance criteria of both tickets and
approved them on 20 November 2026. Pull request #7 was then merged, before
any paid run:

    fork main          6b6d8e09ffcf0be69209fd93f7ee1bdf6d2c271d
    KBE-1.json (blob)  3f22e3358e5a46200da274fd228b0ad76dbc94e2
    KBE-2.json (blob)  132dc305602316f2d96692ddc8a549aea843240d

The merge added those two files and nothing else. Every run of this
evaluation takes its expected values from them at that commit; a run's log
names the ticket's source and the revision it read.

## Readiness checks before the paid runs (20 November 2026, no model)

| Check | Result |
|---|---|
| Ticket keys resolve through the trusted path | Jira has no issue `KBE-1` or `KBE-2`, so the lookup falls through to the ticket file on the fork's default branch. Both files load with the engine's own loader: 8 and 7 acceptance criteria |
| Sealed key unchanged | SHA-256 recomputed without opening the file: equal to the hash above; 14219 bytes |
| Builds unchanged | The head commits of pull requests #3 to #6 equal the table above (heads only; no diff was read) |
| File upload through the interface | **Not supported** by the engine at `0ca3156`: no tool sets a file on a file field, and the HTTP tool sends JSON only. The historical case (KBE-1) is held back until an `upload` tool is merged. Pasting an image from the clipboard is not supported either, so KBE-1's screenshot criterion cannot be verified |
| Cost limit | A request can only lower the configured limit, which is $2 a run unless the repository variable `RELEASEPROOF_MAX_USD` is set. The effective limit is the `limits:` line of each run's log |

## What the preparation agent stated

- The historical regression was reproduced on the affected upstream
  revisions themselves, and then on the two branch builds.
- The seeded defect was reproduced on its build by following only the
  ticket. Every acceptance criterion passes on the fixed build of each case.
- All four builds start, and the default administrator signs in, under the
  sandbox's restrictions.
- Requirements were taken from upstream commit descriptions, the ChangeLog,
  upstream unit tests, upstream interface texts and the behaviour of good
  upstream revisions; never from the defective code. The source of each
  criterion is in the key.
- No Kanboard business logic was changed other than upstream's own commits
  and the one seeded defect. Nothing was pushed to `main`, nothing merged.
- It could not build the real test image locally (package mirrors are not
  reachable there) and used a local variant with the same start command.

These are the agent's statements. The free verification below is what this
project checked itself.

## Chain of custody, and its limits

- The operating session did not open the key, the preparation agent's clone
  or the build pull requests' diffs, and compared no branches.
- That is a matter of conduct, not of access: the key file and the clone
  were on the same machine, and the fork is public. The hash shows the key
  was not changed after the builds were made; it cannot show that nobody
  looked.
- The fork's `main` holds all of upstream's history. A genuine historical
  regression is by nature findable there. The engine reads the pull request,
  the ticket and the running application, not the default branch's log.
- The QA agent sees each pull request's diff, as it would in normal use.
  What is withheld from it is which build is defective and what is wrong.

## Paid run 1 (seeded pair, pull request #5): no result

20 November 2026, QA run [44749488852](https://github.com/ihsansengun/ReleaseProof/actions/runs/44749488852),
engine `main` at `0ca3156`, Opus 5.5 analysis and planning, Haiku 5.5
discovery and execution, Sonnet 5.5 escalation. Recorded before the key is
opened. This run says nothing about the build.

Lines from the job log, as printed:

    ticket: KBE-2 from a ticket file on the default branch
    requirements: protected revision 6b6d8e09ffcf, 0 approved document(s), 1 GitHub and 1 Jira requirement owner(s)
    limits: $2, 15 min, 3000000 tokens, 8 scenarios
    Incomplete: 0 failed, 0 passed · 0 of 29 requirements verified · 8 without a verdict · 5 scenarios blocked · 2 not run (limit)
    requirements: {"verified":0,"failed":0,"blocked":0,"unverified":28,"exercised":0,"deferred":1,"not planned":0}

| | |
|---|---|
| Requirements found | 29 |
| Scenarios started | 8 (S1 to S3, S5 to S9); 2 more not run because of the 8-scenario limit |
| Passed / failed | 0 / 0 |
| Blocked | S1, S2, S3 |
| Unverified | S5 to S9 (S8 and S9 never began) |
| Comparisons made | 0 of 37 |
| Failure patterns, defect candidates, false positives | none: nothing was compared |
| Escalations | 0 |
| Cost | $0.88: discovery $0.00, analysis $0.27, planning $0.52, execution $0.09 |
| Time | 6.5 minutes: analysis 92 s, planning 173 s, execution 85 s |

Why nothing was tested:

1. **The two test users could not be created.** Every scenario began by
   creating the ticket's users, and each stalled on the "New user" form: no
   "Save" control by role or by text. The executor had opened the form by
   the address its link carries. Kanboard answers that address with a piece
   of HTML meant for a dialog; the button is drawn by the page's scripts,
   which a bare piece does not have. Posting the form directly returned the
   form again. Checked afterwards without a model on the neutral base branch
   `eval/s-base`: scripts load and run in the engine's browser, clicking
   "New user" opens the dialog with its button, the user is saved, and the
   suggestion list of the Permissions page appears after typing.
2. **The token limit ended the run**: 3,041,906 of 3,000,000, with $0.09
   spent on execution. The limit counts every re-read of the cached
   conversation, and this application's pages are large.

Also seen:

- The $3 limit requested was capped at $2: `RELEASEPROOF_MAX_USD` is not set.
- No report comment appeared on the fork's pull request although the report
  job succeeded. Figures here come from the job log.
- The plan's last scenario assumed a non-administrator account that the
  fork's manifest does not declare. The run ended before it began.
- One conflict about the approved requirements was reported unresolved. The
  log does not say which.

What changed afterwards, in the engine and for any application: opening an
address that answers with a part of a page is now reported to the executor
and marked in the application map (see `docs/RELIABILITY-BACKLOG.md`).
Run 2 (pull request #6) was not started.

## Paid run 2 (seeded pair, pull request #5 again): no result

20 November 2026, QA run [44755631966](https://github.com/ihsansengun/ReleaseProof/actions/runs/44755631966),
engine `main` at `27e6e5f` (with the part-of-a-page guard and the upload
tool), same models. Recorded before the key is opened. This run says
nothing about the build.

Lines from the job log, as printed:

    ticket: KBE-2 from a ticket file on the default branch
    requirements: protected revision 6b6d8e09ffcf, 0 approved document(s), 1 GitHub and 1 Jira requirement owner(s)
    limits: $2, 15 min, 3000000 tokens, 8 scenarios
    Incomplete: 0 failed, 0 passed · 0 of 25 requirements verified · 8 without a verdict · 5 scenarios blocked · 5 not run (limit)
    requirements: {"verified":0,"failed":0,"blocked":1,"unverified":20,"exercised":0,"deferred":4,"not planned":0}

| | |
|---|---|
| Requirements found | 25 |
| Scenarios | 8 selected (S1, S3, S5, S7, S8, S9, S10, S12); 5 not run because of the scenario limit |
| Passed / failed | 0 / 0 |
| Blocked | S1, S3, S5 |
| Unverified | S7, S8, S9, S10, S12, never begun |
| Comparisons made | 0 of 29 |
| Failure patterns, defect candidates, false positives | none: nothing was compared |
| Escalations | 0 |
| Cost | $0.89: analysis $0.22, planning $0.41, execution $0.26 |
| Time | 5.6 minutes |

What worked: in all three scenarios that ran, both test users were created
through the "New user" dialog. No tool call failed.

Why nothing was tested:

1. **The search could not be submitted.** The user list's search box has
   no button; a user presses Enter. The executor had no way to press a key.
   It typed the term, tried a line break, clicked elsewhere, then opened the
   list with a parameter of its own guessing. The list kept showing all
   users, and it reported blocked instead of comparing an unfiltered list.
2. **The token limit ended the run** after three scenarios: 3,060,883 of
   3,000,000. `RELEASEPROOF_MAX_TOKENS` was not set.

Paid so far: $1.77 in two runs without a result. Pull request #6 and the
historical pair were not started.

## Walkthrough without a model (after run 2)

What should have preceded the first paid run. The journeys of both tickets
were driven with the executor's own tools (`openSession`, `runTool`) against
the neutral base branches `eval/s-base` and `eval/h-base`, started locally.
Neither is one of the four builds.

| Journey | At first | After the changes |
|---|---|---|
| Create the two users through the "New user" dialog | works | works |
| Search the user list: a term, a term with no match, an empty term | no way to submit; and a second term was appended to the first, because the page moves the caret when the box takes the focus | works: Enter submits; `fill` checks what the field holds |
| Read the title "Users (n)", the rows and "No users found." | works | works |
| Type in the Permissions "Name" field and read the suggestions, or their absence | the list arrived after `fill` had returned, and a stale one was shown for the next term | works: `fill` waits for what follows typing |
| Sign out, sign in as a second user | the menu link's name ends in an icon glyph and could not be matched | works: glyphs are not part of a name |
| Non-administrator opens the user list: page text and HTTP status 403 | works | works |
| Board, "+" of a column, "New task" form | four identical links, one per column; the tools had no column-header role to tell them apart | works: common landmark roles added |
| Save without a title: "The title is required" | works | works |
| "Create another task": form opens again, empty | works | works |
| Attach two files to an existing task through "choose files"; listed with name and size | works with the upload tool | works |
| Download an attachment and compare its content | text file: works. Picture: the bytes are returned as text and cannot be compared | unchanged |

Not possible, and not attempted in a paid run: pasting an image from the
clipboard; dragging a file onto the page.

The base branches do not have the feature either ticket adds, so the
attachment section of the "New task" form and the e-mail search itself were
not walked. They use the same controls as the journeys above.

## Before the remaining paid runs (20 November 2026, no model)

- `RELEASEPROOF_MAX_TOKENS` = 12000000 and `RELEASEPROOF_MAX_USD` = 3 were
  set by the repository owner. A full dispatch on the fork's pull request
  #2, whose title names no ticket, ended before any model call and showed
  the job receiving both values (QA run 44765464622).
- Isolation on `main` at `8636ede` (QA run 44766351777, verify-only):
  outbound network blocked, root filesystem read-only, user 10001, the
  administrator signed in, a second separate container started.
- Model-free preflight on the neutral base branches: 17 of 17 journeys.
- Key hash, the four build heads and the requirement source: unchanged
  before each paid run.

## Paid runs 3 to 6: raw results

Engine `main` at `8636ede` for all four. Opus 5.5 analysis and planning,
Haiku 5.5 discovery and execution, Sonnet 5.5 escalation. Each run printed
`limits: $3, 15 min, 12000000 tokens, 8 scenarios` and read its ticket
from the file at revision `6b6d8e09ffcf`. Each planned from scratch; nothing
from one run was given to another. **Written before the key was opened.**
Judgements marked "blind" were made without the key.

| | PR #5 (KBE-2) | PR #6 (KBE-2) | PR #3 (KBE-1) | PR #4 (KBE-1) |
|---|---|---|---|---|
| QA run | [44767161887](https://github.com/ihsansengun/ReleaseProof/actions/runs/44767161887) | [44772422779](https://github.com/ihsansengun/ReleaseProof/actions/runs/44772422779) | [44776279713](https://github.com/ihsansengun/ReleaseProof/actions/runs/44776279713) | [44780379990](https://github.com/ihsansengun/ReleaseProof/actions/runs/44780379990) |
| Summary line | Incomplete: 0 failed, 2 passed | Incomplete: 0 failed, 1 passed | Not ready: 3 failed, 0 passed | Not ready: 2 failed, 2 passed |
| Requirements found | 27 | 23 | 29 | 26 |
| Requirements verified | 15 | 8 | 8 | 14 |
| Scenarios executed | 8 | 8 | 8 | 8 |
| Passed / failed | 2 / 0 | 1 / 0 | 0 / 3 | 2 / 2 |
| Blocked / unverified | 2 / 4 | 1 / 6 | 3 / 2 | 2 / 2 |
| Held back by the planner | 4 | 5 | 8 | 6 |
| Not run (scenario limit) | 4 | 4 | 3 | 2 |
| Comparisons: match / mismatch | 13 / 0 | 11 / 0 | 16 / 3 | 20 / 4 |
| Planned comparisons not made | 21 | 22 | 24 | 13 |
| Failure patterns | 0 | 0 | 1 | 3 |
| Evidence-backed candidates | 0 | 0 | 0 | 0 |
| Escalations (kept) | 0 | 0 | 2 (0) | 5 (1) |
| Run ended by | token limit | token limit | time limit | time limit |
| Time | 7.7 min | 7.7 min | 15.4 min | 15.3 min |
| Cost | $1.54 | $1.62 | $1.50 | $1.79 |

Paid in all: $0.88 + $0.89 + $1.54 + $1.62 + $1.50 + $1.79 = **$8.22** of
the $12 allowed, in six runs. The first two compared nothing.

### PR #5 (KBE-2)

Compared, all matching: complete address of John Doe gives the title
"Users (1)"; "@example.com", "mary@" and "example.com" each list 0 users;
"No users found."; a complete address in the Permissions field gives at
least one suggestion; suggestions never show the address (twice); a
non-administrator gets "Access Forbidden" on the list and on a search (S7,
passed); "jd", "SMITH" and "mary" find the right users (S8, passed).

Not compared: that the complete-address search lists John Doe and only him
(the row count read 5 and the name reading read the avatar initials "JD",
so neither was used); the lower-case address (searched, nothing recorded);
"Users (0)"; the suggestion's text "Mary Smith (msmith)" (22 list items,
none singled out); partial addresses in the Permissions field, the empty
search, "nobody", near-complete addresses (S6, S9, S11: token limit).

### PR #6 (KBE-2)

Compared, all matching: lower-case address lists John Doe, upper-case
address lists Mary Smith, the profile shows the address as entered (S3,
passed); "@example.com" gives "Users (0)"; "example.com" and
"%@example.com" give 0 entries and "Users (0)"; the empty search gives 3
entries and lists admin, John Doe and Mary Smith.

Weak: "0 entries" was a count of bold elements and "3 entries" a count of a
per-row icon label. Not row counts.

Not compared: complete address finds that user only with "Users (1)" (S12,
never begun); "mary@" (the count included the "New user" link and read 1,
so it was not used); "No users found."; username and name search; the
Permissions suggestions; the non-administrator 403 (token limit).

Blind, for the pair: neither run reported a failure, so a seeded defect in
one of the two builds was not detected. No false positive on either. The
two runs covered mostly different rules.

### PR #3 (KBE-1)

Mismatches, one pattern (`F1: comparisons resting on R9, R28: numbers off
by 2, 1`), each `standing: single`, each "reproduced" on replay:

| | Compared | Expected | Read | Target |
|---|---|---|---|---|
| S1/A4 | attachment entries on the task's page | 2 | 0 | links with an empty name within the text "Attachments" |
| S10/A3 | attachment entries on "First of batch" | 1 | 0 | link "alpha.txt" within group "Attachments" |
| S11/A1 | attachment entries after uploading to an existing task | 1 | 0 | link "gamma.txt" within group "Attachments" |

Blind: S1 and S11 are false positives. In the same scenarios the file
names, the sizes (29 and 28 bytes) and the downloaded contents matched, so
the files were attached, and in S11 the container "Attachments" was later
reported as not found. S10 used the same target and has nothing else
compared: unsupported. The executor's own closing notes say the counts were
mis-targeted. The engine recorded them because a count of zero is a
reading, and the replay repeats the same target.

An application error, recorded as blocked and not as a failure: in S7, a
project with two categories, saving the "New task" form with a file
attached answered `Internal Error: SQL Error[HY000]: SQLSTATE[HY000]: G…`
(cut in the log), on two attempts. The task was not created; none of the
scenario's nine comparisons could be made.

Matches: both files' names, sizes and downloaded content (S1); the file
area's text and the rest of the form (S2); a task without attachments is on
the board with 0 attachments (S4); no task without a title (S6); name and
content of a file attached to an existing task (S11).

Not compared: the section's title and collapsed state (a group legend, not
a heading); the screenshot text in the kept run; removing a listed file
(the control could not be singled out); the two messages; the "create
another" count and empty form; everything in S7.

### PR #4 (KBE-1)

Mismatches, three patterns, each `standing: single`, each "reproduced":

| | Compared | Expected | Read | Target |
|---|---|---|---|---|
| S2/A2 | files listed in the form reopened by "Create another task" | 0 | 1 | count of the text "first.txt" |
| S2/A5 | attachments of the second task, saved with no file chosen | 0 | 1 | count of the text "first.txt" on that task's page |
| S8/A3 | screenshot area text | the paste text | "Add attachments" | the section's summary element with a pattern |
| S8/A4 | file area text | the drag-and-drop text | "Add attachments" | the same element |

Blind: S2 is probably a real defect. Two readings at two places agree, and
the escalated attempt, whose own counts were mis-targeted, describes the
same thing ("the reopened form still listed first.txt, which looks like a
leak"). S8 is a false positive: the evidence record shows both expected
texts inside the element that was read; only its first words were taken.

One escalation was kept: S5's first attempt read the error text from the
wrong place and failed; the re-run read "The title is required" and passed.

Matches: two files listed before saving, stored with names, sizes (29 and
34 bytes) and unchanged content (S1, nine comparisons); a task without
attachments shows the success message, is on the board, has 0 attachments
and keeps assignee, column and priority (S3, passed); no task without a
title, with the error text (S5, passed); a file attached to an existing
task is listed (S10).

Not compared: removing a listed file; attachment counts in four scenarios
(recorded as 0 through targets that matched nothing, and left unused);
projects with categories or several swimlanes (not in this run's eight).
No application error appeared in this run.

### Capability limits, both KBE-1 runs

Pasting an image from the clipboard is not possible with the engine's
tools. Criterion 4 of KBE-1 (a pasted screenshot is previewed and saved as
"Screenshot taken …png") was not tested on either build. That is a limit of
the tool and says nothing about the application.

### Problems seen across the four runs

- A count that matches nothing is recorded as 0 and compared. Five of the
  seven mismatches come from that or from reading the wrong element.
- An application error that stops a scenario is recorded as "blocked".
- The token limit ended both KBE-2 runs after about five scenarios; each
  scenario creates its two users again in a new container.
- Between 11 and 40 tool calls per run failed on targets that matched no
  element or several. Each was refused.
- Unnamed controls (the remove link beside a listed file) cannot be named.
- One evidence record names the actor as the administrator although the
  page was read as the second user (PR #5, S7).
- No report comment appeared on the fork's pull requests.
