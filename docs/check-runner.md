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

Given a browser, the target's address, a run id, a binding and the text of
the criteria snapshot the binding is for:

0. Refuses the binding if it is not for that text (`criteriaProblems`):
   - the text is another revision than the binding names, or is not
     well-formed text;
   - the quote is not whole lines of it (a line ends at a line feed, or at a
     carriage return a line feed follows), holds no text, or holds
     characters that are not seen;
   - the quote begins or ends in the middle of a sentence that runs over
     several lines, as far as lines can tell: the line before it must end a
     sentence (with a full stop, a question mark or an exclamation mark, not
     after an abbreviation), be empty or be a heading, or the quote must
     begin an item of a list, a heading or a row of a table; the same at
     its end;
   - an expected value taken from the quote is not at exactly one whole
     number, as the engine's own reader of quoted numbers finds numbers, or
     is not the number written there, or has a sign the text does not state
     plainly (a minus read from another mark; a minus, brackets, a trailing
     minus or "CR" with a currency sign or code between it and the digits);
   - the quote holds markup that stands for a character (`&ge;`);
   - the quote words anything but an equality with what is shown: a bound,
     a comparison, a range, an approximation, a symbol such as `<` or `+`;
     a negation, or a sign written as a word; a change, a rate, a share or a
     condition ("increases by", "per", "%", "if", "usually"). The words are
     looked for as the quote reads: in one case, with one space wherever
     there is space or a line break, without marks of emphasis, with every
     kind of apostrophe and of dash as one. The list is the validator's and
     a wider one of the runner's own (`NOT_EQUALITY`);
   - something directly above the quote words any of those: the nearest
     heading above it (a line that begins with `#`, of any level); a line
     that ends with a colon in the block of lines right above it, with no
     empty line between; or, for a row of a table, the rows above it in
     that block;
   - the quote holds letters outside the English alphabet, or with marks on
     them, since those words are known in English only.

   **These wording rules are a second check, not what says a requirement
   is an equality.** No list of words can tell what a sentence means. By
   the owner's decision of 23 November 2026 the next version of the binding
   format carries the comparison as an explicit, signed field, shown to the
   approver in words beside the quote before signing; it starts with exact
   equality only, and anything unsupported, contradictory or ambiguous
   stays unverified. Until that exists, what the quote means rests on this
   list, and that is one more reason nothing here is used by a run.
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
- **Whether a page is still the page the engine opened:** the browser's
  debugging interface tells of a document loaded in the page, of a change of
  address without loading one, and of a document opened anew by script.
  **One document is loaded, the engine's**; a page that loads another,
  itself again included, or opens its document anew, is `address-not-bound`.
  **A page may change its address only through the history interface and
  only to the very address it is bound to**, which frameworks do as they
  start (the owner's decision of 23 November 2026: harmless same-address
  history operations, under strict confinement to the route and origin, and
  nothing broader). To any other address, a query or a fragment or another
  spelling included, even if it comes back afterwards, and by any other
  means (a fragment, going back and forth in the history), it is
  `address-not-bound`. The engine also keeps hold of the document itself, in
  a world of its own, and asks it before every decision whether it is still
  the page's document and at the bound address; and it counts the worlds the
  browser makes for the page's script, since a document put in the page's
  place through a script address is told of in no other way.
- **An action reaches the document the engine looked at, or nothing.** The
  engine does not find the element again when it acts. It types into, and
  presses, the very node it examined, through the browser's hold on that
  node in the engine's own world. No keyboard and no pointer are used, which
  another document could be under by then. The node is asked, before the
  value is set and before and after every event the engine sends it,
  whether it is still connected, in the document it was examined in, and
  that document still shown; if not, nothing more is done, what was typed
  is taken back, and the check ends `address-not-bound`. Whether the field
  holds a secret is asked as it is typed into, not only when it was looked
  at. **What this gives, and what it does not:** the engine does not set a
  fixture's value (a password) on a node that is outside the examined
  document at that moment, and does not go on once the node has left it.
  It does not keep the value from the examined document's own script. That
  script runs at every event of the act, reads the field as any page reads
  its own fields, and can copy the value anywhere it can reach, a frame or
  another page of the same origin included. A fixture's value is therefore
  known to the page it is typed into, and to whatever that page shares it
  with; no rule of the engine changes that. A button a person could not
  press (disabled, in a disabled fieldset, taking no pointer) is not
  pressed, and a field is not given more than its length allows.
- **After typing, and after an act that sends nothing, the page must still
  be the page that was opened.** Neither takes a page anywhere. A page that
  moves in answer to the engine's own act (on focus, on the press) is
  `address-not-bound`, and so is an act that sends nothing and follows a
  link.
- **A write is the page's own by what the browser says of the request**, not
  by which of two events the engine heard first. The browser names, for
  every request, the document it came from and that document's address. A
  counted write must come from the opened document, at the bound address, in
  the main frame, while the page's script still ran in that document's
  world, and the page had been at no other address by then and had not
  opened its document anew. A form that is sent is itself a navigation, and
  the browser names for it the document it loads, **not the one that sent
  it**: it is taken only if it is the first navigation away from the opened
  document and the page has no frame and no other page beside it, since
  either could have sent a form into the main frame. Anything else is
  `write-not-attributed`: a write sent after the page moved, by the page it
  turned into, from a frame, or from a worker (of which the browser does not
  tell on this channel). **What this does not tell apart:** a frame or
  another page of the same origin that calls the opened page's own
  functions (`parent.fetch`, `opener.fetch`) sends a request the browser
  names as the opened document's, and it is counted as the page's. It is
  the opened document's script interface doing the sending, and the engine
  has no means of seeing who called it.
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
applications register such a listener for statistics; today such
applications cannot be checked.

The owner's rule for any later relaxation (23 November 2026): it must not
be a general way to ignore application activity that may matter. It has to
be explicitly approved, narrowly scoped, and fail closed whenever ignoring
the activity could invalidate the check. No such setting exists yet.

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
- **The engine's acts are not a person's.** Typing sets the field's value
  and sends the events typing gives; pressing sends the press, the release
  and the click to the node. The browser marks such events as made by
  script. A page that acts only on events it trusts does not respond; the
  check then ends unverified (`write-not-as-expected`, or a condition not
  met). Nothing here rests on the browser withholding what needs a real
  gesture: in the browser as the engine starts it, a script-made click
  opened a window (tested), which is why an act that sends nothing may not
  leave another page open. This is the price of an act that does not go
  through a keyboard or a pointer that another document could be under.
- **What the engine's acts leave out.** No key is pressed or released
  (`keydown`, `keyup`, `keypress`), nothing is hovered, and no field is
  left (`blur`): a page that waits for one of these does not respond.
  Typing is refused (`step-not-done`) for anything but a text-like `input`
  or a `textarea`: a date, a checkbox, a `select`, an editable element and
  a type the engine does not know are not typed into.
- **What rests on how the browser is started.** That one document is
  loaded rests on the browser telling of every document it puts in the
  page. The engine makes no setting that turns off the browser's cache of
  pages or its blocking of windows; what is written here was observed in
  the browser as the engine starts it. Whether a page prepared ahead by the
  browser (prerendering) could take the place of the opened one without
  being told of was not established, and no test covers it. Before trusted
  verdicts are activated these are to be settled by settings the engine
  makes itself, not by what the browser happens to do.
- **What rests on the browser telling the truth in sequence.** That a form
  sent is the first navigation away from the opened document is known from
  the sequence in which the browser tells of documents and requests on one
  channel. No way was found to get a later document's form counted; it is
  the browser's behaviour, not a promise it makes.
- **Ordinary pages that end `write-not-attributed`:** one whose click sends
  its write from a frame or a worker; one that changes its address first and
  sends afterwards; one that sends a form and has any frame in it (an
  embedded widget, an analytics frame) or another page open beside it.
- **A page that writes a new document over itself as it is parsed**
  (`document.write` before it has loaded) is the document the engine opened.
  A page can draw anything by script in any case; the rules are about where
  the page is and which document acts, not what it draws.
- **Ordinary pages that are `address-not-bound`:** a router that works by
  fragment or adds one on starting; one that adds or removes a trailing
  slash; one that keeps its state in a query; one that restores a scroll
  position with a fragment; any client-side redirect; a page that opens or
  writes its document anew after it has loaded; a page that takes over
  navigations (the Navigation API), where even a same-address history call
  is told of as something else; an act that sends nothing and follows a
  link.
- Choices the design leaves open, fixed in the code: a viewport of 1280 by
  720; half a second between two tries of a condition after a write, which
  is also tried again while its element is missing or not yet a number; a
  minus sign only at the very start of a number; exactly two decimals for an
  amount in units.
- **The quote's language is told only by its letters.** A quote in another
  language that is written with the plain alphabet is not refused, and its
  words for a bound or a negation are not known.
- **A reading in hundredths cannot be bound to a quote that writes the amount
  in units** ("21.60" in the text, 2160 on the page): the expected value is
  the number written in the quote, and it must be one the reading's unit can
  spell.
- **The words that refuse a quote are common ones.** A sentence with "no",
  "not", "never", "over", "under", "about", "around", "some", "within",
  "between", "limit", "empty", "missing", "zero", "by", "per", "each",
  "every", "if", "may", "more", "less" or "from … to" anywhere in it cannot
  be bound, whatever the word is about; nor can one with an accented letter
  in a name, with `>` in it (a block quote, an arrow), or struck through.
- **Common ways of writing criteria cannot be bound.** One requirement to a
  line without full stops, and lines of "Given … When … Then …", are
  refused as the middle of a sentence; so is a line after a bold label or
  after a line that ends with a bracket; so are lists marked with letters
  or bullets other than `-`, `*`, `+` and numbers, and tables written
  without spaces. These are refused because a line break alone does not say
  where a sentence ends.
- **The list is still a list.** A bound or a negation worded in a way that
  is not on it ("no fewer" is, "peaks at" is not) is taken for an
  equality. What the sentence means is the approver's judgement, and the
  approval screen is to show the quote with the lines around it.
- **A sentence that goes on after a full stop** is not seen to go on: "The
  balance is 100. It may be more after a refund." can be bound by its first
  line. Neither is a line that carries on a sentence and happens to begin
  like an item of a list, or what a paragraph further up says about the
  quote.
- **What is above a quote is read only so far.** A line that introduces a
  list and is followed by an empty line, an introducing sentence that ends
  with a full stop, a heading above the nearest one, a heading written by
  underlining or in bold, and rows of a table below the quote are not read.
  A bound stated there is not seen.
- **A whole section can be unbindable.** Under a heading with a listed word
  in it ("Add to cart", "Sort by price", "Limits and balances", "Default
  settings", "Pricing per seat", "About the account"), or with a date or a
  range of versions in it, nothing can be bound. A line of a code block
  that begins with `#` is taken for a heading. A row of a table with a
  listed word in it refuses every row below it.
- **Dates, telephone numbers and the like refuse a quote** (a digit, a
  dash, a digit reads as a range), and so do "min" for minutes, "May" for
  the month and `R&D;`.
- **A number's sign: what is refused though it is harmless**, and what is
  not seen. Refused: a number right after an opening bracket ("(100
  items)"), a number with a dash after it ("100 – always", "a 100-point
  scale"), a number after a dash that is not a plain list marker (a list
  marked with a longer dash, "- $100 off"). Not seen as a sign: a currency
  code that is not three capitals before the number ("-usd 5", "-kr 5",
  "-Rs. 5"), and "5 (CR)".
- **Characters.** The first line of a file that begins with a byte-order
  mark cannot be bound. Neither can a quote with a picture made of several
  joined ones, a flag of a region, or a number in a keycap. Which
  characters count as unassigned depends on the version of Unicode the
  engine's runtime knows.
- A line that ends "… is no." or "…, etc." or with a full stop inside curly
  quotes is not taken to end a sentence.
- A word broken over a line with a hyphen ("at le-" and "ast") is not put
  together again.
- A number that begins a line and is followed by a full stop and a space is
  read as the number of a list item, and cannot be bound.
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
