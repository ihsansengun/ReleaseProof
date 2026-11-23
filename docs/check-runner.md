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
   its unit cannot spell; a `fill` that types a value the check reads
   afterwards (the final value, or a condition that comes after the `fill`),
   in any obvious spelling: with or without sign, grouping or noughts, in
   units or in hundredths, as any run of digits in the text, alone or
   together with what earlier steps typed. A refused binding sends nothing
   to the application. A value typed from a fixture's answer is only known
   when the check runs; there, a number standing by itself in it is
   compared with the final value and every condition, and a digit inside a
   word (a name, a code) is not.
2. Applies the setup. A fixture is called from outside any browser context,
   with a key made from the run id and the binding's hash.
3. Opens a browser context with nothing stored, in the binding's language
   and time zone, and carries out the steps in sequence and nothing else.
4. Makes the final readings, each on a page it has just opened: the first at
   once, the last not before the approved settling time has passed since the
   last write (with no write, since the first step), the others between. If
   the journey itself took longer than that time, they follow one another.
5. Before either verdict, makes one more reading and holds it: read, and
   read again on the same page once the whole approved time has passed
   there. A page that shows a placeholder first and its value later, or a
   value it then corrects, shows itself here.
6. Closes every page with its script switched off (see below).

The outcome is one of:

| Outcome | When |
| --- | --- |
| `verified` | Everything done under the rules, nothing wrong anywhere, from some final reading on, through the last, the expected value, at least twice, and the held reading the expected value at its start and its end. |
| `failed` | Everything done under the rules, nothing wrong anywhere, no request of the page blocked by the engine, and every final reading, the held one at its start and its end included, the same value, which is not the expected one. |
| `unverified` | Everything else, with one reason from a fixed list (`UNVERIFIED_REASONS`). A condition that is not met is a precondition unmet, never a failure. |

Neither verdict is given if a page the engine closed had something
registered to do on being left (`leave-script-suppressed`), or if an answer
of the application sent the browser on to another host
(`redirect-to-other-host`). Both verdicts need the held reading, so the
simplest check takes its journey and twice its settling time.

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
  interface, at the centre of the element and, for a reading, at three
  places across every letter of its text, where it must find the text's own
  element. It counts what is drawn there even if it takes no clicks, and a
  node of another document (a frame laid over the element) is never taken
  for the element (tested).

## What "displayed" means for a reading

More than the design's four conditions, because the reviews showed a number
can satisfy those and not be legible. A reading is unverified unless:

- the element and every ancestor, in the tree as drawn (slots included),
  has no filter, mask, clip path or blend mode and a combined opacity of at
  least 0.9;
- the element holds nothing that draws something of its own beside the
  text: no generated text (`::before`, `::after`), no field, picture or
  marker, and no tree of its own, a closed one included;
- every letter of its text has one box, at least two pixels wide and six
  high, wholly in the viewport, and to the right of the letter before it or
  on a line below: text drawn in another sequence than it is written is not
  what is read;
- the text is drawn near the size it is set in (not scaled below half, nor
  below eight pixels), with no shadow and no reflection that would draw it
  a second time;
- the colour of the text, of its first letter and of its first line is one
  the engine can read the transparency of, and is not transparent;
- nothing overrides the direction the text is read in;
- at three places across every letter, what the browser finds there is
  the text's own element: not something else, inside the element or
  outside it, drawn over the letter.

The value is then read twice, a moment apart, and must be the same. This
refuses some ordinary pages (gradient text, an icon added by a style sheet,
a card with a drop-shadow filter, an ancestor that is slightly transparent,
text in a colour less than nine tenths opaque (a common grey is 87% black),
a value of more than forty letters, a value under a banner fixed to the
bottom of the window): they end unverified, never wrong.

A reading costs about a second and a half (two reads, and the waits for
rest). With a settling time shorter than the journey after the last write,
the final readings follow one another and are not spread. The record's
`finalReadings` holds two more entries than the binding's count whenever
the held reading was made, whether or not a verdict followed: its start and
its end.

## Closing a page

The browser shows nobody what a page sends as it is left, so the engine
switches a page's script off before closing it, and nothing is sent. But
then the page has not done what it meant to do. The engine therefore asks
the browser, of every frame, whether anything is registered for leaving
(`pagehide`, `unload`, `visibilitychange`, `freeze`), and takes a frame it
cannot ask (one the browser keeps apart) as having something; no test
reaches that last rule yet. If so
the check ends `leave-script-suppressed`, whatever it read. Many
applications register such a listener for statistics; until a binding can
say that an application's leave-time script may be ignored (a signed field,
with the format change that adds the drawing time), such applications
cannot be checked.

## Gates before activation

Set by the owner on 23 November 2026. None is met by this code.

1. **Legibility.** The engine knows where text is and what lies over it,
   not what is painted. Text the same colour as what is behind it is not
   detected; neither is text drawn by an image or a font of other shapes;
   neither is anything the text's own element paints over or beside its
   letters (a struck-through line as thick as the text in the colour of the
   page, a stroke wide enough to swallow the letters, an outline drawn
   inwards over them, a shadow copy set on
   the first line, a strip narrower than the gap between two places the
   engine looks at). Trusted Passed for a requirement about what is
   displayed stays off until this is resolved (a picture compared with the
   text read) or the requirement kind is explicitly kept out.
2. **A separate, approved drawing time**, distinct from the settling time
   after a write, in a new version of the signed binding format. Until
   then the held reading uses the settling time. Running out of time alone
   never makes a failure: a failure is the same value at the start and the
   end of the held reading, after every other condition.
3. **The time limit** is enforced by the engine's own timer, not by the
   browser: a check is given up five seconds past its limit, as
   `time-ran-out`, and does nothing more to the application (tested with a
   page that keeps the browser busy for ever).

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
  shapes than its characters. See the first gate above.
- **How long a page takes to draw its value is covered by the approved
  settling time and by nothing else.** A page that shows a placeholder for
  longer than that time and the real value afterwards could end `failed`;
  a page that shows a value for longer than that time and corrects it
  afterwards could end `verified`. See the second gate above.
  The engine's own quiet rule (no request in flight for 300 ms, and the same
  text twice) is not a statement about the application.
- A page that leaves by its own navigation during an `act` can still send a
  request as it goes that nobody sees: the witness rules are what stands
  against that.
- An answer that sends the browser to another host is seen, and stops the
  check, but the request to that host has then been sent. The reason given
  is `redirect-to-other-host`, or `request-failed` when the browser tells
  of the failed request without saying where it had been sent on. Keeping a worker
  from other hosts is a matter for the network it runs in, not for this
  code.
- **A number drawn beside the element** (by a sibling, or by generated text
  of a parent) is not part of what is read: "9" before an element that
  holds "100" is seen as 9100 and read as 100. Which element holds the whole
  value is the approver's choice of locator.
- **The typed-value rule knows numbers written as numbers.** A `fill` of
  `0x64` or `50+50` is not taken for 100, and an application that works
  such a text out and shows the result would have it read as its own. Two
  texts typed in one sequence and put together by the application in
  another are not covered either.
- **The typed-value rule refuses much that is harmless.** Any digit in a
  typed text counts, inside a word too, and an amount counts in units and
  in hundredths: with a final value of 100, a quantity of `1` cannot be
  typed, nor `user1@example.com`; and since the witness after a write is
  often a count of 1, a text with a 1 in it is refused in most checks.
- **A layer over a value that takes its clicks** (a link stretched over a
  whole card) makes the value "not displayed", though a person sees it.
- **A page with a sandboxed frame** ends `page-error` at once. The cause is
  the engine's own: with service workers blocked, the browser library's
  script fails in such a frame.
- **Requests put by for later** (`fetchLater`) are taken away from pages, as
  shared workers are.
- **Shared workers** are taken away from pages (their requests are not seen
  either) and service workers are blocked. An application that needs one
  and quietly does without could be judged on what it then shows.
- **A page that needs another host** (a script or data from elsewhere) is
  kept from it. Such a check can end `verified` if the value is shown all
  the same, and never `failed`: its reason is `other-host-blocked`.
- An error the page catches and only writes to its console is not counted
  as something gone wrong.
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
- Once, on this machine and once on a reviewer's, the browser the tests
  share stopped in the middle of a run; every check after it ended
  `engine-error` or `setup-failed`, none with a verdict. It did not happen
  again and the cause is not known.
- The tests that hold the runner unused read source text. They list what the
  runner exports and look for those names everywhere code lives; they are
  not a proof.
- For an amount, the currency sign or code is not compared.
