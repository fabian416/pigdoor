#!/usr/bin/env bash
# Runs the happy path and the rejection path end to end, offline, and leaves the
# two signed envelopes plus their anchor references in ./out. Pass a photo as
# $1 to run the happy path against the live model instead of the sample reading.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out

CLI=packages/semantic/src/cli.ts
VERIFY=packages/semantic/src/verify-cli.ts
# macOS ships bash 3.2, where an empty array trips `set -u`; keep optional flags in a function.
run_cli() {
  node "$CLI" --condition examples/condition.json --facts examples/facts.json --evidence examples/evidence.json \
    --agreement "${AGREEMENT:-pending}" --milestone 1 \
    ${VERIFIER_SECRET:+--verifier-secret "$VERIFIER_SECRET"} "$@"
}

echo "== 1. happy path"
if [[ -n "${1:-}" ]]; then
  run_cli --photo "$1" ${FX:+--fx "$FX"} > out/envelope-allow.json
else
  run_cli --reading examples/reading-good.json > out/envelope-allow.json
fi

echo
echo "== 2. rejection path (receipt from another shop)"
run_cli --reading examples/reading-wrong-shop.json > out/envelope-deny.json || true

echo
echo "== 3. anyone re-verifies both envelopes"
node "$VERIFY" out/envelope-allow.json
echo
node "$VERIFY" out/envelope-deny.json

echo
echo "envelopes in ./out; the 'anchor' line is the sha256 to write into the escrow milestone."
