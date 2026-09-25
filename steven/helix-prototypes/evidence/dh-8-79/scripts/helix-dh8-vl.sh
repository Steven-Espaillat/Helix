#!/usr/bin/env bash
# DH-8: verify-live head vs base, sequential on ports 19444/19445.
export PATH="$HOME/.local/bin:$PATH:/usr/sbin:/sbin"
E=/Users/perk/src/Helix-dh8/steven/helix-prototypes/evidence/dh-8-79
run() { # tree label flag [qroot]
  cd /Users/perk/src/$1/steven/helix-prototypes || exit 1
  echo "== $(date '+%H:%M:%S') $1 $2" >> $E/verify-live-progress.log
  env ${4:+HELIX_CODEX_REPOSITORY_ROOT=$4} HELIX_DEMO_UNQUALIFIED_PACKAGES=$3 HELIX_LIVE_API_PORT=19444 HELIX_LIVE_WEB_PORT=19445 ./scripts/verify-live.sh > $E/verify-live-$2.log 2>&1
  echo "exit=$?" >> $E/verify-live-$2.log
}
for spec in "$@"; do set -- $spec; run "$@"; done
echo "== $(date '+%H:%M:%S') done" >> $E/verify-live-progress.log
