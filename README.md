# ReleaseProof AI

An autonomous QA agent: it reads a requirement, plans test scenarios, runs them
in a real browser and reports what it did and did not verify.

Design, scope decisions and the four-week plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Product brief: [project_instructions.md](project_instructions.md).

## What exists today (week-1 slice)

- `apps/shop` — the demo store under test (Next.js, SQLite), with test fixtures
  behind `TEST_MODE=1` and its commit exposed at `/api/version`.
- `packages/agent` — the scenario executor: a bounded tool loop over Playwright,
  assertions compared in code against expectations fixed in the plan, a
  verdict computed from those comparisons, and deterministic replay of
  recorded steps.
- `eval/` — a hand-written scenario, the ticket it traces to, and a recorded
  step list for it.

Not built yet: Jira and GitHub ingestion, requirement analysis, scenario
generation, GitHub Actions, reporting. See the plan for the order.

## Run it

```bash
npm install
npm run shop:build
TEST_MODE=1 GIT_SHA=$(git rev-parse HEAD) npm run shop:start
```

In a second terminal:

```bash
# Deterministic: replay recorded steps, no model needed
npx tsx packages/agent/src/cli.ts replay eval/scenarios/SC-001-second-order.json \
  --steps eval/steps/SC-001.steps.json

# Autonomous: the agent drives the browser itself (needs ANTHROPIC_API_KEY)
npx tsx packages/agent/src/cli.ts run-scenario eval/scenarios/SC-001-second-order.json --confirm
```

Each run writes `result.json`, a Playwright `trace.zip` and one screenshot per
check under `runs/`. Exit code is 0 only for a `passed` verdict.

```bash
npm test          # verdict and formula unit tests
npm run typecheck
```
