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
