# Conditional release, verified by content

> Working name pending. Built at [HackMeridian 2026](https://www.hackmeridian.com/build), Lisbon, 25–26 October.

Money locked in a Stellar escrow is released only when the evidence says what it has to say.
Two verifiers run on every milestone and both must pass:

- **Deterministic**: the milestone pays the committed address, within the committed amount,
  inside the window, and the escrow is funded on-chain. No model, no cost.
- **Semantic**: an AI reads the receipt photo and reports what is written on it; fixed rules
  compare that with the condition. The model never decides and never sees the amount cap.

The result is a signed `VerificationEnvelope` that follows the
[Trustless Work research vocabulary](https://github.com/Trustless-Work/agentic-escrow-research/blob/main/research-notes/verification-and-evidence-envelope-2026-09-21.md),
so their tooling can read ours. Anyone can verify the signature.

## Layout

| Path | What |
|---|---|
| `packages/core` | Condition schema, RFC 8785 canonicalization and hashing, criteria and the decision rule, deterministic verifier, signed envelope, anchoring (verify a verdict from the reference written in the escrow), milestone lifecycle (permissionless refund after the deadline), dispute case. Pure TypeScript, no I/O beyond an injectable fetch. |
| `packages/semantic` | Semantic verifier (Claude with structured outputs), the trigger agent that turns the payer's words into a condition, `cli.ts` (run the whole chain) and `verify-cli.ts` (re-verify an anchored envelope). |
| `services/verifier` | The verifier as its own process with its own key: `POST /agreements/:id/milestones/:m/verify` runs both verifiers, signs the envelope, serves it content-addressed at `GET /envelopes/:sha256` (the anchor target), writes the anchor line into the escrow and releases or escalates. The escrow provider sits behind an interface: in-memory for the demo, Trustless Work V2 to be wired after the integration spike. |
| `scripts/demo.sh` | Happy path, rejection path, independent re-verification. Offline by default; pass a photo to go live. |
| `.github/workflows/ci.yml` | Typecheck, tests and the offline demo on every push. |

## Run the verifier service

```bash
ACCEPT_READINGS=1 pnpm --filter @workspace/verifier-service start   # demo mode: http://localhost:8787, in-memory escrow seeded with examples/facts.json

curl -s localhost:8787/health
curl -s -X POST localhost:8787/agreements/demo/milestones/1/verify -H 'content-type: application/json' \
  -d "$(node -e 'const r=require;console.log(JSON.stringify({condition:r("./examples/condition.json"),evidence:r("./examples/evidence.json"),reading:r("./examples/reading-good.json")}))')"
```

| Env | Meaning | Default |
|---|---|---|
| `VERIFIER_SECRET` | Stellar secret (S...) of the release signer; its public key is what the escrow lists | ephemeral, printed at start |
| `ANTHROPIC_API_KEY` | Credentials for the semantic verifier (or `ant auth login`) | unset → only precomputed readings accepted |
| `PUBLIC_URL` | Base URL used in anchor references | `http://localhost:8787` |
| `AUTO_RELEASE` | `1` to execute releases on ALLOW; otherwise the service only reports the next step | report only |
| `ACCEPT_READINGS` | `1` accepts precomputed document readings instead of photos. Demo only; refused together with `AUTO_RELEASE` because a posted reading could release funds | off |
| `API_TOKEN` | Bearer token the product backend must send on every write; reads (health, anchored envelopes, cases) stay public | unset = open, local dev only |
| `ESCROW` | `memory` or `tw` (Trustless Work V2; needs `TW_API_KEY`, `TW_BASE_URL`) | `memory` |
| `DATA_DIR` | Where envelopes and cases are stored | `./data` |
| `PORT` | Listen port | `8787` |

Why a separate process: if the service that funds the escrow also signed releases, the payer would be releasing to itself. Separate keys make the role split checkable on-chain.
| `docs/contracts.md` | The three JSON objects the backend and the verifier exchange. |
| `examples/` | A demo condition, escrow facts, evidence and two model readings (good receipt, wrong shop). |

## Run

```bash
pnpm install
pnpm test

# whole chain, offline (precomputed reading)
node packages/semantic/src/cli.ts --condition examples/condition.json --facts examples/facts.json \
  --evidence examples/evidence.json --reading examples/reading-good.json

# whole chain, live model on a photo (needs ANTHROPIC_API_KEY or `ant auth login`)
node packages/semantic/src/cli.ts --condition examples/condition.json --facts examples/facts.json \
  --evidence examples/evidence.json --photo remito.jpg --fx ARS=1450
```

## Prior work

Built by people from Lendoor and Piggy. Earlier work by the same team: credit delegation in
[lendoor-stellar](https://github.com/LuchoLeonel/lendoor-stellar) (Soroban) and
[lenclaw](https://github.com/fabian416/lenclaw) (agent credit on Base, March 2026). None of that
code is used here; the "model proposes, rules decide" pattern comes from lenclaw.

## License

Apache-2.0. Commits are signed off (DCO).
