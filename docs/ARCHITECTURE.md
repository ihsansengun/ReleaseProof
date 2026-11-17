# ReleaseProof AI — architecture and four-week plan (v2)

v2 incorporates the clarification that ReleaseProof must be application-agnostic: the engine may know nothing about any demonstration app, and the prototype must test at least two substantially different features in different domains with the same agent code.

## The thread we are building

**Jira ticket + GitHub PR → understand requirements and the application → discover what can be tested → traceable scenarios with expected outcomes → autonomous browser and API execution → evidence-backed PR report → retest after a fix.**

One Node CLI running inside the GitHub Actions job. No server, no database, no agent framework.

## What "application-agnostic" can honestly mean in four weeks

The engine is generic. Each application still has to be *onboarded* with a small manifest and a few testability seams. That is the realistic boundary, and we should claim exactly this:

| In scope | Out of scope for the prototype |
|---|---|
| Web apps whose UI is reachable through roles, labels, text or test ids | Canvas-only UIs, native apps, heavy drag-and-drop |
| Form login with test accounts declared in the manifest | SSO, MFA, CAPTCHA |
| Test data created through declared endpoints, seed commands, or the UI itself | Self-provisioned environments, production data |
| Integrations that are simulated or sandboxed and declared as such | Real third-party systems |
| One environment: the PR's own commit, started in the CI runner | Preview, staging and production tiers |
| Jira text and comments, PR diff, repo docs, OpenAPI file if present | Figma (stretch: image attachments on the ticket, read by the model) |

Anything outside the boundary is reported as blocked with the reason, never as passed.

## Where application knowledge is allowed to live

| Source | Supplies |
|---|---|
| Jira ticket and comments, repo docs | What correct behaviour is. The only source of expected values. |
| PR diff and changed files | Where to look and which risks to probe. Never expected values. |
| `releaseproof.yml` in the app's directory | How to start it, base URL, version endpoint, test accounts, fixtures, declared integrations |
| Discovery run against the live app | Pages, elements, forms and API endpoints that actually exist |
| Agent source | Nothing. A unit test fails the build if demo-app vocabulary, routes or selectors appear in `packages/agent/src`. |

## The hardest problems and the strategy for each

1. **The oracle.** A model that derives expected values from the code confirms the bug; one that fills gaps invents business rules.
   - Every assertion is fixed in the plan before execution and cites a requirement. Expected values are literals or formulas over named observations, evaluated in code.
   - A scenario needing an unstated rule is not run. It becomes an ambiguity, posted as a question, and is marked blocked. Answers in Jira comments are read on the next run.

2. **Generalisation.** A design that works on one app can hide coupling in prompts, tool shapes, fixture conventions and assertion types.
   - Build the second app in week 1, not week 4, so coupling shows up while it is cheap to remove.
   - Make the second app differ in domain, rendering model and interaction style (see below).
   - Freeze the agent before the held-out features. Every agent change needed afterwards is logged as a generalisation failure and must be a generic change.

3. **Planning tests for an application the agent has never seen.** A plan written from the ticket alone names things that may not exist.
   - A read-only discovery pass runs first: a bounded crawl with the same browser tools, plus the OpenAPI file and manifest, producing an app map (pages, forms, controls, endpoints, fixtures).
   - The planner sees the app map, so each scenario is either groundable or explicitly blocked on a missing capability.

4. **Reliable execution and honest verdicts.**
   - A bounded tool loop over a thin Playwright layer. Each action returns the page's accessibility tree.
   - `check` reads the actual value and compares it in code. The model cannot change an expectation, re-check an assertion, or declare a pass.
   - Verdict is computed: any mismatch → failed; all matched → passed; otherwise blocked or unverified.

5. **Agent mistake versus application defect.**
   - Every tool call is recorded. A failure is replayed without the model; only a reproduced failure becomes a defect.
   - Each check stores a screenshot with the compared element outlined, plus the Playwright trace.

6. **Retest that means something.** On a new commit, recorded steps are replayed deterministically with the same fixture identities; a diverged replay falls back to the agent loop.

## Architecture

```
GitHub PR event
  └─ workflow: find the app the PR touches → start it from its manifest → run agent CLI
       1 ingest     Jira ticket + comments (key from PR title/branch); PR diff; repo docs
       2 probe      version == PR head SHA, login works, fixtures respond
       3 discover   bounded read-only crawl + OpenAPI → app map
       4 analyse    requirements (documented | inferred, with quoted source) + ambiguities
       5 plan       scenarios → requirement ids, fixtures, fixed assertions, runnable | blocked
       6 execute    per scenario: fixtures → tool loop → computed verdict → evidence
       7 confirm    replay failures without the model; draft defect reports from evidence
       8 report     run.json, HTML report + traces (artifact), PR comment, Check run
```

Steps 3 and 6 are agent loops over the same tools. Steps 4, 5 and the defect write-up are single structured model calls. Everything else is plain code.

### Extension points (all generic)

- **Browser tools**: `navigate`, `click`, `fill`, `select`, `observe`, `check`, `finish`
- **API tool**: `api_request`, sharing the browser session; targets address JSON by path
- **Assertion kinds**: number equals, text equals, text contains; to add in week 1: exists / absent, count, HTTP status
- **Manifest** per app: start commands, base URL, version endpoint, accounts by role, fixtures as request templates, declared integrations (`real | simulated | unavailable`)
- **Adapters**: ticket source (Jira first) and code host (GitHub first) behind two small interfaces. No third implementation until needed.

### Data model (zod, stored in `run.json`)

`Requirement`, `Ambiguity`, `AppMap`, `Scenario`, `Assertion`, `EnvironmentReport`, `ScenarioResult`, `Defect`, `Run`. `Scenario`, `Assertion`, `Manifest`, `Step` and `ScenarioResult` exist in `packages/agent/src/schema.ts`; the rest arrive with the stage that produces them.

### Repository layout

```
apps/shop/        demo app A: retail, server-rendered Next.js      + releaseproof.yml
apps/<second>/    demo app B: different domain and rendering model + releaseproof.yml
packages/agent/   the engine; no knowledge of either app
eval/             tickets, scenarios, recorded steps, scoring harness
.github/workflows/releaseproof.yml
```

## The two demonstration applications

| | App A (built) | App B (week 1) |
|---|---|---|
| Domain | Retail | HR: time-off requests |
| Rendering | Server-rendered pages, form posts | Client-rendered single-page app over a JSON API |
| Interaction style | Linear purchase flow, numeric totals | Two roles, approval state machine, date ranges |
| Development feature | Loyalty points | Manager approval deducts from leave balance |
| Held-out feature | Discount codes | Overlapping-request validation |

Four features across two domains: two used while building, two never seen by the agent's author-time prompts and run with the agent frozen.

## Four-week plan

| Week | Outcome | Exit test |
|---|---|---|
| **1** · 30 Nov–6 Dec | Executor proven on both apps. Build app B and its manifest, add missing assertion kinds and `select`, one hand-written scenario per app, run the agent loop on both. | Each scenario gives the correct verdict on clean and seeded-bug builds in at least 9 of 10 runs, with no app-specific line in the agent. |
| **2** · 7–13 Dec | Ingest, probe, discover, analyse, plan. Jira and GitHub adapters, discovery crawl, app map, requirement analysis, scenario generation. | From ticket + PR alone, for one feature in each app: at least one seeded defect found and one real ambiguity raised. |
| **3** · 14–20 Dec | GitHub Actions, PR comment and Check, HTML report, failure confirmation and defect write-up, retest by replay. | On a real PR in each app: open → findings → push fix → retest shows the defect resolved. |
| **4** · 21–31 Dec | Agent frozen. Held-out features, eval harness, budgets, secret redaction, recorded demo. Feature freeze 24 Dec. | Metrics table from repeated runs; both held-out features run with zero agent changes, or the changes are listed. |

**Cost of the clarification:** about three to four days for the second app, discovery and the generic manifest. Paid for by dropping accessibility and mobile checks, Jira defect creation and any dashboard beyond the static report. Posting clarification questions back to Jira moves to stretch; they always appear in the PR comment.

**Biggest schedule risk:** week 2. Discovery plus planning on two apps is the densest week. If it slips, discovery shrinks to "visit the pages the diff touches" before anything else is cut.

## Proving autonomy and generalisation

- **Two domains, one engine**: the same commit of `packages/agent` produces every result in the demo.
- **Held-out features**: one per app, run after the agent freeze.
- **Ticket mutation**: change a number in the ticket; plan and expected values change with no code edit.
- **Unknown defect**: someone else injects a bug.
- **Tripwire test**: demo-app vocabulary, routes and selectors are forbidden in agent source.
- **Measured**: per app and per feature — detection rate, false positives, requirement coverage, run time, human interventions, over repeated runs.
- **Full decision log**: every tool call, check and trace is in the report.

## Status

Built and verified by execution:
- App A, with fixtures and a version endpoint
- Tool layer, recording and replay, verdict computation, formula evaluator, SHA guard
- Replay of a hand-written scenario: passed on the clean build, failed on a locally seeded bug (expected 136, got 236), blocked on a commit mismatch

Built but not yet run: the agent loop (`execute/loop.ts`). It typechecks; no model credential was available where it was written.
