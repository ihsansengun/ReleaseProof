#!/usr/bin/env bash
# Reproduces the Kanboard onboarding spike: builds a test image from an
# unmodified Kanboard checkout, starts it with the sandbox's restrictions,
# runs the walk-through and removes everything.
#
# Usage: ./run.sh <path to a Kanboard checkout> [Dockerfile]
#   Dockerfile defaults to Dockerfile.releaseproof (needs the Alpine package
#   mirror); Dockerfile.local uses the upstream image for its PHP runtime.
# Needs: Docker, Node with Playwright and Chromium.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source_dir="${1:?path to a Kanboard checkout}"
dockerfile="${2:-$here/Dockerfile.releaseproof}"
image=kb-spike net=kb-spike-net name=kb-spike

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "commit: $(git -C "$source_dir" rev-parse HEAD)"
docker build -q -f "$dockerfile" -t "$image" "$source_dir"
docker network create --internal "$net" >/dev/null
docker run -d --name "$name" --network "$net" \
  --read-only \
  --tmpfs /tmp:rw,size=64m,mode=1777 \
  --tmpfs /data:rw,size=64m,uid=10001,gid=10001,mode=0700 \
  --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 \
  --pids-limit 256 --memory 512m --cpus 1 \
  -e DATA_DIR=/data -e LOG_DRIVER=stderr \
  "$image" >/dev/null

ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
base="http://$ip:8080"
for _ in $(seq 1 30); do
  curl -s --noproxy '*' -m 1 -o /dev/null "$base/healthcheck.php" && break
  sleep 0.3
done
echo "health: $(curl -s --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' "$base/healthcheck.php")"

node "$here/browse.cjs" "$base"

echo "--- from inside the container"
docker exec "$name" sh -c '
  id
  touch /app/x 2>&1 || true
  touch /x 2>&1 || true
  wget -q -T 3 -O- http://example.com 2>&1 | head -1 || true
  echo "environment: $(env | cut -d= -f1 | tr "\n" " ")"'
