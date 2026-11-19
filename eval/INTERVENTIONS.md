# Intervention log

Every change to the engine (`packages/agent`) made in response to something
observed while testing a demonstration app, and every manual step a run
needed. The rule: a change is acceptable only if it is generic. Anything that
would only help one app is a generalisation failure and is recorded as such.

| # | Date | Trigger | Change | Generic? |
|---|---|---|---|---|
| 1 | 2026-11-17 | App A, replay: `click` returned before a client-side navigation finished | Wait for network idle after actions; element lookup retries for up to 3 s | Yes |
| 2 | 2026-11-17 | Audit after the app-agnostic requirement | Test-data request bodies moved from engine convention to each app's manifest | Yes |
| 3 | 2026-11-17 | Same audit | Two example strings in tool descriptions replaced with neutral ones | Yes |
| 4 | 2026-11-17 | App A, model-driven round 1: both drivers reported action results showing the previous page | After network idle, also require URL and accessibility tree to read the same twice | Yes |
| 5 | 2026-11-17 | App A, rounds 1–2: drivers tried `by=role` on unnamed text containers and got 0 matches | Tool descriptions now say how `by=text` selects and that `by=role` needs an accessible name | Yes |
| 6 | 2026-11-17 | Test objective needed the sandbox card number | Manifest gained `integrations` (mode and notes), passed to the driver as environment facts; the card number left the scenario | Yes |

Changes made between App A and App B: none after #5 and #6, which were made
before App B's first run. App B's first model-driven runs used the engine
unchanged.

Manual interventions during model-driven runs: none. No run was steered,
retried or edited.

Generalisation failures (a change that only one app needed): none so far.

Known gaps seen but not yet changed:
- Replay breaks when a locator contains an identifier the app generated (App B
  numbers its requests). It holds against a freshly started instance and is
  reported as unverified otherwise. The planned fallback to the model loop on
  divergence is not built.
- App B's scenario used 36–37 of the 40-call budget. Longer scenarios will need
  a larger budget or fewer confirm-by-reload steps.
- Date inputs carry no format hint in the accessibility tree; drivers guessed
  ISO format correctly. A driver that guessed wrong would get an app error and
  could recover, but this is untested.
- The accessibility tree shows a filled password field's value. Test accounts
  are synthetic, but real secrets must never be typed through this tool layer.

## Requirements pipeline (18 November 2026)

Development on the two existing tickets, before the freeze:

| # | Trigger | Change | Generic? |
|---|---|---|---|
| 7 | Dev run, shop: the planner left a documented rule untested because one detail around it was open | Added bound assertions (`number_at_least`, `number_at_most`) and guidance to assert the part that is stated | Yes |
| 8 | Dev run, shop: the planner dropped blocked scenarios to stay under the limit | Blocked scenarios no longer count towards the plan limit | Yes |
| 9 | Dev run, shop: the planner did not know an endpoint the docs describe | The planner is given the documentation as well as the analysis | Yes |
| 10 | Dev run, shop: a scenario needed the number of rows and nothing could count | Targets can count matching elements or array entries | Yes |
| 11 | Dev run, shop: read-only discovery cannot see screens that only appear after an action | The planner is told the map is partial and that absence from it is not a reason to block | Yes |
| 12 | Dev run, both apps: drivers were unsure whether a typed secret had been substituted | Instructions say pages show the placeholder where the value was typed | Yes |
| 13 | Dev run, time-off: trimming blocked scenarios triggered a needless plan repair that dropped a real question | Size trimming is recorded but no longer treated as a fault | Yes |

**Freeze: commit `b5a0702`.** Held-out runs used this commit unchanged.

After the freeze:

| # | Trigger | Change | Generic? |
|---|---|---|---|
| 14 | Held-out, time-off: assertions about an accessible name were compared with visible text (2 false-positive scenarios) | Targets can read the accessible name | Yes |
| 15 | Held-out, time-off: date-relative scenarios had no source for today's date (2 blocked scenarios, 1 missed defect) | Briefing includes the application server's date | Yes |

Generalisation failures (a change only one app needed): none. Both
post-freeze changes are generic, but both were needed because of the second
app's feature, so the frozen engine did not fully generalise to it.

Harness incidents, not engine changes: two workers once overwrote each
other's helper script in a shared folder and drove each other's sessions
(fixed by giving each worker its own folder; the bridge now also ends a
session whose driver goes silent). One worker's tool call was refused by
its own permission check during a retest; that scenario was left unverified.

Still open: substring matching in text locators; replay against
app-generated identifiers and value-bearing locators; no fallback in
discovery for screens behind a state change; replay "confirmation" does not
distinguish a defect from a consistently wrong comparison.

## CI integration (18 November 2026)

- Workflow fixes needed after the merge to `main`: none.
- Human interventions in the three CI runs: none.
- Engine changes made for CI, all generic: run budgets; API driver timeouts,
  retries and accounting; a recorded driver; manifest `start` section;
  refusing document paths outside the application directory.
- Recording corrected before use: two time-off scenarios replaced with their
  post-fix re-runs, three date-relative ones removed.

## Live runs in CI (18–19 November 2026)

- Engine or workflow changes needed to make the live API path work: none.
  The first request to the live API was accepted as written.
- Human interventions in the two live runs: none.
- One run intended to be live used recorded responses because the API key
  secret was not yet present; it was reported as such and not retried until
  the secret was added.
- Fixture added for the defect-detection run: branch
  `claude/defect-timeoff-cancel` (pull request #5), the time-off feature
  with its fix reverted. Not to be merged.
