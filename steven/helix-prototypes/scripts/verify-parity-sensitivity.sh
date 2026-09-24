#!/usr/bin/env bash
# Parity kit sensitivity self-test (UI step 0). Proves the kit is not blind:
# a clean run must pass, and each known token break (injected into OUR side
# only, never committed) must fail the run on the screens listed in
# frontend/tests/parity/sensitivity.mjs. Same env as scripts/verify-parity.sh.
set -euo pipefail
HELIX_PARITY_SENSITIVITY=1 exec "$(cd "$(dirname "$0")" && pwd)/verify-parity.sh"
