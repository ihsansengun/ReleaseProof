# Evidence from the browser: what is kept, and why free text is not

Status: decided in engine pull request #45. This replaces an earlier plan to
clean free text by structured rules.

## What was tried

A remote run collects what the browser showed and said so that a report can
show it. The first versions cleaned console messages and other text by
rules before keeping them: patterns over the whole line, then a word-by-word
reader, then "remove everything after a credential's name".

Nine independent reviews each found text the rules of the review before had
let through. Among them:

| Round | What got through |
|---|---|
| 1 to 3 | Lines whose cleaning took seconds; a credential that was the first name in a printed object |
| 4 and 5 | Names in quotes; a value kept after its first punctuation mark |
| 6 | A line that stopped the engine; `login?next=home&password=…`; a known secret written in `%`-codes |
| 7 | `config['password'] = '…'`; values under a requirement never cleaned |
| 8 | `password for admin: …`; a known secret put together again by the path cleaner |
| 9 | `password\r…` glued by the cleaner itself; `token-…`; `/reset/token/…` |

Each fix also removed more of ordinary messages: by the ninth round one
console line in four lost its diagnosis.

Free text was then dropped, and only the path of an address was kept,
cleaned segment by segment with a list of credential names. Four more
reviews found path cases the same way:

| Round | What got through |
|---|---|
| 10 | `/verify-email/493817`: a name the list held only in the singular |
| 11 | A known secret cut short by the 1,000-character read limit; `/otpcode/…` |
| 12 | `/otp1/…`; a known secret holding `;` cut at the sign |
| 13 | A known secret holding `#`, cut by the browser before the engine saw it |

The lesson: text and addresses of no known form, written or chosen by the
application under test, cannot be made safe by rules about what a secret
looks like. Where a value begins and ends cannot be told, a list of names is
never whole, and every rule that guesses is one way of writing behind. This
engine is not a URL redaction library and is not going to become one.

## What is done instead

Free text is not kept, and no address or part of one. There is no fallback
that keeps either.

Kept are values with a form that can be checked, each checked where it is
collected and again where the result is built:

- of a console error or an uncaught exception: its kind, its step and how
  often it happened;
- of a failed request: step, status, the browser's kind of request, whether
  it was answered, and a count;
- of a step: a known action, and the kind of locator;
- of a compared value: the value, only if it is a plain number or amount;
- pictures after each step, with secret fields covered;
- **an endpoint's name**, for a request, a console error's file or a step's
  path, only when the path is exactly one that the operator's trusted list
  (`evidenceRoutes` in the target manifest) gives an id to. Otherwise
  `Endpoint not recorded`.

`packages/agent/src/execute/kept.ts` holds the two forms (an endpoint name,
a plain amount); `docs/remote-result-format.md` has the rules and limits.

A remote run records no browser trace and takes no uncovered picture at a
comparison. `filesThatMayLeave` names the only files that may leave a run's
directory.

The pull-request path is unchanged.

## What this costs

A report of a remote run can say that an error or a failed request happened,
in which step, how often, with what status and of what kind. It names the
endpoint only if the operator listed it. It cannot say what an error said or
which address failed otherwise. It can show a compared value that is a
number, and says `not shown` for one that is words.

## Residual risks

- **Pictures.** Covering asks the page where its secret fields are. A page
  that answers falsely leaves a field uncovered. Not safe against a hostile
  page. Anything a page shows as text is in the picture.
- **A compared value that is a number** is kept, whatever the number means:
  a balance and a one-time code look the same.
- **The run's working record** on the machine is uncleaned. Hosted execution
  is blocked until its retention and access are controlled (KAN-16).

## Richer diagnostics, later

What an error said is the most useful thing left out. Bringing any of it
back is a feature of its own, to be designed for security first and
reviewed independently before it is built. Starting points, none begun:

0. Route patterns in the trusted list (`/users/:id`), which static paths do
   not cover, with a rule for what a pattern may match.
1. An allow-list of message shapes the browser itself writes ("Failed to
   load resource: the server responded with a status of N"), matched whole.
2. The error's class name alone (`TypeError`), from a fixed list.
3. Text shown only to the person who owns the application, never stored
   with the result, from a store with its own access rule and retention.
4. A stated policy on personal data, which no rule about credentials covers.
