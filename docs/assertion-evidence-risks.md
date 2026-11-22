# Known false-pass risks in the shared comparison code

Status: **open**. Decided on 22 November 2026: the pull-request (CI) path
stays as it is for now, so that working GitHub testing is not broken by rules
its plans cannot meet. This page says what that leaves unprotected and
proposes a way to close it without breaking existing plans.

**The pull-request path is not fully protected against a comparison that
reads back the executor's own input, or one that reads the wrong element.**
Nothing here should be read as saying otherwise.

## Two modes

| | Pull-request path (plan is the engine's own) | Remote runs (`untrustedPlan`) |
| --- | --- | --- |
| Who plans and acts | The engine's model, checked by code | A recording, or anything not the engine's own |
| Reads its own input back from the field typed into | Refused | Refused |
| Reads a place that mirrors what was typed | **Not refused** | Refused |
| Reads an answer that repeats its request (address, query, body) | **Not refused** | Refused |
| Reads a field the page built anew, or the browser restored after "back" | **Not refused** | Refused |
| Expected value must be stated in the approved text | No: a requirement must be cited, the value is the plan's | Yes |
| A calculation that cancels what it reads | Refused only in its plainest forms | No calculations accepted |
| Which element is read for a requirement | **The plan's choice** | **The recording's choice** |
| Result trusted as a verdict | Yes, as before | No (`verdictsTrusted: false`) |

## The risks, concretely (pull-request path)

1. **Self-echo through a mirror.** The executor types 160 into a field, the
   page shows "You entered 160" elsewhere, and a comparison reads that.
2. **Self-echo through a request.** `GET /search?q=160` answers "Results for
   160", or an error answer repeats the address; a comparison reads it.
3. **Rebuilt or restored field.** A page that replaces the field on each
   keystroke, or a browser going back in history, yields an element the rule
   does not recognise as the one typed into.
4. **Wrong element.** The comparison reads an element that shows the expected
   value for another reason (another total, another user's balance).
5. **Wrong expected value.** The plan expects a number the cited requirement
   does not state.
6. **Self-cancelling calculation.** `before - before + 160`.

What limits them today: the plan and steps come from the engine's own model
under its instructions, not from an adversary; a requirement must be cited
from an authoritative source; a target may not be located by the expected
value; a heading or label is not accepted as a value; mismatches are
re-checked. These lower the chance of an honest mistake. They do not stop a
plan that is wrong.

## Why the remote rule was not simply applied

It was tried, in three forms, each reviewed independently:

- comparing values read with values typed refused ordinary checks (a search
  result containing the search word; a balance of 60 after 60 was typed
  elsewhere) and was passed by spelling the value differently;
- knowing the field by position and name refused another row's field, a saved
  value a page fills in by script, and a dialog around a typed field;
- the strict source rule ("read only from a page just opened by a plain
  address") is sound, and existing plans do not meet it: they read search
  results, views built after a click, and messages shown once.

## Proposal: record first, enforce later

A compatibility-safe way to bring the pull-request path under the same rule.

1. **Record, change nothing.** For every comparison the pull-request path
   makes, compute what the strict rule would have said and write it into the
   comparison's evidence (for example `source: "as served"` or
   `source: "page acted in"`, and whether the expected value is stated in the
   cited text). No verdict changes. The report shows it.
2. **Measure.** Over real runs, count how many passing comparisons would have
   been refused, and of which kind. That says what plans must learn, and
   which legitimate flows (search, views after a click) need a rule of their
   own first.
3. **Teach the planner.** Change the executor's instructions to prefer
   "act, open the page again, read", and give it a way to say why a
   comparison must be read in place.
4. **Warn.** A pass that rests only on comparisons the strict rule would
   refuse is shown as passed with a warning, and counted.
5. **Enforce, behind a setting.** Per repository, off by default, then on by
   default once the measured refusals are near zero.

Element binding (risk 4) needs its own design and is the same work the remote
path needs before `verdictsTrusted` can be true: tie the element read to the
approved text, for example by requiring the approved criteria to name the
label or test id, or by having a person approve the binding once.

Each step is its own small pull request, and steps 1 and 2 touch no verdict.
