# Cleaning what leaves the machine: where it stands and where it goes

Status: **plan**. Steps 1 and 2 are done for what a remote run collects.
The rest is proposed, not started.

## Why this page exists

What a browser said during a run (console errors, the addresses of failed
requests) leaves the machine in the result, so it has to be cleaned of
credentials, e-mail addresses, tokens and the secrets the executor was given.

The first three attempts cleaned a text by running patterns over the whole of
it. Each was reviewed independently, and each failed in the same two ways:

| Attempt | What went wrong |
| --- | --- |
| The shared `redact`, over the whole console line | Its time grows with the square of the line: one 150,000-character line held a run for 20 seconds, past its time limit |
| A second pattern for names such as `access_token` | Its time grew with the cube of a line made of its own words: five lines, 20 seconds |
| Bounding that pattern and cleaning paths by another rule | A credential that was the first name in a printed object stopped being redacted; a long name hid its value; ordinary paths of 32 characters were wiped whole; cleaning twice doubled a bracket |

The lesson: a general pattern over an arbitrary text is fragile in both
directions. A small change to what it matches changes what it misses, and its
cost depends on input an application under test controls.

## What is in place now (`packages/agent/src/execute/clean.ts`)

1. **Bounded, structured cleaning.** A text is cut to 4,000 characters, split
   into words, and each word is read once, left to right. There is no pattern
   that can go back over what it has read, so the time taken grows with the
   length of the text and no faster. Tests hold each pattern once found slow
   to under 150 ms, and a whole scenario's worst case to under two seconds.
2. **Addresses are parsed, not matched.** An address is given to the URL
   parser, and only its path is kept. A path is cleaned segment by segment and
   is closed by default: a segment stays only if it reads as an ordinary name
   or a short number.
3. **Known secret values first.** The secrets the executor was given are
   replaced by the session's own function before anything else, and the
   placeholder it leaves stands untouched.
4. **One function, used twice.** The collector cleans as it collects, and the
   result cleans again as it is built, by the same rules. Cleaning what is
   clean changes nothing; a test asserts it.

The pull-request path does not use this. It keeps the shared `redact`
(`packages/agent/src/report/diagnostics.ts`), unchanged.

## What it still does not do

- It knows shapes, not meanings. A secret with no name beside it ("the code is
  493817"), a card number written in groups, a telephone number, a postal
  address or a person's name passes.
- A value encoded another way (base64 of a password, percent-encoding inside a
  text) passes unless it is long enough to look opaque.
- It cannot clean a picture. Fields are covered before a picture is kept, by
  kind (password, card, one-time code) and where the executor typed a secret.
  Anything a page shows as text is in the picture.
- It errs toward removing: "password: must be at least 8 characters" loses
  the word after the name; an id written in groups is replaced in a path.

## Proposed next steps

Each is a small pull request of its own. None is started.

1. **Move the pull-request path's summaries onto the same cleaner**, behind a
   comparison first: run both over the recorded diagnostics of existing runs
   and list every difference, so that nothing a report shows today is lost
   without being seen. Then retire the quadratic patterns in `redact`.
2. **A register of secret values, not only of the executor's.** Today the
   session knows the secrets it was given. Add: the passwords of accounts a
   target's manifest declares, any value a run's request marks as secret, and
   values read from fields that were covered. Redact each exactly, and its
   common encodings (percent, base64, hex), wherever it appears, before any
   rule about shapes runs.
3. **Structured entries end to end.** Keep a console message as its parts
   (the text template and its arguments) where the browser gives them, and a
   request as method, path and status. Clean each part by its kind. A printed
   object is then cleaned as names and values, not as a line of text.
4. **Tests that generate their input.** Property tests: for any text built
   around a planted secret, the secret is not in the output; cleaning twice
   equals cleaning once; time stays under a bound for any input up to the
   limit. A corpus of real console output from the demo applications, kept as
   a fixture, to catch over-redaction.
5. **A switch for strictness.** For runs against applications with personal
   data: keep no console text at all, only that an error happened, its kind,
   and the step. Text is opt-in per project.
6. **Pictures.** Cover by more than kind: every field a person can type into,
   on request; and regions a project names. Decide, with the storage design,
   who may see a picture and for how long (private object storage,
   authenticated access, retention limits).

## What stays true whatever is built

Real customer data and real credentials stay out of runs until steps 2, 5 and
6 exist and have been reviewed. Cleaning lowers the chance of a leak. It does
not make it safe to point this at data that must not leak.
