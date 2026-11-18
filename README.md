# ReleaseProof AI

An autonomous QA agent: it reads a requirement, plans test scenarios, runs them
in a real browser and reports what it did and did not verify.

Design, scope decisions and the four-week plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Product brief: [project_instructions.md](project_instructions.md).

## What exists today

- `packages/agent` — the engine and pipeline: ingest a ticket and pull
  request, discover the running app read-only, analyse requirements, plan
  scenarios whose every expected value cites quoted ticket text, execute them
  in a real browser, report, and retest. It contains no knowledge of any
  application; a test enforces that.
- `apps/shop`, `apps/timeoff` — two small demonstration apps in different
  domains and stacks, each with a `releaseproof.yml` manifest.
- `.github/workflows/`, `ci/` — the GitHub Actions adapter; see
  [docs/CI-SECURITY.md](docs/CI-SECURITY.md) for its trust boundaries.
- `eval/` — tickets, results and the intervention log. Start with the
  [held-out evaluation](eval/results/2026-11-18/README.md).

Not built yet: the GitHub Actions workflow, posting reports to pull requests,
posting questions to Jira. The direct model API driver is written but has
not been run.

## Run it

```bash
npm install
npm run shop:build
TEST_MODE=1 GIT_SHA=$(git rev-parse HEAD) npm run shop:start
```

The whole workflow, from a ticket and a pull request (needs `ANTHROPIC_API_KEY`,
or `--driver bridge` to attach a model over HTTP):

```bash
npx tsx packages/agent/src/cli.ts run --ticket eval/tickets/NWG-342.json \
  --repo ihsansengun/ReleaseProof --pr 1 --manifest apps/shop/releaseproof.yml
```

The app must be running the pull request's head commit (`GIT_SHA`), or the run
is refused. Single scenarios, in a second terminal:

```bash
# Deterministic: replay recorded steps, no model needed
npx tsx packages/agent/src/cli.ts replay eval/scenarios/SC-001-second-order.json \
  --manifest apps/shop/releaseproof.yml \
  --steps eval/steps/SC-001.steps.json

# Autonomous: the agent drives the browser itself (needs ANTHROPIC_API_KEY)
npx tsx packages/agent/src/cli.ts run-scenario eval/scenarios/SC-001-second-order.json \
  --manifest apps/shop/releaseproof.yml --confirm
```

App B starts with `TEST_MODE=1 npm start -w apps/timeoff` (port 3100) and uses
`eval/scenarios/SC-101-decisions.json` with `--manifest apps/timeoff/releaseproof.yml`.

Each run writes `result.json`, `report.md`, a Playwright `trace.zip` and one screenshot per
check under `runs/`. Exit code is 0 only for a `passed` verdict.

```bash
npm test          # verdict and formula unit tests
npm run typecheck
```
