#!/usr/bin/env bash
# DH-8 dev servers: API 19434, web 19435, DB /tmp/${HELIX_DB:-helix-dh8.db} (fresh). Flag from $1 (0|1).
FLAG="${1:-0}"
QROOT="${2:-}"
export PATH="$HOME/.local/bin:$PATH"
for p in 19434 19435; do pid=$(/usr/sbin/lsof -tiTCP:$p -sTCP:LISTEN); [ -n "$pid" ] && kill $pid; done; sleep 1
[ "${KEEP_DB:-0}" = 1 ] || rm -f /tmp/${HELIX_DB:-helix-dh8.db}
ROOT=/Users/perk/src/${HELIX_TREE:-Helix-dh8}/steven/helix-prototypes
cd "$ROOT/backend"
env ${QROOT:+HELIX_CODEX_REPOSITORY_ROOT=$QROOT} HELIX_DEMO_UNQUALIFIED_PACKAGES=$FLAG HELIX_DATABASE_URL=sqlite+pysqlite:////tmp/${HELIX_DB:-helix-dh8.db} HELIX_SEED_PATH=../synthetic-e2e/helix-synthetic-bundle.json HELIX_CORS_ORIGINS='["http://127.0.0.1:19435"]' uv run uvicorn app.main:app --host 127.0.0.1 --port 19434 > /tmp/helix-dh8-api.log 2>&1 &
cd "$ROOT/frontend"
NEXT_DIST_DIR=.next-dh8-dev HELIX_DEMO_UNQUALIFIED_PACKAGES=$FLAG NEXT_PUBLIC_API_URL=http://127.0.0.1:19434/api/v1 npx next dev --hostname 127.0.0.1 --port 19435 > /tmp/helix-dh8-web.log 2>&1 &
wait
