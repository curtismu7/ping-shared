#!/bin/bash
# Starts and checks ping-shared's own Ping products. It does the checks docker compose cannot:
# one instance per host (rule 20), the PingFederate licence file, and an explicit terms step.
#
#   scripts/ping-shared.sh up pingfederate    reuse a healthy PingFederate, else start ours (needs the licence file)
#   scripts/ping-shared.sh up pinggateway     start the minimal PingGateway (needs GATEWAY_ISSUER + GATEWAY_AUDIENCE in ./.env)
#   scripts/ping-shared.sh status             probe every product
#   scripts/ping-shared.sh bootstrap [--dry-run]   what the parent repo's bootstrap runs: start what is ready, say plainly what is skipped
#
# Exit codes (up): 0 running (reused or started), 1 failed, 4 skipped: no PingFederate licence file,
#   5 skipped: terms not accepted, 6 skipped: PingGateway not configured.
# Environment: PF_LICENSE_FILE (default ~/.config/demo-kit/pingfederate.lic), PF_ACCEPT_EULA=YES (you accept Ping's terms).
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
LICENSE="${PF_LICENSE_FILE:-$HOME/.config/demo-kit/pingfederate.lic}"
ADMIN_PORT=4731
ENGINE_PORT=4732
GW_PORT="${PINGGATEWAY_HOST_PORT:-7809}"
compose() { (cd "$root" && docker compose "$@"); }
probe() { node "$root/probe.mjs" "$1"; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

docker_ready() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is not installed. Install OrbStack (or Docker Desktop), then run this again." >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo "Docker is not running. Open OrbStack, then run this again." >&2; return 1; }
}

license_missing_help() {
  cat >&2 <<EOF
PingFederate skipped: there is no licence file at
  $LICENSE
PingFederate will not start without one, and this setup never ships or copies a licence.
  1. Get a PingFederate licence from Ping Identity: a Free-edition or evaluation licence
     (see https://devops.pingidentity.com/, or ask your Ping contact).
  2. Save it at the path above (chmod 600). It is mounted read-only into the container.
     One licence serves ONE PingFederate instance: do not reuse a licence another install already uses.
  3. Run: shared/ping-shared/scripts/ping-shared.sh up pingfederate
Meanwhile: the labs' Mock mode needs no PingFederate, or point PING_SHARED_SE_PF_URL at the SE PingFederate.
EOF
}

# A licence is a file, never a directory (Docker invents an empty directory for a missing bind source).
have_license() { [ -f "$LICENSE" ]; }

setting() { # setting <KEY>: the value from the environment, else from ./.env (last wins), never printed by callers
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$root/.env" ]; then v="$(grep -E "^$1=" "$root/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"; fi
  printf '%s' "$v"
}

up_pingfederate() { # up_pingfederate [--non-interactive] [--dry-run]
  local interactive=1 dry=0 a
  for a in "$@"; do case "$a" in --non-interactive) interactive=0 ;; --dry-run) dry=1 ;; esac; done

  if out="$(probe pingfederate 2>&1)"; then echo "$out"; return 0; fi
  have_license || { license_missing_help; return 4; }
  if [ "${PF_ACCEPT_EULA:-}" != "YES" ]; then
    if [ "$interactive" = 1 ] && [ -t 0 ]; then
      echo "PingFederate is licensed by Ping. Read the terms: https://www.pingidentity.com/en/legal.html"
      echo "Typing YES accepts the terms for the PingFederate image and PingFederate's in-product license agreement."
      read -r -p "Accept and start PingFederate? Type YES to continue: " answer
      [ "$answer" = "YES" ] || { echo "Not accepted. PingFederate was not started." >&2; return 5; }
    else
      cat >&2 <<EOF
PingFederate not started: a licence file is present ($LICENSE), but starting PingFederate means
accepting Ping's terms (https://www.pingidentity.com/en/legal.html), and that is your step, never automatic.
  Interactive:      shared/ping-shared/scripts/ping-shared.sh up pingfederate      (asks you to type YES)
  Non-interactive:  PF_ACCEPT_EULA=YES shared/ping-shared/scripts/ping-shared.sh up pingfederate
EOF
      return 5
    fi
  fi
  if [ "$dry" = 1 ]; then echo "would run: docker compose --profile pingfederate up -d pingfederate (licence $LICENSE, ports $ADMIN_PORT/$ENGINE_PORT)"; return 0; fi

  docker_ready || return 1
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx id-jag-kit-pf; then
    echo "A PingFederate container named id-jag-kit-pf already exists but is not healthy. Not creating a second one." >&2
    echo "  Start it:  docker start id-jag-kit-pf   (then wait a minute, and run: scripts/ping-shared.sh status)" >&2
    return 1
  fi
  local p
  for p in "$ADMIN_PORT" "$ENGINE_PORT"; do
    if port_in_use "$p"; then echo "Port $p is taken by something that is not a healthy PingFederate. Free it, then run this again." >&2; return 1; fi
  done

  PF_ACCEPT_EULA=YES compose --profile pingfederate up -d pingfederate > "${TMPDIR:-/tmp}/ping-shared-pingfederate.log" 2>&1 \
    || { echo "docker compose could not start PingFederate (log: ${TMPDIR:-/tmp}/ping-shared-pingfederate.log)" >&2; tail -5 "${TMPDIR:-/tmp}/ping-shared-pingfederate.log" | sed 's/^/  /' >&2; return 1; }
  echo "Started id-jag-kit-pf. Waiting for the admin API (this can take a few minutes)..."
  local i code
  for i in $(seq 1 90); do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$ADMIN_PORT/pf-admin-api/v1/version" 2>/dev/null || true)"
    [ -n "$code" ] && [ "$code" != "000" ] && break
    sleep 2
  done
  # Finish the first-run steps with the installer the family already has (accepts the in-product agreement only
  # because you said YES, saves the admin login to ~/.config/demo-kit/provisioning.json). Absent: say what is left.
  local setup="$root/../../scripts/pingfederate-setup.sh"
  if [ -f "$setup" ]; then
    PF_ACCEPT_EULA=YES bash "$setup" || return 1
  else
    echo "PingFederate is starting. Open https://127.0.0.1:$ADMIN_PORT, sign in as administrator and accept the license agreement."
  fi
  echo "PingFederate: admin https://127.0.0.1:$ADMIN_PORT, runtime https://127.0.0.1:$ENGINE_PORT"
  return 0
}

up_pinggateway() { # up_pinggateway [--dry-run]
  local dry=0 a; for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
  if out="$(probe pinggateway 2>&1)"; then echo "$out"; return 0; fi
  if [ -z "$(setting GATEWAY_ISSUER)" ] || [ -z "$(setting GATEWAY_AUDIENCE)" ]; then
    cat >&2 <<EOF
PingGateway not started (optional): the token check needs GATEWAY_ISSUER and GATEWAY_AUDIENCE.
  Copy $root/.env.example to $root/.env and set them (see the README, "PingGateway").
EOF
    return 6
  fi
  if [ "$dry" = 1 ]; then echo "would run: docker compose --profile pinggateway up -d pinggateway (port 127.0.0.1:$GW_PORT)"; return 0; fi
  docker_ready || return 1
  if port_in_use "$GW_PORT"; then echo "Port $GW_PORT is taken. Set PINGGATEWAY_HOST_PORT in $root/.env to another free port." >&2; return 1; fi
  compose --profile pinggateway up -d pinggateway > "${TMPDIR:-/tmp}/ping-shared-pinggateway.log" 2>&1 \
    || { echo "docker compose could not start PingGateway (log: ${TMPDIR:-/tmp}/ping-shared-pinggateway.log)" >&2; tail -5 "${TMPDIR:-/tmp}/ping-shared-pinggateway.log" | sed 's/^/  /' >&2; return 1; }
  local i
  for i in $(seq 1 45); do probe pinggateway >/dev/null 2>&1 && { probe pinggateway; return 0; }; sleep 2; done
  echo "PingGateway started but /health does not answer yet: docker logs ping-shared-pinggateway" >&2
  return 1
}

# What the family setup runs after the always-on services: start what is ready, say plainly what is skipped.
# Output is one "Product: message" block per product. Exit 0 unless something it tried to start failed.
bootstrap() {
  local dry=0 rc=0 r
  [ "${1:-}" = "--dry-run" ] && dry=1
  local flag=(--non-interactive); [ "$dry" = 1 ] && flag+=(--dry-run)

  echo "PingFederate:"
  up_pingfederate "${flag[@]}" 2>&1 | sed 's/^/  /'; r="${PIPESTATUS[0]}"
  case "$r" in 0|4|5) ;; *) rc=1 ;; esac
  echo "PingGateway:"
  up_pinggateway "${flag[@]}" 2>&1 | sed 's/^/  /'; r="${PIPESTATUS[0]}"
  case "$r" in 0|6) ;; *) rc=1 ;; esac
  return "$rc"
}

case "${1:-}" in
  up)
    case "${2:-}" in
      pingfederate) shift 2; up_pingfederate "$@"; exit $? ;;
      pinggateway) shift 2; up_pinggateway "$@"; exit $? ;;
      *) echo "usage: $0 up pingfederate|pinggateway" >&2; exit 2 ;;
    esac ;;
  status) node "$root/probe.mjs" --all ;;
  bootstrap) shift; bootstrap "$@"; exit $? ;;
  *) echo "usage: $0 up pingfederate|pinggateway | status | bootstrap [--dry-run]" >&2; exit 2 ;;
esac
