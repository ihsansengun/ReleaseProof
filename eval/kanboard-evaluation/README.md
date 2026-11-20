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
