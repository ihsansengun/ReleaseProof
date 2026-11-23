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
   criteria text (`checkProblems`): a write with no before-and-after witness
   (the observation's own element is no witness); writes that all come
   before the first condition; an observation whose last sight before the
   journey's first write is missing or already shows the final value; a
   `fill` or an `act` that does not follow an `open` of its own page; a
   locator that contains its expected value in any of its spellings; a value
   its unit cannot spell. A refused binding sends nothing to the
   application.
2. Applies the setup. A fixture is called from outside any browser context,
   with a key made from the run id and the binding's hash.
3. Opens a browser context with nothing stored, in the binding's language
   and time zone, and carries out the steps in sequence and nothing else.
4. Makes the final readings, each on a page it has just opened: the first at
   once, the last not before the approved settling time has passed since the
   last write (with no write, since the first step), the others between. If
   the journey itself took longer than that time, they follow one another.
5. Before a contradiction counts as a failure, makes one more reading and
   holds it: read, and read again on the same page once the whole approved
   time has passed there. A page that shows a placeholder first and its
   value later shows itself here.

The outcome is one of:

| Outcome | When |
| --- | --- |
| `verified` | Everything done under the rules, nothing wrong anywhere, and from some final reading on, through the last, the expected value, at least twice. |
| `failed` | Everything done under the rules, nothing wrong anywhere, no request of the page blocked by the engine, and every final reading, the held one at its start and its end included, the same value, which is not the expected one. |
| `unverified` | Everything else, with one reason from a fixed list (`UNVERIFIED_REASONS`). A condition that is not met is a precondition unmet, never a failure. |

## Where facts about a page come from

Not from script the page can replace.

- **Addresses and requests:** the browser's own events. Every request to the
  target that is not a GET or a HEAD is a write: counted for the `act` under
  way, something gone wrong if there is none, passed over only if the binding
  lists it as background.
- **Elements and their text:** one node, asked in an isolated world of the
  engine's own making. A page that replaces `getComputedStyle`,
  `getBoundingClientRect` or `innerText` changes nothing there (tested).
  The node is the one the locator found, and every question and the text
  itself are asked of that same node.
- **What lies on top:** the browser's own hit test through its debugging
  interface, at the centre of the element and at the centre and both ends of
  every box of its text. It counts what is drawn there even if it takes no
  clicks, and a node of another document (a frame laid over the element) is
  never taken for the element (tested).

## What "displayed" means for a reading

More than the design's four conditions, because the first review showed a
number can satisfy those and not be legible. A reading is unverified unless:
the element and every ancestor, in the tree as drawn (slots included), has
no filter, mask or clip path and a combined opacity of at least 0.9; every
piece of text in it has a colour that is not transparent, is at least six
pixels high, lies wholly in the viewport, has no override of its reading
direction and no generated text (`::before`, `::after`) beside it; and
nothing lies over any of it. The value is then read twice, a moment apart,
and must be the same.

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

- **Text the same colour as what is behind it** (white on white) is not
  detected. Neither is text drawn by an image or by a font that draws other
  shapes than its characters. A picture compared with the text read would
  close this; the runner keeps no pictures yet.
- **How long a page takes to draw its value is covered by the approved
  settling time and by nothing else.** A page that shows a placeholder for
  longer than that time, and the real value afterwards, would be read as the
  placeholder throughout, and a check could end `failed`. The settling time
  an approver gives must cover the page's own drawing, not only the server.
  The engine's own quiet rule (no request in flight for 300 ms, and the same
  text twice) is not a statement about the application.
- **Requests a page sends as it is left are shown to nobody by the browser.**
  The engine switches a page's script off before closing it, so none is sent
  from a page the engine closes (tested). A page that leaves by its own
  navigation during an `act` can still send one unseen: the witness rules
  are what stands against that.
- **Shared workers** are taken away from pages (their requests are not seen
  either). An application that needs one cannot be checked.
- **A page that needs another host** (a script or data from elsewhere) is
  kept from it. Such a check can end `verified` if the value is shown all
  the same, and never `failed`: its reason is `other-host-blocked`.
- A value the check typed that the application keeps in the browser without
  a write, and shows on a freshly opened page, would be read as the
  application's. It is an open question for the owner whether a `fill` may
  type a text that contains an expected value at all.
- What an application does through a GET or a socket is not seen as a write
  (residual risk 11 of the design). A socket that fails is not counted as
  something gone wrong.
- Writes before the first condition (such as signing in) are not witnessed.
  A check must also have a write after it, and the observation is compared
  with its last sight before that write, so what is read at the end is
  attributed to the journey after the starting state.
- Choices the design leaves open, fixed in the code: a viewport of 1280 by
  720; half a second between two tries of a condition after a write, which
  is also tried again while its element is missing or not yet a number; a
  minus sign only at the very start of a number; exactly two decimals for an
  amount in units.
- The engine's own limits (`CHECK_LIMITS`) only ever end a check as
  unverified. A check is given up five seconds past its limit even if a page
  keeps the browser busy.
- The tests that hold the runner unused read source text. They list what the
  runner exports and look for those names everywhere code lives; they are
  not a proof.
- For an amount, the currency sign or code is not compared.
