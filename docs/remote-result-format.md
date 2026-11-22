# The result of a remote run (`result.json`)

`run-remote` writes two files into its output directory:

- `result.json`: what the run found. This is the file a control plane reads.
- `remote-run.json`: the working behind it (the checked analysis and plan,
  every scenario's full result). Nothing needs it to read the result.

The engine is the only author of `result.json`, and the only place a
run-level verdict is stated. A reader shows what the file says. It does not
work out a verdict, a requirement status or a step outcome from anything else
in it, and it does not treat a captured file as proof of anything.

## Format

The file follows the result contract's **format version 1**: `formatVersion`,
`runId` and `verdict` are where that version puts them. Everything else is
additional and versioned on its own by `producer.resultSchema` (now `1`).
Adding a field needs no new version; changing what a field means does.

| Field | Meaning |
| --- | --- |
| `formatVersion` | `1`. |
| `runId`, `workspaceId`, `projectId` | The run, as the approved request named it. |
| `verdict` | The engine's verdict on the run: `passed`, `failed`, `errored`, `blocked` or `unverified`. |
| `verdictsTrusted` | Whether `passed` and `verified` in this file are statements about the approved requirements. **`false` for every run for now.** |
| `verdictBasis` | `observed`: what the comparisons alone give by the same rule. `reason`. `notTrustedBecause`: set when `verdict` differs from `observed`. |
| `executionStatus` | `completed`, `ended early` or `nothing executed`. How far the run got. A separate fact from the verdict. |
| `endedEarly.reason` | Present when the run stopped before doing everything planned. |
| `producer` | `{ name, resultSchema, kind: "remote-run", executionMode }`. |
| `target`, `snapshots` | Where the run went, and the approved criteria snapshots it used, each with its hash and approver. |
| `coverage` | Requirements by status, `observedOnly`, and scenarios planned, executed and not executed. |
| `requirements[]` | `{ id, status, observedStatus, text, reason, expected, observed, source, stepIds }`. |
| `steps[]` | `{ id, scenarioId, action, target, outcome, requirementIds, note, screenshot? }`. `outcome` is `ok`, `mismatch` or `error`. |
| `profiles[]` | The browser the run used. Empty when nothing was executed. |
| `telemetry` | For each kind of evidence, `collected` or `not collected`. |
| `diagnostics` | `console`, `network`, `analytics`: empty lists until the engine collects them, with `telemetry` saying so. |
| `evidence[]` | `{ id, label, mediaType, path, scenarioId }`: files the run wrote, by a path inside the output directory. |
| `extensions` | For fields a later engine adds before they are part of this schema. |

## Observed and verified

Two different facts are kept apart:

- **Observed**: what a comparison that was made showed. "This element showed
  160" is an observation.
- **Verified**: that an approved requirement holds. That needs the expected
  value and the element read to be the ones the approved text means.

While `verdictsTrusted` is `false`:

- `verdict` is never `passed`. Where every planned scenario ran and every
  comparison matched, `verdict` is `unverified` and `verdictBasis.observed` is
  `passed`.
- No requirement has the status `verified`. Where its comparisons all
  matched, `status` is `unverified`, `observedStatus` is `verified`, and the
  reason begins "Observed, not verified."
- A mismatch (`failed`), an application error (`errored`) and a blocked run
  are reported as they are.

A reader must not show a result with `verdictsTrusted: false` as "Passed" or
"Ready for release", whatever else the file holds. Showing `verdict` as it is
already satisfies this.

## The run-level verdict

First match wins: `failed`, `errored`, `blocked`, `unverified`, `passed`.

`passed` needs all of: every planned scenario ran; none is blocked in the
plan; the run did not end early; there is at least one approved requirement;
every approved requirement was compared and matched; and `verdictsTrusted`.
Anything short of that is `unverified`. Unknown, incomplete or unsupported
evidence never becomes a pass.

## What is not in it yet

Marked `not collected` in `telemetry`, and absent rather than empty-as-clean:
screenshots at steps other than comparisons, a screen recording, console
messages, failed network requests, analytics events and Core Web Vitals. The
times of steps are not recorded. Browser and device profiles other than the
one used are not listed. Each is an added field when it comes, not a new
format.

## The pull-request path

Unchanged. Its run report and each scenario's `result.json` keep their
fields; a test pins the scenario result's field names.
