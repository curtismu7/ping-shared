#!/usr/bin/env bash
# Real-container check of the minimal PingGateway: runs the compose service (with test/compose.e2e.yml) against a fake
# issuer and backend, and drives the token cases from inside the test network. Needs Docker; nothing is published
# on the host and every container/network it makes is named psgw-e2e-* and removed at the end.
#   bash test/e2e-gateway.sh        (run it on the Air: air-test . -- 'bash test/e2e-gateway.sh')
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=psgwe2e
NET=psgw-e2e-net
ISSUER_C=psgw-e2e-issuer
OPEN_C=psgw-e2e-open
DIR="$PWD"
IG=us-docker.pkg.dev/forgeops-public/images-base/ig@sha256:5deece1455a791e31cf04d8cf663360d079921ac38980402580ecfd9929d11bc
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f test/compose.e2e.yml --profile pinggateway)

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$ISSUER_C" "$OPEN_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
[ -n "${KEEP:-}" ] || trap cleanup EXIT
cleanup

# 1. fake issuer + backend, on the network compose will create
docker network create "$NET" >/dev/null
docker run -d --name "$ISSUER_C" --network "$NET" -v "$DIR/test:/t:ro" -e PORT=9000 -e FAKE_ISSUER="http://$ISSUER_C:9000" \
  node:26-alpine node /t/fake-issuer.mjs >/dev/null

# 2. the compose gateway service, configured for the fake issuer
GATEWAY_ISSUER="http://$ISSUER_C:9000" GATEWAY_AUDIENCE="https://mcp.example/" GATEWAY_REQUIRED_SCOPE="mcp:invoke" \
GATEWAY_BACKEND_URL="http://$ISSUER_C:9000" "${COMPOSE[@]}" up -d pinggateway

# 3. a second gateway with NO settings (same image and config), to prove it fails closed
docker run -d --name "$OPEN_C" --network "$NET" --user 11111 -v "$DIR/pinggateway/config:/var/gateway/config:ro" \
  -v "$DIR/pinggateway/scripts/groovy:/var/gateway/scripts/groovy:ro" -e GATEWAY_BACKEND_URL="http://$ISSUER_C:9000" "$IG" >/dev/null

wait_up() { # container
  for _ in $(seq 1 90); do
    if docker exec "$ISSUER_C" node -e "fetch('http://$1:8080/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "gateway $1 did not come up:"; docker logs --tail 40 "$1" 2>&1 || true; return 1
}
wait_up psgw-e2e-gateway
wait_up "$OPEN_C"

docker exec -e GW=http://psgw-e2e-gateway:8080 -e GW_OPEN="http://$OPEN_C:8080" -e ISSUER_BASE="http://$ISSUER_C:9000" \
  "$ISSUER_C" node /t/e2e-cases.mjs || { rc=$?; echo "--- gateway log (last 60 lines) ---"; docker logs --tail 60 psgw-e2e-gateway 2>&1 | cut -c1-300; exit "$rc"; }
