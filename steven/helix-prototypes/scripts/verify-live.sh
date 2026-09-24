#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Ports are overridable so parallel lanes do not collide (docs/ui-lanes-ownership.md).
API_PORT="${HELIX_LIVE_API_PORT:-8010}"
WEB_PORT="${HELIX_LIVE_WEB_PORT:-3010}"
DIST="${HELIX_LIVE_DIST_DIR:-.next-e2e}"
DB="$(mktemp -t helix-e2e.XXXXXX).db"
API_LOG="$(mktemp -t helix-api.XXXXXX).log"
WEB_LOG="$(mktemp -t helix-web.XXXXXX).log"
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
}
trap cleanup EXIT

cd "$ROOT/backend"
HELIX_DATABASE_URL="sqlite+pysqlite:///$DB" \
HELIX_SEED_PATH="$ROOT/synthetic-e2e/helix-synthetic-bundle.json" \
HELIX_CORS_ORIGINS="[\"http://127.0.0.1:$WEB_PORT\"]" \
uv run uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" >"$API_LOG" 2>&1 &
API_PID=$!

cd "$ROOT/frontend"
if ! NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT/api/v1" \
  NEXT_DIST_DIR="$DIST" \
  npx next build >"$WEB_LOG" 2>&1; then
  cat "$WEB_LOG"
  exit 1
fi
NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT/api/v1" \
NEXT_DIST_DIR="$DIST" \
npx next start --hostname 127.0.0.1 --port "$WEB_PORT" >>"$WEB_LOG" 2>&1 &
WEB_PID=$!

ready=false
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:$API_PORT/health >/dev/null && curl -sf http://127.0.0.1:$WEB_PORT >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  cat "$API_LOG"
  cat "$WEB_LOG"
  exit 1
fi

if ! HELIX_WEB_URL="http://127.0.0.1:$WEB_PORT" \
  HELIX_API_URL="http://127.0.0.1:$API_PORT/api/v1" \
  npm run test:e2e; then
  cat "$API_LOG"
  cat "$WEB_LOG"
  exit 1
fi

curl -sf http://127.0.0.1:$API_PORT/health
