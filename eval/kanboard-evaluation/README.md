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
