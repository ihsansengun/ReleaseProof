# ReleaseProof AI — smallest viable architecture and 4-week plan

## Context

The repo holds only `project_instructions.md`. It describes a 12-capability autonomous QA engineer; the prototype is due 31 Dec 2026, built by one person starting 30 Nov. This plan cuts that to one thread that genuinely works end to end: **Jira ticket + GitHub PR → requirements and ambiguities → traceable scenarios → autonomous Playwright execution → evidence-backed PR report → retest after a fix.**

## Assumptions I am challenging

| Assumption in the instructions | Verdict |
|---|---|
| Postgres/Supabase, separate browser workers, containers | Cut. The agent is a Node CLI running inside the GitHub Actions job. State is one `run.json` plus evidence files. The runner is the isolation. |
| PR preview / staging / production environment intelligence | Cut to one environment: the workflow builds and starts the PR's own commit inside the runner (Next.js + SQLite). The SHA always matches, the backend is complete, and there is no deployment to wait for. A small probe still checks version, auth and fixtures, so the "never verify the wrong commit" rule is real code. |
| The agent discovers an environment's capabilities by itself | Unrealistic. A `releaseproof.yml` manifest in the target repo declares base URL, test login and fixture endpoints; the probe verifies what is declared. |
| Test-data setup is P1 | It is P0. "100 points on first order" cannot be tested without creating a fresh customer and placing an order. Minimal fixtures move to week 1; cleanup is unnecessary because the database is new on every run. |
| "Interprets a previously unseen feature" on arbitrary apps | True only for unseen features on the demo shop. Claim exactly that, and prove it with a held-out second ticket. |
| Duplicate webhooks, failed payments, delayed credits are testable | Only if the demo shop has those seams. Build a fake payment provider and a payment webhook endpoint; anything without a seam is reported as blocked, which is itself a selling point. |
| Figma, API contract testing, Jira defect creation, dashboard | Cut. The "dashboard" is a static HTML report generated per run. Accessibility (axe) and a mobile viewport are week-4 extras, labelled exploratory. |
| A live LLM demo will behave the same each time | It will not. Week 4 measures detection rate over repeated runs, and a recorded run is the backup. |

## The hardest problems, in order, and the strategy for each

1. **The oracle: who decides what "correct" is.** If the model reads the diff and derives expected values from the code, tests confirm the bug. If it fills gaps itself, it invents business rules.
   - Expected values may only cite a requirement (ticket text, comment, doc). Code is used for *where and how* to test and for risk hypotheses, never for expected results.
   - The planner commits every assertion (literal value or formula such as `floor(subtotal * rate)`) before any browser opens. Formulas are evaluated in code, not by the model.
   - A scenario whose expected outcome needs an unstated rule is not run. It is emitted as an ambiguity, posted as a question to Jira and the PR, and marked blocked. Jira comments are re-read on the next run, so a human answer unblocks it.

2. **Reliable autonomous execution on a UI the agent has not seen.** Generated Playwright specs guess selectors blind; a free-form browsing agent is slow and can talk itself into a verdict.
   - Hybrid: a bounded tool loop (max ~25 steps) over a thin Playwright layer of about eight tools: `navigate`, `snapshot` (ARIA tree), `click`, `fill`, `select`, `api_request`, `check`, `finish`.
   - `check(assertionId, locator | jsonPath)` reads the actual value and compares it in code against the pre-committed expectation. The model cannot change the expectation or declare a pass.
   - The verdict is computed: all assertions checked and passed → passed; any failed → failed; not all reached → blocked or unverified with the stated reason.

3. **Agent mistake versus application defect.** The agent may bind a check to the wrong element or take a wrong turn.
   - Every tool call is recorded as a structured step. A failing scenario is replayed once without the model; only a reproduced failure becomes a defect, otherwise it is reported as unverified.
   - Each check stores a screenshot with the element highlighted, plus the Playwright trace and API log, so a human can see what was compared.
   - Residual risk: a consistently wrong binding still reproduces. The evidence makes it visible; the eval harness measures how often it happens.

4. **Retest that means something.** Re-running the agent from scratch after a fix cannot separate "fixed" from model variance.
   - On a new commit, recorded steps are replayed deterministically. Fixtures use deterministic per-scenario identities on a fresh database, so recorded values stay valid.
   - If a replay step no longer finds its element, that scenario falls back to the agent loop.
   - The previous `run.json` is restored through `actions/cache` keyed by PR number.

5. **Proving it is not scripted.** See the last section; the eval harness and held-out ticket are part of the build, not an afterthought.

Lower risks, handled with simple rules: Jira descriptions arrive as ADF and need flattening; ticket and PR text are treated as data and the browser is restricted to the manifest's base URL; secrets are redacted from logs and never placed in prompts; the run has a hard token and time budget (target under 10 minutes, 3 scenarios in parallel).

## Architecture

One monorepo, one process, no server.

```
GitHub PR event
  └─ workflow: checkout PR head → build + start shop (SQLite, TEST_MODE) → run agent CLI
       1 ingest    Jira ticket (key from PR title/branch) + comments; PR diff + changed files
       2 analyse   requirements (documented | inferred, each with a quoted source) + ambiguities
       3 probe     manifest + /api/version SHA == PR head SHA, login works, fixtures respond
       4 plan      scenarios → requirement ids, fixtures, pre-committed assertions, runnable | blocked
       5 execute   per scenario: create fixtures → tool loop → computed verdict → evidence
       6 confirm   replay failures without the model
       7 report    run.json, HTML report + traces (artifact), PR comment, Check run, Jira questions
```

- **LLM**: Anthropic TypeScript SDK, plain tool-use loop and structured outputs validated with zod. A stronger model for analysis and planning (two calls per run), a faster one for the execution loops. No agent framework.
- **Steps 1–4 and 7 are single structured calls or plain code.** Only step 5 is an agent loop.

### Data model (zod, all stored in `run.json`)

- `Requirement` — id, text, kind `documented | inferred`, source `{type, ref, quote}`
- `Ambiguity` — id, question, why it matters, blocked scenario ids
- `Scenario` — id, title, basis `requirement | risk | exploratory`, requirement ids, layer `ui | api`, fixtures, intent, assertions, required capabilities, plan status
- `Assertion` — id, description, kind, expected `literal | formula`, requirement id
- `EnvironmentReport` — base URL, deployed SHA, PR head SHA, match flag, capability results
- `ScenarioResult` — verdict `passed | failed | blocked | unverified`, per-assertion expected/actual/evidence, recorded steps, reproduced flag, reason
- `Defect` — scenario and requirement ids, expected, actual, reproduction steps taken from the recorded steps, evidence
- `Run` — PR, head SHA, Jira key, all of the above, summary, token usage

### Repository layout

```
apps/shop/                 Next.js demo store: catalogue, cart, checkout, account, fake payment,
                           webhook endpoint, /api/version, /api/test/* fixtures (TEST_MODE only)
packages/agent/src/
  cli.ts                   releaseproof run --pr <n>
  schema.ts  llm.ts
  ingest/{jira,github}.ts
  analyse.ts  plan.ts  env.ts
  execute/{tools,loop,verdict,replay}.ts
  report/{markdown,html,github}.ts
eval/                      repeated-run harness and scoring
releaseproof.yml           environment manifest
.github/workflows/releaseproof.yml
```

## Four-week plan

| Week | Outcome | Exit test |
|---|---|---|
| **1** · 30 Nov–6 Dec | Executor first, because it is the highest risk. Minimal shop with loyalty on a feature branch, fixture endpoints, tool layer, agent loop, computed verdicts, traces. Scenario is hand-written JSON. | The same scenario passes on a clean branch and fails on a branch with a seeded bug, correctly in at least 9 of 10 runs. |
| **2** · 7–13 Dec | Requirements to plan: Jira and GitHub ingestion, analysis, ambiguities, scenario generation, manifest and probe, CLI end to end locally. | `releaseproof run --pr N` from a real Jira ticket finds at least one seeded defect and raises at least one real ambiguity, with no hand-written scenario. |
| **3** · 14–20 Dec | GitHub Actions, PR comment and Check, HTML report, Jira questions, failure confirmation, retest by replay. | On a real PR: open → findings posted → push fix → retest shows the defect resolved. |
| **4** · 21–31 Dec | Eval harness, held-out second ticket, tuning, budgets, redaction, recorded demo. Feature freeze 24 Dec. Axe and mobile viewport only if time remains. | Metrics table produced from repeated runs; held-out ticket runs without agent code changes. |

**First vertical slice (week 1):** one hand-written scenario, "second order earns no welcome points", executed autonomously against the local shop with a code-computed verdict and a Playwright trace. If this is not reliable, nothing above it matters; requirements analysis is the part current models already do well.

**Seeded defects** (kept out of the repo so the agent cannot read them): welcome points granted on every order; cart potential points not updating after a quantity change; loyalty transaction saved without its order id (API-level); duplicate payment webhook credits twice (inferred rule, so reported as a risk finding, not a requirement failure).

## Proving autonomy

- **Held-out ticket**: a second feature (for example a discount code) never used during development, run with zero agent changes.
- **Ticket mutation**: change "100 points" to "150" in Jira; the plan and expected values change with no code edit.
- **Unknown defect**: someone else injects a bug the agent author has not seen.
- **No domain knowledge in the agent**: a CI check fails if `packages/agent/src` contains words such as "loyalty" or "cart".
- **Measured, not asserted**: `eval/` runs each defect branch and the clean branch N times and reports detection rate, false-positive rate, requirement coverage, run time and human interventions.
- **Full decision log**: every tool call, check and trace is in the report.

## On approval: what I build first

1. Commit this design as `docs/ARCHITECTURE.md` on `claude/beautiful-hypatia-oaqsrr`.
2. Scaffold the workspace, `apps/shop` (minimal store with fixtures and `/api/version`) and `packages/agent` with `schema.ts`, `execute/tools.ts`, `execute/loop.ts`, `execute/verdict.ts`.
3. Deliver the week-1 slice.

## Verification

- Unit tests for `verdict.ts` and the formula evaluator (no model involved).
- Start the shop locally, run the hand-written scenario against the clean and the seeded-bug build, and confirm the verdict flips and a trace, screenshots and `run.json` are produced.
- Repeat 10 times and record the correct-verdict count.
- Running the agent loop here needs an Anthropic API key for this environment; without it I can verify the shop, the tool layer and the verdict code, and will say plainly that the loop itself is unrun.
