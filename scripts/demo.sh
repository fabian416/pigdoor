#!/usr/bin/env bash
# The two flows from the deck, end to end, offline. Leaves the signed envelopes
# in ./out and re-verifies every one of them as a third party would.
#   Lendoor: underwriting verdict -> good invoice releases -> wrong shop is denied
#   Piggy:   bed made releases -> bed not made is denied
# Set LIVE_PHOTO_LENDOOR / LIVE_PHOTO_PIGGY to run those happy paths against the model.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out

CLI=packages/semantic/src/cli.ts
VERIFY=packages/semantic/src/verify-cli.ts

run_cli() {
  node "$CLI" --agreement "${AGREEMENT:-pending}" ${VERIFIER_SECRET:+--verifier-secret "$VERIFIER_SECRET"} "$@"
}

echo "== Lendoor 1/3 · underwriting (score + policy, signed for the funder)"
run_cli --condition examples/lendoor/condition.json --underwriting examples/lendoor/underwriting.json > out/lendoor-underwriting.json

echo; echo "== Lendoor 2/3 · Ana's invoice from Casa Hogar Electro"
if [[ -n "${LIVE_PHOTO_LENDOOR:-}" ]]; then
  run_cli --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json --evidence examples/lendoor/evidence.json --photo "$LIVE_PHOTO_LENDOOR" --fx "${FX:-ARS=1450}" > out/lendoor-allow.json
else
  run_cli --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json --evidence examples/lendoor/evidence.json --reading examples/lendoor/reading-good.json --fx "${FX:-ARS=1450}" > out/lendoor-allow.json
fi

echo; echo "== Lendoor 3/3 · a supermarket ticket instead"
run_cli --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json --evidence examples/lendoor/evidence.json --reading examples/lendoor/reading-wrong-shop.json --fx "${FX:-ARS=1450}" > out/lendoor-deny.json || true

echo; echo "== Piggy 1/2 · Sasha made the bed"
if [[ -n "${LIVE_PHOTO_PIGGY:-}" ]]; then
  run_cli --condition examples/piggy/condition.json --facts examples/piggy/facts.json --evidence examples/piggy/evidence.json --photo "$LIVE_PHOTO_PIGGY" > out/piggy-allow.json
else
  run_cli --condition examples/piggy/condition.json --facts examples/piggy/facts.json --evidence examples/piggy/evidence.json --reading examples/piggy/reading-done.json > out/piggy-allow.json
fi

echo; echo "== Piggy 2/2 · the bed is not made"
run_cli --condition examples/piggy/condition.json --facts examples/piggy/facts.json --evidence examples/piggy/evidence.json --reading examples/piggy/reading-not-done.json > out/piggy-deny.json || true

echo; echo "== anyone re-verifies the five envelopes"
for f in out/lendoor-underwriting.json out/lendoor-allow.json out/lendoor-deny.json out/piggy-allow.json out/piggy-deny.json; do
  echo "-- $f"; node "$VERIFY" "$f" | head -1
done
echo; echo "envelopes in ./out"
