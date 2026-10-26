# Anchored envelopes, as served on 26 Oct 2026

Exact canonical bytes of the signed `VerificationEnvelope`s referenced from the README, saved here so they
outlive the demo server. Each file name is the sha256 of its bytes, which is what the anchor lines carry.

| File | What |
|---|---|
| `839df0a1…` | Lendoor, on-chain escrow `CDGQRKMQ…U6WJ7W`: ALLOW 95, anchored, approved and released |
| `0c9aa005…` | Lendoor, escrow `CCX5JWHY…AV76UFJ`: DENY · DESTINATION_MISMATCH, anchored, refunded by the resolver |
| `27eb6eba…` | demo milestone `demo/1`, real invoice photo: ALLOW 93 |
| `c2aeeed6…` | demo milestone `demo/1`, supermarket receipt: DENY · MERCHANT_MISMATCH, ITEMS_MISMATCH |

Verify any of them offline (hash of the canonical bytes, ed25519 signature against the verifier address):

```bash
node packages/semantic/src/verify-cli.ts docs/evidence/839df0a154d7056b76c61a4eade55915237d85d0e4c1e4558672b6407cc3b7f5.json
```

The evidence bytes the first two name are `examples/lendoor/factura-ok.jpg` (`69d9b7f0…`) and
`examples/lendoor/factura-mal.jpg` (`5b15f329…`).
