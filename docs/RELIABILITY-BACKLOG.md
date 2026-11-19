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
