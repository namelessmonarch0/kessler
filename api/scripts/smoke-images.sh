#!/usr/bin/env bash
# Builds both Lambda images and checks them against the local compose database.
# Needs: docker, `docker compose up -d db` in api/, ports 8080 free.
set -euo pipefail
cd "$(dirname "$0")/.."
DB_URL="${DATABASE_URL:-postgresql://leo:leo@localhost:5432/leo}"
RIE_DIR="${RIE_DIR:-$(mktemp -d)}"
RIE_VERSION=1.24

build() {
  docker buildx build --platform linux/amd64 --provenance=false --load \
    --target "$1" -t "leo-local:$1" .
}
build api
build jobs

# 1. jobs image under the Lambda Runtime Interface Emulator: run migrations.
if [ ! -x "$RIE_DIR/aws-lambda-rie" ]; then
  curl -fsSL -o "$RIE_DIR/aws-lambda-rie" \
    "https://github.com/aws/aws-lambda-runtime-interface-emulator/releases/download/v${RIE_VERSION}/aws-lambda-rie-x86_64"
  chmod +x "$RIE_DIR/aws-lambda-rie"
fi
cid=$(docker run -d --rm --network host -v "$RIE_DIR:/rie:ro" -e DATABASE_URL="$DB_URL" \
  --entrypoint /rie/aws-lambda-rie leo-local:jobs python -m awslambdaric app.lambda_jobs.handler)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 30); do curl -s localhost:8080 >/dev/null 2>&1 && break; sleep 0.5; done
out=$(curl -fsS -XPOST localhost:8080/2015-03-31/functions/function/invocations -d '{"job":"migrate"}')
echo "jobs migrate -> $out"
echo "$out" | grep -q '"migrate"' || { echo "FAIL: migrate did not return a revision"; exit 1; }
bad=$(curl -sS -XPOST localhost:8080/2015-03-31/functions/function/invocations -d '{"job":"nope"}')
echo "$bad" | grep -q "expected one of" || { echo "FAIL: bad job not rejected: $bad"; exit 1; }
docker rm -f "$cid" >/dev/null

# 2. api image as a plain web server (the adapter extension only activates inside Lambda).
cid=$(docker run -d --rm --network host -e DATABASE_URL="$DB_URL" -e SNAPSHOT_DIR=/tmp/snaps \
  leo-local:api)
for _ in $(seq 30); do curl -s localhost:8080/api/health >/dev/null 2>&1 && break; sleep 0.5; done
health=$(curl -fsS localhost:8080/api/health)
echo "api health -> $health"
echo "$health" | grep -q '"status":"ok"' || { echo "FAIL: health"; exit 1; }
docker run --rm --entrypoint sh leo-local:api -c 'test -x /opt/extensions/lambda-adapter' \
  || { echo "FAIL: Lambda Web Adapter extension missing"; exit 1; }
echo "OK: both images pass"
