#!/usr/bin/env bash
# Visual parity kit runner (UI step 0). See frontend/tests/parity/README.md.
#
# Two modes:
#   1. Your own servers are already running (lane workers):
#        HELIX_PARITY_BASE_URL=http://127.0.0.1:3031 ./scripts/verify-parity.sh
#      The web server must run with HELIX_PARITY_FIXTURES=1 for the component
#      fixture screens (/parity), and its API must be a fresh synthetic seed for
#      the shell screens (release pill "Release blocked").
#   2. Nothing running: the script starts a throwaway SQLite backend and a
#      production Next build on HELIX_PARITY_API_PORT / HELIX_PARITY_WEB_PORT
#      (defaults 8020 / 3020), runs the kit, and tears everything down.
#
# Other env: HELIX_PARITY_ONLY=id1,id2   HELIX_PARITY_INCLUDE_PENDING=1
#            HELIX_PARITY_OUT=<dir relative to frontend> (default parity-out, gitignored)
#            HELIX_PARITY_SENSITIVITY=1 runs the sensitivity self-test instead
#            (scripts/verify-parity-sensitivity.sh; tests/parity/sensitivity.mjs).
# Exit code is non-zero when an "enforced" screen exceeds its diff threshold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_kit() {
  if [[ "${HELIX_PARITY_SENSITIVITY:-}" == "1" ]]; then
    node tests/parity/sensitivity.mjs
  else
    npm run test:parity
  fi
}

if [[ -n "${HELIX_PARITY_BASE_URL:-}" ]]; then
  cd "$ROOT/frontend"
  run_kit
  exit $?
fi

API_PORT="${HELIX_PARITY_API_PORT:-8020}"
WEB_PORT="${HELIX_PARITY_WEB_PORT:-3020}"
for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Set HELIX_PARITY_API_PORT/HELIX_PARITY_WEB_PORT or HELIX_PARITY_BASE_URL." >&2
    exit 2
  fi
done

DB="$(mktemp -t helix-parity.XXXXXX).db"
API_LOG="$(mktemp -t helix-parity-api.XXXXXX).log"
WEB_LOG="$(mktemp -t helix-parity-web.XXXXXX).log"
DIST=".next-parity"
# next build rewrites next-env.d.ts to point at the dist dir; restore it after.
NEXT_ENV_BACKUP="$(mktemp -t helix-parity-next-env.XXXXXX)"
cp "$ROOT/frontend/next-env.d.ts" "$NEXT_ENV_BACKUP"
API_PID=""
WEB_PID=""

cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    pkill -P "$WEB_PID" 2>/dev/null || true
    kill "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "$API_PID" ]]; then
    pkill -P "$API_PID" 2>/dev/null || true
    kill "$API_PID" 2>/dev/null || true
  fi
  rm -f "$DB" "$API_LOG" "$WEB_LOG"
  rm -rf "$ROOT/frontend/$DIST"
  cp "$NEXT_ENV_BACKUP" "$ROOT/frontend/next-env.d.ts" && rm -f "$NEXT_ENV_BACKUP"
}
trap cleanup EXIT

cd "$ROOT/backend"
HELIX_DATABASE_URL="sqlite+pysqlite:///$DB" \
HELIX_SEED_PATH="$ROOT/synthetic-e2e/helix-synthetic-bundle.json" \
HELIX_CORS_ORIGINS="[\"http://127.0.0.1:$WEB_PORT\"]" \
uv run uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" >"$API_LOG" 2>&1 &
API_PID=$!

cd "$ROOT/frontend"
if ! NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT/api/v1" NEXT_DIST_DIR="$DIST" \
  npx next build >"$WEB_LOG" 2>&1; then
  cat "$WEB_LOG"
  exit 1
fi
HELIX_PARITY_FIXTURES=1 NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT/api/v1" NEXT_DIST_DIR="$DIST" \
  npx next start --hostname 127.0.0.1 --port "$WEB_PORT" >>"$WEB_LOG" 2>&1 &
WEB_PID=$!

ready=false
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null && curl -sf "http://127.0.0.1:$WEB_PORT" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  cat "$API_LOG" "$WEB_LOG"
  exit 1
fi

export HELIX_PARITY_BASE_URL="http://127.0.0.1:$WEB_PORT"
run_kit
