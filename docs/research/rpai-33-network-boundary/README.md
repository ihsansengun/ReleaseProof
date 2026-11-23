# Research: an engine-owned network boundary for trusted checks (RPAI-33)

Research only. **Nothing here is used by the engine, by any run, or by CI**, and nothing here changes what a
run reports. Trusted verdicts remain disabled. The scripts are isolated experiments kept so that the results
can be repeated and challenged.

- [STAGE0-REPORT.md](STAGE0-REPORT.md): can the engine hold navigations and see every request? (plain `http`)
- [HTTPS-REPORT.md](HTTPS-REPORT.md): does the same hold for HTTPS, can traffic bypass it, and the proposed
  final architecture.

## Running the experiments

From this directory, with the repository's dependencies installed (`npm ci` at the root):

```
npx tsx stage0/e2-coverage.mts          # and the other stage0/e*.mts
sh https/make-certs.sh                  # throwaway certificates into https/certs (not committed)
npx tsx https/h1-basic.mts              # and the other https/h*.mts
```

`stage0/e5-shop.mts`, `stage0/e4-listeners.mts` and `https/h3-shop.mts` need the synthetic shop running:
`cd apps/shop && npm run build && TEST_MODE=1 GIT_SHA=spike npx next start -p 4311`.
`https/h5-netns.mts` needs Linux and the right to create a network namespace (`unshare -n`).

No credential is stored here. The certificates and keys are generated locally, valid for two days, and trusted
by nothing but the experiment's own browser. The card number in the shop scripts is the synthetic shop's
published test number.
