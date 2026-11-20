# Reliability backlog

Things that make a result less trustworthy or less clear without being a
security boundary. Security items are in
[SECURITY-BACKLOG.md](SECURITY-BACKLOG.md); where an item is tracked there
too, the number is given. Evidence for each item is linked.

| # | Item | What was seen | Why it matters | Status |
|---|---|---|---|---|
| R1 | **Deterministic precedence for authorised Jira requirement amendments** | In the KAN-4 run the description said $50.00 and the owner's later comment said $60.00. Both are authoritative. The model used $60.00 because its instructions say to follow the later statement ([record](../eval/results/2026-11-19-kan-4-live/README.md)) | Nothing in code stops a model from quoting the outdated sentence and testing against it; the plan validator would accept the assertion | **Implemented.** A requirement owner's `Supersedes: "…"` line retires the old rule in code; a supersession proposed by the model is checked and keeps the result "Incomplete" until the owner confirms; retired text cannot back an expected value; contradicting approved requirements block instead of being settled by date. See [design/REQUIREMENT-AUTHORITY.md](design/REQUIREMENT-AUTHORITY.md), "Deterministic precedence". Not yet exercised with a live model. Remaining: a description edited after a comment is not detected |
| R2 | **Accurate requirement-to-assertion coverage mapping** | In the KAN-4 run "The TAKE15 minimum subtotal is $60.00" was reported as not planned although two scenarios exercised exactly that rule; no assertion named that requirement. In the same run and in the shop defect run, one defect (rounding) was reported under many requirements it does not break: 10 and 16 failed requirements for three defects | Coverage is understated in one direction and failure counts are overstated in the other. A reader cannot tell how many rules are really untested or really broken | **Implemented.** An assertion may list further approved requirements it verifies (`alsoVerifies`); they are credited when it matches and left "unverified", not "failed", when it does not. A requirement a scenario lists but no comparison is tied to is reported as "exercised", separately from "verified" and "not planned". Failed comparisons are grouped into patterns (same numeric difference across the run; other failures with their scenario), and the report leads with the pattern count. A pattern is a guide to distinct causes, not a defect count. Not yet exercised with a live model |
| R3 | **False-positive assertions and locator investigation** | Three runs each had one questionable assertion: a count of "Cancel" buttons that found none where the application renders one with a longer accessible name ([adversarial run](../eval/results/2026-11-19-security/README.md)); "no indication of the applied promo code" after applying ` save10 ` while the discount was applied ([KAN-4 run](../eval/results/2026-11-19-kan-4-live/README.md)); a points formula that ignored an undocumented bonus ([shop defect run](../eval/results/2026-11-19-shop-defects/README.md)). None has been confirmed from a step record, because the evidence artifact could not be read from the development environment | A false failure costs a developer's time and trust. So far none has produced a false-positive scenario on its own, but only because a real defect was present in the same scenario | Open. First step: read the step records of these three assertions. Known contributing causes: text locators match substrings and typed text rather than displayed text; presence checks on a wrong target cannot be told from a real absence |
| R4 | **Removal of unnecessary Jira personal identifiers from public reports** | The report posted on a public pull request names the requirement owner by display name next to the Jira account id, as the origin of a comment | The account id is what authority rests on and what the audit trail needs. The display name adds nothing and is personal data on a public page | **Implemented.** A source's public description says what its author is to the run ("a listed requirement owner"), not who they are. Display name and account id are kept in a separate field that only the audit trail shows, and the audit trail is no longer uploaded by default |
| R5 | Model-free repeat fails on applications that assign ids at run time | In the adversarial run all three failures ended as "replay diverged". A local run showed the cause: a recorded step names a control by an id the application assigned ("Approve request 14 …") | Failures on such applications rest on one execution | Open. Cause confirmed, fix not started. Security backlog 5 |
| R6 | Set-up depends on Ubuntu's package mirrors | One run failed before testing anything when the mirrors returned 503 | A run can be lost to an outage unrelated to the application | Open. Cache the browser and its packages. Security backlog 8 |
| R7 | A Check belongs to a commit, not a pull request | The KAN-4 run's Check also became the latest Check on another pull request with the same head commit | A reader of the other pull request sees a result for a different ticket | Open. Security backlog 16 |
| R8 | Evidence cannot be read from the development environment | Step records, screenshots and audit trails are in the Actions artifact, whose storage host is not reachable from where results are written up | Several conclusions in the evaluation records are marked "probable" for this reason alone | **Implemented.** Every run writes `diagnostics.md` and `diagnostics.json`: for each scenario that did not pass, each comparison with expected, observed, requirement, source, how the value was located and the screenshot's name, plus the last 12 steps. The same is printed in the job log, redacted (e-mail addresses, credentials, tokens, long opaque values), bounded and prefixed. Screenshots and full step records stay in the evidence artifact. Limit: on a public repository an artifact can be downloaded by any signed-in GitHub user; GitHub offers no narrower setting, so the artifact is not a private store |

## Fixed after the first routing benchmark (19 November 2026)

Found in [benchmark A](../eval/results/2026-11-19-routing-benchmark/README.md).

| Problem seen | What changed |
|---|---|
| A plan used one observation name for two moments; a total was compared with a stale subtotal and reported as a defect | A plan declares every observation with the one moment it is read at. A name cannot be recorded twice, and once a second reading has been attempted no formula that uses the name can be checked: the assertion stays unchecked and the scenario is unverified |
| 2160 was expected and "$21.60" was shown; the comparison failed | Numeric assertions and observations declare a unit. A value shown with a currency sign is converted to the declared unit, and both values are recorded. Where the unit cannot be established, or the two sides differ by exactly a factor of 100 with no unit shown, nothing is compared. A formula may not combine amounts in different units |
| When a scenario was re-run on the escalation model, the first attempt's reason and steps were lost | Whichever attempt is not kept stays on record whole and appears in the diagnostics |
| A scenario passed on a defective build and its steps could not be examined | The redacted diagnostics cover every executed scenario. For a pass: each comparison, how the value was located, and the readings, comparisons and application responses it rests on. The complete redacted step list is in `diagnostics.json` |
| The report ended "Full report, steps and screenshots" although only redacted evidence is published | The closing line says which evidence was stored |

Limits of these fixes:

- The unit of a value from an API response can never be read off the response. Only the factor-of-100 case is caught there.
- Converting assumes a currency with hundredths.
- Whether a passing scenario tested the rule in its title is now checkable by a reader. Code does not judge it.


## Fixed after routing benchmark C (19 November 2026)

Every wrong verdict but one in that benchmark came from how a value was
located on the page, not from the requirements or the plan.

| Problem seen | What changed |
|---|---|
| The section heading "Promo code" was read where the applied code was expected, and reported as a defect | A heading or a label is refused as the place a value is read from: no result is recorded. It is accepted when the plan declares the assertion's `subject` to be a heading or a label, which must then be pointed at one, or when a pattern picks a value out of it |
| A text target for "Total:" also matched "Subtotal:" | Text is matched on whole words. A target that still matches more than one element is reported as ambiguous and nothing is read. A target can name a container (`within`) to pick one row or section |
| A message looked up under a role it does not have was recorded as absent | When a role or label target matches nothing while the same words are shown on the page, presence and absence are both left undecided and no result is recorded |
| A repeat of the same wrong locator was reported as "reproduced" and settled the failure | The model-free repeat is reported as repeatability only. Each mismatch carries what stands behind it: the application's API response, a second comparison of the same requirement through another target, a second attempt that located the value its own way, or one page reading alone |
| A failure resting on one page reading was final once it repeated | Such a failure gets one independent attempt on the escalation model. If that attempt reaches the value another way and it matches, the comparison is set aside as a locator disagreement: the scenario is unverified, never passed. If any other comparison failed, the scenario stays failed |

Limits of these fixes:

- A wrong element that is neither a heading nor a label, such as the wrong
  one of two amounts, is not detected when it is read. It is caught only if a
  second attempt disagrees or another comparison contradicts it.
- "Corroborated" means a second comparison of the same requirement failed
  through a different target. Both could still be wrong.
- A single-observation failure costs one extra attempt on the escalation
  model, within the escalation limit.
- A passing comparison located by the expected value itself is still accepted.
- A value whose only presentation is inside a heading or a label needs a
  pattern; without one it stays unverified.
- Whole-word matching can make an older recording diverge where it relied on
  matching part of a word.

## Evidence and coverage (after routing benchmark C, 19 November 2026)

| Problem seen | What changed |
|---|---|
| What a scenario did had to be pieced together from its last 12 logged steps; who made a cross-user request was not on record | Every comparison stores a record made by code when it is compared: the approved requirement and expected value, the test account whose credentials were last entered (its alias, never a name or secret), the page or the request and response, the observations it was computed from with their moments, the last step that could change state, how the element was identified, and the comparisons made afterwards. The redacted diagnostics print it per comparison and say which of seven parts are missing |
| The planner alone chose which scenarios ran, and a threshold was tested far from its boundary | The planner proposes more candidates than may run and says which requirement each probes and how. Code chooses: each step takes the scenario that adds most to what is already covered (a first comparison of a requirement 3, a new threshold position 2, a new access-control or ownership check 2, a new state change, side effect or risk 1; ties go to the scenario listed first). Scenarios not chosen stay in the plan as deferred, and the report lists them, what each would have added, and threshold positions nobody planned or ran |
| A total was "found" by searching for the expected amount | A target whose text or pattern contains the expected value is refused and nothing is recorded. A test id is exempt, as is a declared heading or label. Presence checks remain available where the plan asks for presence; they count only visible elements and record their scope |
| The failure table grouped unrelated mismatches and read like a defect count | Four separate counts: failed assertions, failed scenarios, failure patterns, evidence-backed defect candidates. A pattern groups failed comparisons that rest on a common requirement or are numbers off by the same amount. It is "evidence-backed" only when one of its comparisons is backed by the API response, a second comparison or a second attempt, and the failure repeats |

Limits:

- The selection trusts the planner's statement of what a scenario probes, as
  far as a comparison of that requirement backs it. Code cannot tell "just
  below the threshold" from "far below" if the planner labels them alike, and
  it cannot notice a threshold the planner never labelled.
- The weights are a fixed policy, not a measurement of risk.
- "Initial" and "final" state are what the scenario read and compared, not a
  snapshot of the application. The actor is the account whose credentials
  were last entered in the browser session; the server's view is not checked.
- A label that happens to contain the expected number ("Step 2" when 2 is
  expected) is refused as circular. The comparison stays unverified unless
  the element can be identified another way.
- An evidence-backed pattern has independent evidence that the application differs
  from the requirement. It is a defect candidate. The report does not confirm
  root causes: the grouping is a heuristic, two candidates may share one
  cause, and one may hide two.
- Planning more candidates than run costs more planner output.

## After the reliability gate (20 November 2026)

The gate failed on three false-positive scenarios
(`eval/results/2026-11-20-reliability-gate/`). Each time an escalated re-run
recorded one mismatch through a wrong target, or at the wrong moment, and
replaced a first attempt that had ended without a verdict.

| Problem seen | What changed |
|---|---|
| An escalated failure replaced an inconclusive result as soon as it repeated when replayed, and a wrong target always repeats | An escalated failure replaces the first result only if it repeats and at least one of its mismatches is backed by more than a single page reading: the API response, a second failed comparison of the same requirement through another target, or the first attempt having failed the same assertion through a different target. Otherwise the first result stands and the escalated attempt stays on record as not kept. An escalated pass still replaces |

Limits and what is still open from the gate:

- A real defect that only the escalated run sees, through one page reading,
  is left without a verdict. The attempt and its mismatch are in the
  diagnostics for a person to judge.
- This removes the wrong failures; it does not make the checks possible. A
  cell whose text equals the expected text still cannot be singled out, and a
  check still reads only the live page, so such scenarios end unverified.
- Not changed here: the model-free repeat diverging when ids are assigned at
  run time. The other causes are addressed in the next section.

## Making the gate's checks possible (20 November 2026)

| Problem seen | What changed |
|---|---|
| A table cell whose text equals the expected text could not be singled out, so it was reached through a neighbouring cell | A target can name a cell by its row and its column (`by: "cell"`): the row by a cell of its own that is not the value sought, an accessible name or a test id; the column by its header, matched whole. One row and one column, or nothing is read. A target can also name the value beside a label (`by: "labelled"`): the item after a term, the cell after a row header, the control of a form label |
| A check could only read the page as it was when the check ran | An observation may hold text as well as a number, and keeps the record of where and when it was read. The plan can make an assertion about an observation (`actual.observation`); code then compares the recorded value, and a check that points at the live page for such an assertion is refused |
| The scenario exactly at a threshold lost to broader ones | Scenarios the planner wrote just below and exactly at a stated threshold are taken first, up to half the limit, best-scoring first. The rest of the limit is filled by coverage as before. Positions that did not run, and positions nobody planned, are listed |
| "Discount (TAKE15):" was refused as circular for an expected 15 | A number inside a word is part of a name, not a number |
| The results table did not render | Its separator row has a cell for every column |

Limits:

- Row-and-column targets need a table with a header row and no merged cells.
  Layouts built from plain blocks, cards or lists of unlabelled values are
  not covered; such a value still needs a test id, a container, or a pattern
  on a labelled line.
- A form label that wraps its control together with other text is not
  resolved by `labelled`; a label attached with `for`, or wrapping only the
  control, is.
- Whether an assertion is about an earlier moment is the planner's call. An
  assertion the plan leaves on the live page is compared with the live page.
- A second attempt to record an observation still marks it as needed at two
  moments, and assertions that use it are then not compared.
- Reserving threshold scenarios takes slots from breadth: up to half the
  limit. A plan with many thresholds runs fewer distinct requirements.
- "Just above the threshold" is not reserved.
- The vocabulary tripwire no longer lists "column": the engine now uses the
  word for the column of a table.

## After the second reliability gate (20 November 2026)

| Problem seen | What changed |
|---|---|
| Two defects with API evidence were shown as unconfirmed because the model-free repeat diverged: the application assigns new identifiers on each run | A pattern is an evidence-backed defect candidate when one of its comparisons rests on the application's API response, or on a second attempt that reached the value another way, whether or not the repeat could be completed. Two page readings in one attempt still need the failure to repeat. A repeat that reaches the comparison and finds it matching contradicts the failure, and nothing is then called evidence-backed |
| The labelled target was refused 13 times: both applications write label and value in one line | `by: "labelled"` also reads a line that begins with the label and a colon ("Subtotal: $60.00", "Balance: 20 days"). Only what follows the colon is the value, so a number inside the label ("Discount (TAKE15): ...") is never read. One such line, or nothing is read |

Limits:

- An evidence-backed candidate is not a confirmed defect or root cause, and
  the report never says so.
- A line whose label is not followed by a colon, and a block of several
  "Label: value" pairs in one element, are not resolved.
- A failure whose repeat diverges is still sent for a second attempt on the
  escalation model even when it already has API evidence. That costs money
  and was left as it is.

## Before the independent evaluation (20 November 2026)

| Problem seen | What changed |
|---|---|
| A ticket about attaching files could not be tested: the executor had no way to choose a file | A tool `upload`: the executor names the control a user clicks to choose files, and the browser's file dialog is given small synthetic files. The executor chooses names and kinds ("text", "image") only; content depends on name and kind alone, so a plan can state it and a model-free repeat sends the same bytes. A control that opens no file dialog is refused |
| The first run on an application built by others made no comparison: the executor opened a form by the address its link carries, the application answered with a piece of HTML meant for a dialog, and the button that submits the form, drawn by the page's scripts, was not there | An HTML answer with no html, head or body element is a part of a page. `navigate` says so and tells the executor to go to the linking page and click; discovery marks such addresses in the application map; the briefing says to open forms and dialogs as a user does |

Limits:

- A part of a page is recognised from the server's answer alone. A whole
  page whose scripts fail for another reason is not detected.
- The token limit counts re-reads of the cached conversation. On an
  application with large pages it ends a run long before the cost limit.
  Left as it is; the limit is a repository variable.
- `fill` returns the page at once. A list that appears a moment after
  typing is seen on the next reading, not in the tool's own answer.
- Pasting from the clipboard and dragging a file onto the page are not
  supported. The planner is told to block scenarios that need either.
- A control that is clicked and opens no file dialog has still been clicked.
- Files are a few dozen bytes. Size limits and large files cannot be tested.

## After the second run on the independent application (20 November 2026)

Found by walking the tickets' journeys with the executor's tools and no
model, on base branches that are not under evaluation.

| Problem seen | What changed |
|---|---|
| A search box with no button could not be submitted; the run compared nothing | A tool `press`: one key (Enter, Escape, Tab, the up and down arrows) in one element. The briefing says to submit such fields with Enter and not to write a search term into an address |
| A second term typed into a field was appended to the first: the page moves the caret when the field takes the focus | `fill` checks what the field holds afterwards. If it is not what was given, the field is emptied and the text typed key by key. If it still differs, the tool says what the field holds |
| A list of suggestions appeared after `fill` had returned, and the previous one was shown for the next term | `fill` waits briefly and lets the page settle before returning it |
| A menu link named by a user name and an icon could not be matched: the icon is a glyph of a private-use font | Such glyphs are left out of page descriptions and do not count when a role's name is matched. A name is still matched in full |
| Four identical links, one per column of a board, could not be told apart | The roles a target or a container may have now include column and row headers, banner, navigation, main, menu items, options and tabs |

Limits:

- Only five keys. No key combinations, no typing of free text through keys.
- The pause after `fill` is 0.4 seconds plus settling, for every field.
- A downloaded picture cannot be compared with what was uploaded.
- A walkthrough of this kind is not yet part of onboarding an application.
  It should be: it costs nothing and found five gaps that two paid runs
  found one at a time.

## After the independent evaluation (20 November 2026)

The evaluation reported neither of its two prepared defects
(`eval/kanboard-evaluation/README.md`). Three gaps decided that.

| Problem seen | What changed |
|---|---|
| A count taken where nothing could be counted came back as 0 and was compared. Five of seven mismatches were false | A count is a reading only where its place is established. With `within`, the container must be one element and must be able to hold things: not missing, not several, not a heading or label, not bare words. A list, table or region found by its role may be empty: zero there is a reading. Without `within`, zero is refused. The record of a count says where it counted and how many elements of that role the place holds |
| A role with an empty name matched only nameless elements, so `row ""` read 0 on any table | An empty name means any name |
| An application error that stopped a scenario was filed as "blocked", like a missing button. The defect one build was chosen for was met twice and not reported | Responses with status 500 or above to a user's action are recorded with actor, action, request and text, and the executor is told at once. `finish` takes a cause; for an error shown on the page with status 200 the executor points at it and code reads it. Such scenarios are repeated without a model. Same steps, same error: the verdict is `errored`, the requirements whose comparisons could not be made are `errored`, and the run is not ready |
| A criterion named four inputs; three ran and matched, the fourth was left out by the scenario limit, and the criterion read as verified | The analysis lists the inputs and values a source names for a requirement, each with the source's words; code keeps only those it finds there. An assertion cites the examples it runs. Selection counts an uncovered example like a first comparison of a requirement. Each example is reported as matched, mismatched, errored, blocked, unverified, deferred or not planned, and a requirement is verified only when every one it names was compared and matched |

Still as before, and checked by tests: a list that is really empty; a
control that is not there (blocked, cause "cannot-operate"); an expected
refusal such as 403; an error to a request the executor wrote itself; an
error seen once; a scenario that ends on a limit.

### Correction to the evaluation's figures

The record of the evaluation says 60 of its 67 comparisons were true
matches. That is too many. In the run on fork pull request #5, three
comparisons ("@example.com", "mary@" and "example.com" each list 0 users)
counted rows through a role with an empty name. That count is 0 whatever
the page shows, so they would have matched on a page full of users. The
page did show "No users found." in the one comparison that read it, so the
application was probably right; the three comparisons did not show it. The
record itself is left as it was written.

Limits:

- A count above zero through a wrong target is still a reading: too many
  (words that also sit in a link elsewhere) or too few. Only zero is guarded.
- "absent" by a text is still judged across the whole page.
- An application error is recognised by status 500 or above, or where the
  executor points at it. An error drawn into a page with status 200 that
  the executor does not report is missed.
- An error counts as the application's when it follows a user's action.
  Whether the action was a sensible one is not judged.
- `errored` is decided on the first attempt and its repeat. An error met
  only by the second, escalated attempt is recorded and decides nothing.
- Examples are what the analysing model lists and code finds in the source.
  An input the model does not list is not tracked. The stated result of an
  example is kept as the model worded it and sets no expected value.
- Nothing here makes a scenario cheaper. A plan that is cut short by the
  token or time limit still leaves examples unrun; they are now named.

### Checked on the application itself (20 November 2026, no model)

After the merge, the engine's own tools were driven by hand-written steps
against the four builds of the evaluation, started locally. Nothing was
paid for and no model took part. `main` at `f261c4b`.

| Check | Build | Result |
|---|---|---|
| Save a task in a project that has a category | defective attachments build | The page shows "Internal Error: SQL Error[HY000]: … table tasks has no column named screenshot". Pointed at through `finish`, it is read and recorded with actor (admin), action (click on "Save") and page. The same steps replayed meet it again: verdict `errored` |
| The same steps | fixed attachments build | The task is created. No error is recorded, and a claim of an application error is refused both without a target and with one |
| Search "%@example.com" in the user list | defective search build | Title "Users (2)" against the expected "Users (0)": mismatch. "Mary Smith" expected absent: present, mismatch. Verdict `failed` |
| The same | fixed search build | "Users (0)", absent: both match. With "mary@" as well: passed |
| Count rows after a search (the three unsound matches) | both search builds | Refused. This application lists users without table rows, so that count was 0 on every page, with or without users |
| Count attachments through the two targets of the false failures | a task with two files | Both refused: one container is a label, the other does not exist |
| Count attachments in the table | the same task | 2 links, 3 rows: match |

What this showed that the tests on small pages did not:

- **This application answers the error with HTTP 200.** Recording by
  status does not see it. It was caught only through the second way, the
  executor pointing at the text. Whether a model does that every time is
  not established here; in the evaluation's run the executor did describe
  the error in its own words.
- The list of users has no table and no rows. An empty result cannot be
  counted there at all; the title and the message are what can be read.
  A plan that asks for a row count on such a page now ends unverified
  where it used to pass for no reason.

Not done: no run with a model. Whether a plan now reaches the wildcard
term within the limits, and whether the executor reports the error
through `finish`, are questions only such a run answers.

### An error written into a page answered with status 200 (20 November 2026)

The check on the application showed that it answers its internal error with
HTTP 200, where recording by status sees nothing.

| Problem seen | What changed |
|---|---|
| An error shown in the page, with a normal status, reaches the record only if the executor reports it | After each user action the tool compares what the page shows with what it showed before. A line that is new and reads like a failure of the application ("Internal Error…", "Fatal error…", "Traceback (most recent call last)", "SQLSTATE[", a line beginning with a name ending in Exception or Error and a colon) is told to the executor in the tool's answer and kept with its step, actor, action and page |

It is a lead and nothing more:

- No verdict, requirement status or readiness rests on it. The report lists
  it under "Possible application errors, not confirmed".
- It becomes a finding only the way any application error does: the
  executor shows where the text is, code reads it, and the same steps
  replayed without a model show it again.
- Not taken as a lead: text that was on the page before the step; text
  inside samples and quotations (pre, code, blockquote and the like) and
  editable fields; a sentence that mentions such words without beginning
  with them; a line that contains words of that kind which the executor
  typed itself.

Limits:

- A list of words. An application that fails in other words is not noticed;
  one that legitimately begins a new line with such words after an action
  is noticed, and the executor has to judge.
- Error text shown only inside a sample element is left out.
