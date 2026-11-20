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
