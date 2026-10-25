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
| `scripts/demo.sh` | Happy path, rejection path, independent re-verification. Offline by default; pass a photo to go live. |
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
