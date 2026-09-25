#!/usr/bin/env bash
# DH-8: qualified copy (flag off), head vs base: ready-for-export and exported DOM facts + screenshots.
E=/Users/perk/src/Helix-dh8/steven/helix-prototypes/evidence/dh-8-79
cd /Users/perk/src/Helix-dh8/steven/helix-prototypes/frontend
for tree in Helix-dh8:head Helix-dh7-base:base; do
  T=${tree%%:*}; L=${tree##*:}
  HELIX_TREE=$T /tmp/helix-dh8-dev.sh 0 /tmp/helix-dh8-qualified/helix > /dev/null 2>&1 &
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:19434/health >/dev/null && curl -sf -o /dev/null http://127.0.0.1:19435/ && break; sleep 2; done
  python3 /tmp/helix-dh8-drive.py http://127.0.0.1:19434 > $E/qualified-$L-drive-ready.json
  node /tmp/helix-dh8-shot.cjs $E/qualified-$L-ready-1440 1440 > $E/qualified-$L-ready-1440.json
  curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{"actor":"Dr. Sam Director","idempotency_key":"dh8-qual-export"}' http://127.0.0.1:19434/api/v1/studies/STUDY-HLX-028/exports > $E/qualified-$L-export-status.txt
  node /tmp/helix-dh8-shot.cjs $E/qualified-$L-exported-1440 1440 > $E/qualified-$L-exported-1440.json
  for p in 19434 19435; do pid=$(/usr/sbin/lsof -tiTCP:$p -sTCP:LISTEN); [ -n "$pid" ] && kill $pid; done; sleep 3
done
echo QUAL-DONE
