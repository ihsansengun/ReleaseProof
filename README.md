# ReleaseProof AI

An autonomous QA agent: it reads a requirement, plans test scenarios, runs them
in a real browser and reports what it did and did not verify.

Design, scope decisions and the four-week plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Product brief: [project_instructions.md](project_instructions.md).

## What exists today

- `packages/agent` — the engine. Generic browser and API tools over
  Playwright, assertions compared in code against expectations fixed in the
  plan, a verdict computed from those comparisons, recording and replay, and
  an HTTP bridge for attaching a model from outside the process. It contains
  no knowledge of any application; a test enforces that.
- `apps/shop` — demonstration app A (retail; Next.js, server-rendered, SQLite).
- `apps/timeoff` — demonstration app B (time-off requests; plain Node, JSON
  API, rendered in the browser).
- Each app has its own `releaseproof.yml` manifest.
- `eval/` — tickets, scenarios, recorded steps, the
  [results of the first model-driven runs](eval/results/2026-11-17/README.md)
  and the [intervention log](eval/INTERVENTIONS.md).

Not built yet: Jira and GitHub ingestion, discovery, requirement analysis,
scenario generation, GitHub Actions, PR reporting. See the plan for the order.

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
  --manifest apps/shop/releaseproof.yml \
  --steps eval/steps/SC-001.steps.json

# Autonomous: the agent drives the browser itself (needs ANTHROPIC_API_KEY)
npx tsx packages/agent/src/cli.ts run-scenario eval/scenarios/SC-001-second-order.json \
  --manifest apps/shop/releaseproof.yml --confirm
```

To attach a model over HTTP instead (any client that can read
`GET /briefing` and `POST /tool`):

```bash
npx tsx packages/agent/src/cli.ts serve-scenario eval/scenarios/SC-001-second-order.json \
  --manifest apps/shop/releaseproof.yml
```

App B starts with `TEST_MODE=1 npm start -w apps/timeoff` (port 3100) and uses
`eval/scenarios/SC-101-decisions.json` with `--manifest apps/timeoff/releaseproof.yml`.

Each run writes `result.json`, `report.md`, a Playwright `trace.zip` and one screenshot per
check under `runs/`. Exit code is 0 only for a `passed` verdict.

```bash
npm test          # verdict and formula unit tests
npm run typecheck
```
