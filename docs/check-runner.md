# The check runner (trusted checks, stage 4)

`packages/agent/src/remote/check.ts` carries out one approved check
("binding") by itself and says how it ended. The design is
[design/TRUSTED-BINDING.md](design/TRUSTED-BINDING.md); this page says what
of it exists, and what does not.

**No run uses it.** Nothing calls `carryOutCheck` when a run starts, is
carried out or is reported. A remote run reports `verdictsTrusted: false`
exactly as before, and two tests hold that: no other source file refers to
the runner, and no source file writes a trusted result.

## What it does

Given a browser, the target's address, a run id and a binding:

1. Refuses the binding if it breaks a rule that can be told without the
   criteria text (`checkProblems`): a write with no before-and-after witness;
   an observation not seen, with another value, before the first write of
   the journey; a `fill` or an `act` that does not follow an `open` of its
   own page; a locator that contains its expected value; a value its unit
   cannot spell. A refused binding sends nothing to the application.
2. Applies the setup. A fixture is called from outside any browser context,
   with a key made from the run id and the binding's hash.
3. Opens a browser context with nothing stored, in the binding's language
   and time zone, and carries out the steps in sequence and nothing else.
4. Makes the final readings, spread over the approved settling time, each on
   a page it has just opened.

The outcome is one of:

| Outcome | When |
| --- | --- |
| `verified` | Everything done under the rules, nothing wrong anywhere, and from some final reading on, through the last, the expected value, at least twice. |
| `failed` | Everything done under the rules, nothing wrong anywhere, and every final reading, from the first to the last after the whole approved time, the same value, which is not the expected one. |
| `unverified` | Everything else, with one reason from a fixed list (`UNVERIFIED_REASONS`). A condition that is not met is a precondition unmet, never a failure. |

## Where facts about a page come from

Not from script the page can replace.

- **Addresses and requests:** the browser's own events. Every request to the
  target that is not a GET or a HEAD is a write: counted for the `act` under
  way, something gone wrong if there is none, passed over only if the binding
  lists it as background.
- **Elements and their text:** the browser's isolated world, through a
  selector engine registered as a content script and the browser library's
  own text reader. A page that replaces `getComputedStyle`,
  `getBoundingClientRect` or `innerText` changes nothing there (tested).
- **What lies on top of an element:** the browser's own hit test through its
  debugging interface, which counts what is drawn there even if it takes no
  clicks (tested).

## What it does not do yet

- **The rules that need the criteria text**: that the quote lies on whole
  lines, that the expected value is the number written at its position, that
  the quote holds no bound or negation. Until they exist, an outcome says
  what the application showed against the value in the binding, and nothing
  about the criteria. They come in the next pull request of this stage,
  before anything is wired into a run.
- **Being part of a run.** Checks are not yet carried out before a plan's
  steps, and nothing is written to a run's working record.
- **Pictures.** The runner keeps none.

## Limits to know about

- A number is read from the element's rendered text. Text drawn by a style
  sheet (`::before`), by an image or by a font that draws other shapes than
  its characters is not what is read.
- A value the check typed that the application keeps in the browser without
  a write, and shows on a freshly opened page, would be read as the
  application's. The witness rules make that hard to use, and it is not
  ruled out. It is an open question for the owner whether a `fill` may type
  a text that contains an expected value at all.
- What an application does through a GET or a socket is not seen as a write
  (residual risk 11 of the design).
- The engine's own limits (`CHECK_LIMITS`: ten seconds for one action of the
  browser, ten for a page to come to rest) only ever end a check as
  unverified. The time a `failed` rests on is the binding's approved
  settling time and nothing else.
- For an amount, the currency sign or code is not compared.
